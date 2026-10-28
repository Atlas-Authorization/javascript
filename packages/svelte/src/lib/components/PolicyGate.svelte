<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    FapiClient,
    PolicyGateController,
    formatPolicyDate,
    injectPolicyStyles,
    joinTitles,
    mountPolicyAcceptStep,
    type MountedPolicyStep,
    type PolicyAcceptanceController,
  } from '@atlasauth/js';
  import { useAtlas } from '../context';
  import { classFor } from '../appearance';
  import { usePolicyUi } from '../policies';
  import { ATLAS_SVELTE_SDK } from '../version';

  /**
   * In-app re-acceptance. For a signed-in user, a banner when a policy needs
   * re-acceptance; "Review and accept" opens the unskippable dialog / checkboxes
   * and posts `/v1/client/me/policies/accept`. Renders its slot always.
   */
  export let onAccepted: (() => void) | undefined = undefined;

  const atlas = useAtlas();
  const status = atlas.status;
  const ui = usePolicyUi();
  const gate = new PolicyGateController(
    new FapiClient({ publishableKey: atlas.publishableKey, baseUrl: atlas.frontendApi, locale: atlas.locale, sdk: ATLAS_SVELTE_SDK }),
    atlas.locale ?? undefined,
  );
  let pending = gate.pending;
  let grace = gate.graceEndsAt;
  let controller: PolicyAcceptanceController | null = null;
  let error = '';
  let step: MountedPolicyStep | null = null;
  const off = gate.subscribe(() => {
    pending = gate.pending;
    grace = gate.graceEndsAt;
  });
  onDestroy(() => {
    off();
    step?.destroy();
  });
  $: if ($status === 'signed_in') void gate.load();

  async function begin() {
    controller = await gate.begin();
  }

  function host(node: HTMLElement, c: PolicyAcceptanceController) {
    injectPolicyStyles(node.ownerDocument);
    step = mountPolicyAcceptStep(node, c, {
      ...ui,
      onSubmit: async () => {
        step?.setBusy(true);
        const res = await gate.accept(c);
        step?.setBusy(false);
        if (!res.ok) {
          error = res.errors[0]?.message ?? ui.t('policy.requiredGeneric');
          return;
        }
        controller = null;
        onAccepted?.();
      },
      onDecline: () => {
        controller = null;
      },
    });
    return {
      destroy() {
        step?.destroy();
        step = null;
      },
    };
  }
</script>

{#if pending.length > 0 && !controller}
  <div class={classFor('alert', atlas.appearance, 'atlas-policy-banner')} role="status" data-atlas-policy-banner="">
    <span>
      <strong>{ui.t('policy.bannerTitle')}. </strong>
      {ui.t('policy.bannerBody', { policies: joinTitles(pending.map((p) => p.title), ui.t('policy.and')) })}
      {#if grace}{' '}{ui.t('policy.bannerGrace', { date: formatPolicyDate(grace) })}{/if}
    </span>
    <button type="button" class={ui.classes.link} on:click={begin}>{ui.t('policy.bannerReview')}</button>
  </div>
{/if}
{#if controller}
  <div class={classFor('card', atlas.appearance, 'atlas-card')} data-atlas-policy-gate="">
    <div use:host={controller} />
    {#if error}<p class={ui.classes.error} role="alert">{error}</p>{/if}
  </div>
{/if}
<slot />

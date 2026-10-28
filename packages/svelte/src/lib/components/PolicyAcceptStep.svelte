<script lang="ts">
  import { onMount } from 'svelte';
  import {
    FapiClient,
    controllerForPending,
    injectPolicyStyles,
    mountPolicyAcceptStep,
    type MountedPolicyStep,
    type Policy,
    type PolicyAcceptanceController,
  } from '@atlasauth/js';
  import { useAtlas } from '../context';
  import { usePolicyUi } from '../policies';
  import { ATLAS_SVELTE_SDK } from '../version';

  /**
   * The sign-in step for a `needs_policy_acceptance` attempt: scroll-mode
   * policies in their unskippable dialog, the rest as checkboxes, then "Accept
   * and continue", which calls `onSubmit` with the `policy_acceptances` JSON for
   * the flow. Declining a policy calls `onDecline` (cancel the attempt).
   */
  export let attempt: { id: string | null; pending_policies?: unknown } | null = null;
  export let busy = false;
  export let onSubmit: (values: Record<string, string>) => void;
  export let onDecline: ((policy: Policy) => void) | undefined = undefined;

  const atlas = useAtlas();
  const ui = usePolicyUi();
  let controller: PolicyAcceptanceController | null = null;
  let step: MountedPolicyStep | null = null;

  function host(node: HTMLElement, c: PolicyAcceptanceController) {
    injectPolicyStyles(node.ownerDocument);
    step = mountPolicyAcceptStep(node, c, {
      ...ui,
      onSubmit: (acceptances) => onSubmit({ policy_acceptances: JSON.stringify(acceptances) }),
      onDecline: (policy) => onDecline?.(policy),
    });
    step.setBusy(busy);
    return {
      destroy() {
        step?.destroy();
        step = null;
      },
    };
  }
  $: step?.setBusy(busy);

  onMount(() => {
    const client = new FapiClient({
      publishableKey: atlas.publishableKey,
      baseUrl: atlas.frontendApi,
      locale: atlas.locale,
      sdk: ATLAS_SVELTE_SDK,
    });
    void controllerForPending(client, attempt, { locale: atlas.locale ?? undefined }).then((c) => {
      controller = c;
    });
  });
</script>

{#if controller}
  <div use:host={controller} />
{:else}
  <p class="atlas-text">{ui.t('policy.loading')}</p>
{/if}

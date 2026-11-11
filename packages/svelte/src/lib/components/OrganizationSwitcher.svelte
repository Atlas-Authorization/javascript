<script lang="ts">
  import { FapiClient, activateOrgOrStepUp, orgStepUpOptions, runOrgStepUp, type OrgStepUpError } from '@atlasauth/js';
  import { useAtlas } from '../context';
  import { getOrganization } from '../accessors';
  import { classFor } from '../appearance';
  import { translate } from '../i18n';
  import { ATLAS_SVELTE_SDK } from '../version';

  /** §10.2 `<OrganizationSwitcher/>` — switch the active organization. */
  const atlas = useAtlas();
  const org = getOrganization();
  const t = (key: string) => translate(atlas.catalog, key);
  const client = new FapiClient({ publishableKey: atlas.publishableKey, baseUrl: atlas.frontendApi, locale: atlas.locale, sdk: ATLAS_SVELTE_SDK });

  $: menuClass = classFor('menu', atlas.appearance, 'atlas-menu');
  $: itemClass = classFor('menuItem', atlas.appearance, 'atlas-menu-item');

  // An org whose policy needs a fresh second factor: show the prompt, step up, retry.
  let pending: { id: string | null; err: OrgStepUpError } | null = null;
  let code = '';
  let error: string | null = null;

  async function activate(id: string | null) {
    const err = await activateOrgOrStepUp($org.setActive, id);
    if (err) pending = { id, err };
  }

  async function confirm(input: { code: string } | { passkey: true }) {
    if (!pending) return;
    error = null;
    const res = await runOrgStepUp(client, input, t('error.generic'));
    if (!res.ok) {
      error = res.message;
      return;
    }
    const { id } = pending;
    pending = null;
    code = '';
    await activate(id);
  }

  $: options = pending ? orgStepUpOptions(pending.err) : null;
</script>

<div class={menuClass}>
  <button class={itemClass} on:click={() => void activate(null)}>
    {t('organization.personal')}
  </button>
  {#each $org.memberships as membership (membership.organization.id)}
    <button
      class={itemClass}
      disabled={membership.organization.id === $org.organization?.id}
      on:click={() => void activate(membership.organization.id)}
    >
      {membership.organization.name}
    </button>
  {/each}
  {#if pending && options}
    <div data-atlas="organization-step-up" role="dialog" aria-label={t('mfa.title')}>
      <p>{t('mfa.subtitle')}</p>
      {#if options.totp}
        <input aria-label={t('mfa.codeLabel')} inputmode="numeric" autocomplete="one-time-code" bind:value={code} />
        <button type="button" on:click={() => void confirm({ code })}>{t('mfa.submit')}</button>
      {/if}
      {#if options.passkey}
        <button type="button" on:click={() => void confirm({ passkey: true })}>{t('mfa.usePasskey')}</button>
      {/if}
      {#if error}<p role="alert">{error}</p>{/if}
      <button type="button" on:click={() => { pending = null; code = ''; error = null; }}>{t('organization.cancel')}</button>
    </div>
  {/if}
</div>

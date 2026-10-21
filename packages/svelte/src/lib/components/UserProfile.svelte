<script lang="ts">
  import { useAtlas } from '../context';
  import { getUser } from '../accessors';
  import { classFor } from '../appearance';
  import { translate } from '../i18n';
  import { FapiClient } from '../fapi';
  import { ATLAS_SVELTE_SDK } from '../version';

  /** §10.2 `<UserProfile/>` — the account-management card. */
  const atlas = useAtlas();
  const user = getUser();
  const t = (key: string) => translate(atlas.catalog, key);

  // An unverified address (added and never confirmed, or the sign-up address on
  // an app that did not require verification) can be proven here: send a code,
  // then enter it.
  const client = new FapiClient({
    publishableKey: atlas.publishableKey,
    baseUrl: atlas.frontendApi,
    locale: atlas.locale,
    sdk: ATLAS_SVELTE_SDK,
  });
  let verifying: string | null = null;
  let code = '';
  let busy = false;
  let verifyError: string | null = null;

  async function sendCode(id: string) {
    verifyError = null;
    busy = true;
    const res = await client.post(`/v1/client/me/email_addresses/${id}/prepare_verification`);
    busy = false;
    if (!res.ok) {
      verifyError = t('userProfile.verifySendFailed');
      return;
    }
    code = '';
    verifying = id;
  }

  async function confirmCode() {
    if (!verifying) return;
    verifyError = null;
    busy = true;
    const res = await client.post(`/v1/client/me/email_addresses/${verifying}/attempt_verification`, { code });
    busy = false;
    if (!res.ok) {
      verifyError = t('userProfile.verifyCodeRejected');
      return;
    }
    verifying = null;
    await atlas.reload();
  }

  $: current = $user.user;
  $: cardClass = classFor('card', atlas.appearance, 'atlas-card');
  $: inputClass = classFor('formFieldInput', atlas.appearance, 'atlas-account-input');
  $: buttonClass = classFor('formButtonSecondary', atlas.appearance, 'atlas-button-secondary');
</script>

{#if current}
  <div class={cardClass}>
    <h1>{t('userProfile.title')}</h1>

    <section>
      <h2>{t('userProfile.emailsSection')}</h2>
      <ul>
        {#each current.email_addresses ?? [] as email (email.id)}
          <li>
            {email.email_address}
            {#if !email.verified}
              <em> — {t('userProfile.unverified')}</em>
              {#if verifying === email.id}
                <span data-atlas="email-verify">
                  <input
                    class={inputClass}
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    placeholder={t('userProfile.verifyCodePlaceholder')}
                    bind:value={code}
                  />
                  <button class={buttonClass} type="button" disabled={busy} on:click={() => void confirmCode()}>
                    {t('userProfile.verifyConfirm')}
                  </button>
                </span>
              {:else}
                <button class={buttonClass} type="button" disabled={busy} on:click={() => void sendCode(email.id)}>
                  {t('userProfile.verify')}
                </button>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
      {#if verifyError}
        <p role="alert">{verifyError}</p>
      {/if}
    </section>

    <section>
      <h2>{t('userProfile.securitySection')}</h2>
      <p>{current.mfa_enabled ? '2FA on' : '2FA off'}</p>
    </section>
  </div>
{/if}

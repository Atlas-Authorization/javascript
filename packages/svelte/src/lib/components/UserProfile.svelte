<script lang="ts">
  import { useAtlas } from '../context';
  import { getUser } from '../accessors';
  import { classFor } from '../appearance';
  import { translate } from '../i18n';

  /** §10.2 `<UserProfile/>` — the account-management card. */
  const atlas = useAtlas();
  const user = getUser();
  const t = (key: string) => translate(atlas.catalog, key);

  $: current = $user.user;
  $: cardClass = classFor('card', atlas.appearance, 'atlas-card');
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
            {/if}
          </li>
        {/each}
      </ul>
    </section>

    <section>
      <h2>{t('userProfile.securitySection')}</h2>
      <p>{current.mfa_enabled ? '2FA on' : '2FA off'}</p>
    </section>
  </div>
{/if}

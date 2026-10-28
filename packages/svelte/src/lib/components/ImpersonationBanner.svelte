<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { derived } from 'svelte/store';
  import { actorFromClaims, type EndImpersonationResult } from '@atlasauth/js';
  import { useAtlas } from '../context';
  import { classFor } from '../appearance';
  import { translate } from '../i18n';

  /**
   * A banner shown only while the active session is an impersonation, naming
   * the user acted as, with "Return to admin" (or "End impersonation" when there
   * is no session of the impersonator's to resume). Dispatches `ended` with the
   * outcome.
   */
  const atlas = useAtlas();
  const dispatch = createEventDispatcher<{ ended: EndImpersonationResult }>();
  const t = (key: string, vars?: Record<string, string>) => translate(atlas.catalog, key, vars);
  const state = derived([atlas.claims, atlas.session, atlas.user], ([$claims, $session, $user]) => {
    const actor = actorFromClaims($claims) ?? $session?.actor ?? null;
    const name =
      [$user?.first_name, $user?.last_name].filter(Boolean).join(' ') ||
      $user?.username ||
      $user?.email_addresses?.find((e) => e.primary)?.email_address ||
      $user?.id ||
      '';
    return { impersonating: actor !== null, canReturn: actor !== null && Boolean($session?.actor_session_id), name };
  });
  let busy = false;

  async function end() {
    busy = true;
    try {
      dispatch('ended', await atlas.endImpersonation());
    } finally {
      busy = false;
    }
  }
</script>

{#if $state.impersonating}
  <div class={classFor('card', atlas.appearance, 'atlas-alert atlas-impersonation-banner')} role="status">
    <span class={classFor('headerSubtitle', atlas.appearance, 'atlas-text')}>{t('impersonation.banner', { name: $state.name })}</span>
    <button
      type="button"
      class={classFor('formButtonPrimary', atlas.appearance, 'atlas-button')}
      disabled={busy}
      on:click={() => void end()}
    >
      {$state.canReturn ? t('impersonation.returnToAdmin') : t('impersonation.end')}
    </button>
  </div>
{/if}

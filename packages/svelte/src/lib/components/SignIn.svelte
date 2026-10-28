<script lang="ts">
  import { onDestroy } from 'svelte';
  import { lastUsedMethodLabel, pendingRecoveryCodes, signUp as hostedSignUp } from '@atlasauth/js';
  import { signIn } from '../accessors';
  import { useAtlas } from '../context';
  import { classFor } from '../appearance';
  import { translate } from '../i18n';
  import AttemptFlow from './AttemptFlow.svelte';
  import RecoveryCodes from './RecoveryCodes.svelte';

  /**
   * §10.2 `<SignIn/>` — a full multi-step flow driven entirely by the
   * server-side attempt status. Contains no decision about what comes next; it
   * renders whatever `status` the server returned. Draws the instance's sign-in
   * captcha when it is required (always-on, or a `needs_captcha` challenge).
   * Offers emailed first factors (code / link) only while the app can deliver
   * email (`settings.emailDelivery`).
   */
  export let afterUrl: string | undefined = undefined;
  /**
   * Where "No account? Sign up" goes. Default: the instance's hosted sign-up
   * page (carrying the visitor's referral). `null` hides it. Always shown, never
   * only after a failed sign-in, so it says nothing about whether an email has an account.
   */
  export let signUpUrl: string | null | undefined = undefined;

  const atlas = useAtlas();
  const t = (key: string) => translate(atlas.catalog, key);
  function signUpHref(url: string | null | undefined, after: string | undefined): string | null {
    if (url === null) return null;
    if (url) return url;
    try {
      return hostedSignUp({
        frontendApi: atlas.frontendApi,
        redirectUrl: after ?? (typeof window !== 'undefined' ? window.location.href : undefined),
        navigate: false,
      });
    } catch {
      return null;
    }
  }
  $: promptHref = $flowState.attempt?.status !== 'complete' ? signUpHref(signUpUrl, afterUrl) : null;

  const flow = signIn();
  // Named `flowState`, not `state`, so it can never collide with Svelte 5's
  // `$state` rune when a consumer compiles this in runes mode.
  const flowState = flow.state;
  const settings = flow.settings;
  const lastMethod = flow.lastMethod;
  const enrollmentState = flow.enrollmentState;
  onDestroy(() => flow.destroy());
  // After an MFA enrolment: its recovery codes, shown once before the sign-in finishes.
  $: recoveryCodes = pendingRecoveryCodes($flowState);
  $: lastLabel = !$flowState.attempt ? lastUsedMethodLabel($lastMethod, t) : null;

  // Re-evaluated whenever the settings or the step change; the controller is
  // configured synchronously by those same stores, so `needed` is current.
  // Takes the stores as arguments so Svelte re-runs it when either changes.
  const drawn = (..._deps: unknown[]) => (flow.captcha.needed ? flow.captcha : null);
  $: captcha = drawn($settings, $flowState);
</script>

{#if lastLabel}
  <p class={classFor('badge', atlas.appearance, 'atlas-text atlas-last-used-hint')} data-atlas="last-used" data-atlas-method={$lastMethod}>
    {t('signIn.lastUsed')}: {lastLabel}
  </p>
{/if}

{#if recoveryCodes}
  <RecoveryCodes codes={recoveryCodes} busy={$flowState.busy} onSaved={flow.saveRecoveryCodes} />
{:else}
<AttemptFlow
  attempt={$flowState.attempt}
  busy={$flowState.busy}
  errors={$flowState.errors}
  sessionKept={$flowState.sessionKept}
  titleKey="signIn.title"
  onSubmit={flow.submit}
  onPrepare={flow.prepare}
  onEmailSecondFactor={$settings?.account.emailSecondFactor ? flow.sendEmailSecondFactor : null}
  onSmsSecondFactor={$settings && flow.mfaChoices().sms ? flow.sendSmsSecondFactor : null}
  enrollment={flow.enrollment}
  enrollmentState={$enrollmentState}
  emailDelivery={$settings?.emailDelivery ?? null}
  {captcha}
  onPolicyDecline={flow.declinePolicy}
/>
{/if}

{#if promptHref}
  <p class={classFor('footerAction', atlas.appearance, 'atlas-footer')} data-atlas-sign-up-prompt="">
    {t('signIn.noAccount')} <a class="atlas-link" href={promptHref}>{t('signIn.signUpLink')}</a>
  </p>
{/if}

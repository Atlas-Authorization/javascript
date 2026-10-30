<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { lastUsedMethodLabel, passkeysSupported, pendingRecoveryCodes, signUp as hostedSignUp } from '@atlasauth/js';
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

  // "Sign in with Atlas", when the instance has it on (from /v1/appearance).
  $: atlasConnection = !$flowState.attempt ? $settings?.signInWithAtlas?.connectionId ?? null : null;
  let atlasError: string | null = null;
  async function continueWithAtlas() {
    if (!atlasConnection) return;
    atlasError = null;
    atlasError = (await flow.signInWithAtlas(atlasConnection)).error ?? null;
  }
  // Passkey sign-in on the first step, as the hosted page: the button and autofill.
  // `supported` is read after mount so the server render matches the first client render.
  let supported = false;
  onMount(() => {
    supported = passkeysSupported();
  });
  $: passkeyOffered = supported && !$flowState.attempt && $settings?.passkeySignIn === true;
  $: if (passkeyOffered) flow.passkey.armAutofill();
  else flow.passkey.stopAutofill();
  function submitIdentifier(values: Record<string, string>) {
    flow.passkey.stopAutofill();
    flow.submit(values);
  }
</script>

{#if lastLabel}
  <p class={classFor('badge', atlas.appearance, 'atlas-text atlas-last-used-hint')} data-atlas="last-used" data-atlas-method={$lastMethod}>
    {t('signIn.lastUsed')}: {lastLabel}
  </p>
{/if}

{#if atlasConnection && !recoveryCodes}
  <button
    type="button"
    class={classFor('socialButton', atlas.appearance, 'atlas-social-button')}
    data-atlas-provider="atlas"
    on:click={continueWithAtlas}
  >
    {t('signIn.continueWithAtlas')}
  </button>
  {#if atlasError}
    <p class={classFor('formFieldError', atlas.appearance, 'atlas-error')} role="alert">{atlasError}</p>
  {/if}
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
  onSubmit={submitIdentifier}
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

{#if passkeyOffered && !recoveryCodes}
  <button
    type="button"
    class={classFor('socialButton', atlas.appearance, 'atlas-social-button atlas-passkey-button')}
    data-atlas-passkey-sign-in=""
    disabled={$flowState.busy}
    on:click={() => flow.passkey.signIn()}
  >
    {t('signIn.passkeyButton')}
  </button>
{/if}

{#if promptHref}
  <p class={classFor('footerAction', atlas.appearance, 'atlas-footer')} data-atlas-sign-up-prompt="">
    {t('signIn.noAccount')} <a class="atlas-link" href={promptHref}>{t('signIn.signUpLink')}</a>
  </p>
{/if}

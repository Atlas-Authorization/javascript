<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { awaitingPasskey, existingAccountResetUrl, passkeysSupported, pendingExistingAccountNotice, pendingRecoveryCodes, signInAfterProofUrl, signUpProvedByLink } from '@atlasauth/js';
  import { emailLinkFromUrl, type EmailLink } from '@atlasauth/js';
  import { signUp } from '../accessors';
  import { classFor, type ElementKey } from '../appearance';
  import { useAtlas } from '../context';
  import { translate } from '../i18n';
  import AttemptFlow from './AttemptFlow.svelte';
  import EmailLinkPage from './EmailLinkPage.svelte';
  import PasskeySignUpStep from './PasskeySignUpStep.svelte';
  import RecoveryCodes from './RecoveryCodes.svelte';
  import SignUpForm from './SignUpForm.svelte';

  /**
   * §10.2 `<SignUp/>` — creates an account. The first step is the
   * create-account form (the instance's configured fields, email, password,
   * legal consent and — when required — the captcha), which POSTs
   * `/v1/client/sign_ups`; from there the flow is server-driven exactly like
   * `<SignIn/>` (the emailed-code step, then the ticket exchange).
   */
  export let afterUrl: string | undefined = undefined;
  /** Where the existing-account notice's "Forgot password?" goes. Default: the hosted sign-in page; `null` hides it. */
  export let resetPasswordUrl: string | null | undefined = undefined;
  /** Where "Sign in" goes once an emailed link confirmed the address and made no session here. Default: the hosted sign-in page; `null` hides it. */
  export let signInUrl: string | null | undefined = undefined;

  const atlas = useAtlas();
  const cls = (key: ElementKey, base: string) => classFor(key, atlas.appearance, base);
  const t = (key: string) => translate(atlas.catalog, key);
  const flow = signUp({ holdExistingAccountNotice: true });
  const flowState = flow.state;
  const authStatus = atlas.status;
  const settings = flow.settings;
  const enrollmentState = flow.enrollmentState;
  onDestroy(() => flow.destroy());
  onMount(() => {
    void flow.loadPolicies();
  });

  // Takes the stores as arguments so Svelte re-runs it when either changes.
  const drawn = (..._deps: unknown[]) => (flow.signUpCaptcha.needed ? flow.signUpCaptcha : null);
  $: captcha = drawn($settings, $flowState);

  // Passkey-only sign-up, when the instance offers it and the browser can.
  let mode: 'password' | 'passkey' = 'password';
  $: offer = $settings?.account.passkeySignUp ?? null;
  $: canPasskey = !!offer && passkeysSupported();
  $: usingPasskey = mode === 'passkey' && canPasskey;
  $: recoveryCodes = pendingRecoveryCodes($flowState);
  function switchMode() {
    mode = usingPasskey ? 'password' : 'passkey';
  }

  // Opened from a mailed link: that page, not the flow. Read once mounted, so hydration matches.
  let emailLink: EmailLink | null = null;
  onMount(() => {
    emailLink = emailLinkFromUrl(undefined, 'sign_up');
  });
</script>

{#if emailLink}
  <EmailLinkPage link={emailLink} />
{:else}
{#if recoveryCodes}
  <RecoveryCodes codes={recoveryCodes} busy={$flowState.busy} onSaved={flow.saveRecoveryCodes} />
{:else if pendingExistingAccountNotice($flowState)}
  {@const resetHref = existingAccountResetUrl({ url: resetPasswordUrl, frontendApi: atlas.frontendApi, redirectUrl: afterUrl })}
  <div class={cls('card', 'atlas-card')} data-atlas-existing-account="">
    <h1 class={cls('headerTitle', 'atlas-title')}>{t('signUp.title')}</h1>
    <p class="atlas-text">{t('signUp.existingAccount')}</p>
    {#if resetHref}
      <p class="atlas-text"><a class="atlas-link" href={resetHref}>{t('signIn.forgotPassword')}</a></p>
    {/if}
    <button class={cls('formButtonPrimary', 'atlas-button')} type="button" disabled={$flowState.busy} on:click={() => flow.continueAfterExistingAccount()}>
      {t('signUp.submit')}
    </button>
  </div>
{:else if $flowState.attempt && awaitingPasskey($flowState.attempt)}
  <PasskeySignUpStep busy={$flowState.busy} errors={$flowState.errors} onCreate={flow.createPasskey} />
{:else if signUpProvedByLink($flowState.attempt)}
  <!-- A link confirmed the address and made no session here. Says the same for any address. -->
  {@const signInHref = signInAfterProofUrl({ url: signInUrl, frontendApi: atlas.frontendApi, redirectUrl: afterUrl })}
  <div class={cls('card', 'atlas-card')} data-atlas-email-confirmed="">
    <h1 class={cls('headerTitle', 'atlas-title')}>{t('signUp.title')}</h1>
    <p class="atlas-text" role="status">{t('signUp.emailConfirmed')}</p>
    {#if signInHref}
      <a class={cls('formButtonPrimary', 'atlas-button')} href={signInHref}>{t('signIn.title')}</a>
    {/if}
  </div>
{:else if $flowState.attempt}
  <AttemptFlow
    attempt={$flowState.attempt}
    busy={$flowState.busy}
    errors={$flowState.errors}
    sessionKept={$flowState.sessionKept}
    titleKey="signUp.title"
    onSubmit={flow.submit}
    emailVerification={$settings?.account.emailVerification ?? 'code'}
    onResend={flow.resendSignUp}
    matchCode={$flowState.matchCode ?? null}
    onEmailSecondFactor={$settings?.account.emailSecondFactor ? flow.sendEmailSecondFactor : null}
    onSmsSecondFactor={$settings && flow.mfaChoices().sms ? flow.sendSmsSecondFactor : null}
    onOnlyWay={$settings && (flow.mfaChoices().emailCode || flow.mfaChoices().sms) ? flow.sendOnlyWay : null}
    onPasskeySecondFactor={$settings && flow.mfaChoices().passkey ? flow.continueWithPasskey : null}
    onHoldsFactor={$settings ? flow.holdsFactor : null}
    enrollment={flow.enrollment}
    enrollmentState={$enrollmentState}
    onPolicyDecline={flow.declinePolicy}
    signInHref={signInAfterProofUrl({ url: signInUrl, frontendApi: atlas.frontendApi, redirectUrl: afterUrl })}
  />
{:else if $authStatus === 'signed_in' && !$flowState.busy}
  <!-- signed in with no attempt held: nothing to draw -->
{:else}
  <SignUpForm
    settings={$settings}
    busy={$flowState.busy}
    errors={$flowState.errors}
    {captcha}
    policies={flow.policies}
    onSubmit={usingPasskey ? flow.createWithPasskey : flow.create}
    passkey={usingPasskey && offer ? { email: offer.email } : null}
    onSwitchMode={canPasskey ? switchMode : undefined}
  />
{/if}
{/if}

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { awaitingPasskey, passkeysSupported } from '@atlasauth/js';
  import { signUp } from '../accessors';
  import AttemptFlow from './AttemptFlow.svelte';
  import PasskeySignUpStep from './PasskeySignUpStep.svelte';
  import SignUpForm from './SignUpForm.svelte';

  /**
   * §10.2 `<SignUp/>` — creates an account. The first step is the
   * create-account form (the instance's configured fields, email, password,
   * legal consent and — when required — the captcha), which POSTs
   * `/v1/client/sign_ups`; from there the flow is server-driven exactly like
   * `<SignIn/>` (the emailed-code step, then the ticket exchange).
   */
  export let afterUrl: string | undefined = undefined;
  void afterUrl;

  const flow = signUp();
  const flowState = flow.state;
  const settings = flow.settings;
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
  function switchMode() {
    mode = usingPasskey ? 'password' : 'passkey';
  }
</script>

{#if $flowState.attempt && awaitingPasskey($flowState.attempt)}
  <PasskeySignUpStep busy={$flowState.busy} errors={$flowState.errors} onCreate={flow.createPasskey} />
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
  />
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

<script lang="ts">
  import { onDestroy } from 'svelte';
  import { signUp } from '../accessors';
  import AttemptFlow from './AttemptFlow.svelte';
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

  // Takes the stores as arguments so Svelte re-runs it when either changes.
  const drawn = (..._deps: unknown[]) => (flow.signUpCaptcha.needed ? flow.signUpCaptcha : null);
  $: captcha = drawn($settings, $flowState);
</script>

{#if $flowState.attempt}
  <AttemptFlow
    attempt={$flowState.attempt}
    busy={$flowState.busy}
    errors={$flowState.errors}
    titleKey="signUp.title"
    onSubmit={flow.submit}
  />
{:else}
  <SignUpForm
    settings={$settings}
    busy={$flowState.busy}
    errors={$flowState.errors}
    {captcha}
    onSubmit={flow.create}
  />
{/if}

<script lang="ts">
  import { onDestroy } from 'svelte';
  import { signIn } from '../accessors';
  import AttemptFlow from './AttemptFlow.svelte';

  /**
   * §10.2 `<SignIn/>` — a full multi-step flow driven entirely by the
   * server-side attempt status. Contains no decision about what comes next; it
   * renders whatever `status` the server returned. Draws the instance's sign-in
   * captcha when it is required (always-on, or a `needs_captcha` challenge).
   */
  export let afterUrl: string | undefined = undefined;
  // Reserved for parity with React's FlowProps; the redirect is handled by the
  // engine's boot on completion.
  void afterUrl;

  const flow = signIn();
  // Named `flowState`, not `state`, so it can never collide with Svelte 5's
  // `$state` rune when a consumer compiles this in runes mode.
  const flowState = flow.state;
  const settings = flow.settings;
  onDestroy(() => flow.destroy());

  // Re-evaluated whenever the settings or the step change; the controller is
  // configured synchronously by those same stores, so `needed` is current.
  // Takes the stores as arguments so Svelte re-runs it when either changes.
  const drawn = (..._deps: unknown[]) => (flow.captcha.needed ? flow.captcha : null);
  $: captcha = drawn($settings, $flowState);
</script>

<AttemptFlow
  attempt={$flowState.attempt}
  busy={$flowState.busy}
  errors={$flowState.errors}
  titleKey="signIn.title"
  onSubmit={flow.submit}
  {captcha}
/>

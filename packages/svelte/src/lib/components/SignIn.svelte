<script lang="ts">
  import { onDestroy } from 'svelte';
  import { signIn } from '../accessors';
  import AttemptFlow from './AttemptFlow.svelte';

  /**
   * §10.2 `<SignIn/>` — a full multi-step flow driven entirely by the
   * server-side attempt status. Contains no decision about what comes next; it
   * renders whatever `status` the server returned.
   */
  export let afterUrl: string | undefined = undefined;
  // Reserved for parity with React's FlowProps; the redirect is handled by the
  // engine's boot on completion.
  void afterUrl;

  const flow = signIn();
  // Named `flowState`, not `state`, so it can never collide with Svelte 5's
  // `$state` rune when a consumer compiles this in runes mode.
  const flowState = flow.state;
  onDestroy(() => flow.destroy());
</script>

<AttemptFlow
  attempt={$flowState.attempt}
  busy={$flowState.busy}
  errors={$flowState.errors}
  titleKey="signIn.title"
  onSubmit={flow.submit}
/>

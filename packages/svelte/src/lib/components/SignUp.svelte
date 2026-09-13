<script lang="ts">
  import { onDestroy } from 'svelte';
  import { signUp } from '../accessors';
  import AttemptFlow from './AttemptFlow.svelte';

  /**
   * §10.2 `<SignUp/>` — the server-driven registration flow. Same shell as
   * `<SignIn/>`, only the title differs; the step sequence comes from the server.
   */
  export let afterUrl: string | undefined = undefined;
  void afterUrl;

  const flow = signUp();
  const flowState = flow.state;
  onDestroy(() => flow.destroy());
</script>

<AttemptFlow
  attempt={$flowState.attempt}
  busy={$flowState.busy}
  errors={$flowState.errors}
  titleKey="signUp.title"
  onSubmit={flow.submit}
/>

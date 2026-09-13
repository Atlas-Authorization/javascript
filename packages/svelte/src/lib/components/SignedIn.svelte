<script lang="ts">
  import { getUser } from '../accessors';

  /** §10.2 render children only once a signed-in user is confirmed. */
  const user = getUser();
</script>

{#if $user.isLoaded && $user.isSignedIn}
  <slot />
{/if}

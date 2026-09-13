<script lang="ts">
  import { getUser } from '../accessors';

  /**
   * §10.2 render children only once the SDK has confirmed there is no user.
   * Renders nothing while loading rather than flashing the signed-out branch.
   */
  const user = getUser();
</script>

{#if $user.isLoaded && !$user.isSignedIn}
  <slot />
{/if}

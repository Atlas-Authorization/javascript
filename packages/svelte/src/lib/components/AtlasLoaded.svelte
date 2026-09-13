<script lang="ts">
  import { getUser } from '../accessors';

  /**
   * §10.2 render children only once the SDK has finished loading — the symmetric
   * partner of {@link AtlasLoading}, so a consumer can show a spinner and its
   * resolved content without hand-rolling the inverse condition.
   */
  const user = getUser();
</script>

{#if $user.isLoaded}
  <slot />
{/if}

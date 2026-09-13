<script lang="ts">
  import { getUser } from '../accessors';

  /** §10.2 render children only while the SDK is still loading. */
  const user = getUser();
</script>

{#if !$user.isLoaded}
  <slot />
{/if}

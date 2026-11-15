<script lang="ts">
  import { AtlasProvider } from '@atlasauth/svelte';
  import { env } from '$env/dynamic/public';

  let { children } = $props();
</script>

<AtlasProvider publishableKey={env.PUBLIC_ATLAS_PUBLISHABLE_KEY ?? ''} frontendApi={env.PUBLIC_ATLAS_FRONTEND_API ?? ''}>
  {@render children()}
</AtlasProvider>

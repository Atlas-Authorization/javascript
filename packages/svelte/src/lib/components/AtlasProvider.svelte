<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { initAtlas, type AtlasClient } from '../context';
  import { cssVariables, resolveTokens, type Appearance } from '../appearance';
  import type { Catalog } from '../i18n';

  /**
   * §10.1 `<AtlasProvider publishableKey>` — the Svelte peer of React's provider.
   *
   * Calls {@link initAtlas} during component init so the client is in context
   * before any child `<script>` runs, then renders a host-DOM wrapper carrying
   * the appearance tokens as CSS variables. No iframe: components render in the
   * host DOM so Tailwind / plain CSS just work.
   */
  export let publishableKey: string;
  export let frontendApi: string | undefined = undefined;
  export let appearance: Appearance | undefined = undefined;
  export let localization: Catalog | undefined = undefined;
  export let fetchImpl: typeof fetch | undefined = undefined;

  const client: AtlasClient = initAtlas({
    publishableKey,
    frontendApi,
    appearance,
    localization,
    fetchImpl,
  });

  // Tokens land as CSS variables on a host-DOM element — no iframe.
  $: style = Object.entries(cssVariables(resolveTokens(appearance)))
    .map(([name, value]) => `${name}: ${value}`)
    .join('; ');

  // initAtlas already boots in the browser; this is the belt-and-braces mount
  // hook (idempotent), and the symmetric teardown that cancels the refresh timer.
  onMount(() => void client.boot());
  onDestroy(() => client.destroy());
</script>

<div class="atlas-root" {style}>
  <slot />
</div>

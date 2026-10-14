<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { initAtlas, type AtlasClient } from '../context';
  import { renderAppearance, type Appearance, type InstanceDesign } from '../appearance';
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

  /**
   * The dashboard design (fetched after mount, best-effort) layered with the
   * code-level `appearance.preset` / `appearance.design` — the same semantics as
   * @atlasauth/react. Without any design this is exactly the token variables.
   */
  let instanceDesign: InstanceDesign | null = null;
  $: rendered = renderAppearance(appearance, instanceDesign, { frontendApi: client.frontendApi });

  // Tokens land as CSS variables on a host-DOM element — no iframe.
  $: style = Object.entries(rendered.style)
    .map(([name, value]) => `${name}: ${value}`)
    .join('; ');

  // The compiled design stylesheet: custom properties only, from validated
  // settings; the compiler refuses any output containing `<`.
  $: designStyle = rendered.css
    ? `<style data-atlas-design="${rendered.key}">${rendered.css}</style>`
    : '';

  // initAtlas already boots in the browser; this is the belt-and-braces mount
  // hook (idempotent), and the symmetric teardown that cancels the refresh timer.
  onMount(() => {
    void client.boot();
    if (appearance?.instanceDesign !== false) {
      void client.loadInstanceDesign().then((design) => {
        if (design) instanceDesign = design;
      });
    }
  });
  onDestroy(() => client.destroy());
</script>

<svelte:head>
  {@html designStyle}
  {#each rendered.fontStylesheets as href (href)}
    <link rel="stylesheet" {href} data-atlas-font="" />
  {/each}
</svelte:head>

<div class="atlas-root" {style} {...rendered.attributes}>
  <slot />
</div>

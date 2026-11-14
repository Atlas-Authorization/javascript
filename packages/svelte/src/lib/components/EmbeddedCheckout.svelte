<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { BILLING_LABELS, mountEmbeddedCheckout, type BillingLabels, type EmbeddedCheckoutHandle } from '@atlasauth/js';
  import { createBillingController } from '../managed';

  /**
   * In-page checkout for a plan: the provider's own Embedded Checkout frame (its script owns the card fields, no
   * card data touches Atlas). When the instance has no embedded checkout it renders the default slot, or a button
   * that starts the hosted checkout.
   */
  export let planId: string;
  export let orgId: string | undefined = undefined;
  export let returnUrl: string | undefined = undefined;
  /** A discount code the buyer entered (see `Checkout`). */
  export let couponCode: string | undefined = undefined;
  export let interval: 'month' | 'year' | undefined = undefined;
  export let labels: BillingLabels = {};

  const { client, controller } = createBillingController({ orgId });
  let element: HTMLElement;
  let outcome: Pick<EmbeddedCheckoutHandle, 'status' | 'error'> | null = null;
  let handle: EmbeddedCheckoutHandle | null = null;
  let gone = false;
  $: l = { ...BILLING_LABELS, ...labels };

  onMount(async () => {
    handle = await mountEmbeddedCheckout(client, { planId, orgId, returnUrl, couponCode, interval }, element, () => gone);
    outcome = { status: handle.status, error: handle.error };
  });
  onDestroy(() => {
    gone = true;
    handle?.destroy();
  });
</script>

{#if outcome?.status === 'unavailable'}
  <slot>
    <button type="button" data-atlas="checkout-fallback" on:click={() => void controller.checkout({ planId, orgId, couponCode, interval })}>{l.subscribe}</button>
  </slot>
{:else}
  <div data-atlas="embedded-checkout">
    {#if outcome?.status === 'error'}<p role="alert">{outcome.error ?? l.checkoutFailed}</p>{/if}
    <div bind:this={element}></div>
  </div>
{/if}

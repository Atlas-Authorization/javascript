<script lang="ts">
  import { BILLING_LABELS, CHECKOUT_LABELS, formatLabel, pricingCards, type BillingLabels, type CheckoutLabels } from '@atlasauth/js';
  import { classFor } from '../appearance';
  import { controllerStore, createBillingController, createCheckoutController } from '../managed';
  import EmbeddedCheckout from './EmbeddedCheckout.svelte';

  /**
   * The step before payment for one plan: the plan and its price, a monthly/yearly choice when it has an annual
   * price, an optional discount code with a server-side "apply" check, and the way on to payment. `embedded`
   * mounts the in-page frame after "Continue"; otherwise the button redirects to the hosted page.
   */
  export let planId: string;
  export let orgId: string | undefined = undefined;
  export let embedded = false;
  export let returnUrl: string | undefined = undefined;
  export let locale: string | undefined = undefined;
  export let labels: BillingLabels & CheckoutLabels = {};

  const { atlas, controller: billing } = createBillingController({ orgId });
  const billingState = controllerStore(billing);
  const status = atlas.status;
  $: if ($status !== 'loading') void billing.load($status === 'signed_in');

  const step = createCheckoutController(billing, planId, { orgId, embedded, locale, labels });
  const state = controllerStore(step);

  $: l = { ...BILLING_LABELS, ...CHECKOUT_LABELS, ...labels };
  $: pageLocale = locale ?? (typeof document !== 'undefined' ? document.documentElement.lang || undefined : undefined);
  $: plan = $billingState.isLoaded ? $billingState.plans.find((p) => p.id === planId) ?? null : null;
  $: view = plan ? pricingCards({ plans: [plan], subscription: null, addons: [], interval: $state.interval }, { locale: pageLocale }).cards[0]!.view : null;
  $: signedIn = $status === 'signed_in';
  $: cardClass = classFor('card', atlas.appearance, 'atlas-card');
  $: primary = classFor('formButtonPrimary', atlas.appearance, 'atlas-button');
  $: secondary = classFor('formButtonSecondary', atlas.appearance, 'atlas-button-secondary');
</script>

{#if !$billingState.isLoaded}
  <div data-atlas="checkout" aria-busy="true"></div>
{:else if !plan || !view}
  <div data-atlas="checkout" role="alert">{l.planGone}</div>
{:else}
  <div class={cardClass} data-atlas="checkout">
    <h3 class={classFor('planName', atlas.appearance, 'atlas-plan-name')}>{plan.name}</h3>
    {#if plan.badge}<p data-atlas="checkout-badge" class="atlas-badge">{plan.badge}</p>{/if}
    {#if plan.description}<p class="atlas-text">{plan.description}</p>{/if}
    {#if plan.annual_available}
      <div role="group" aria-label="Billing interval" data-atlas="checkout-interval">
        {#each ['month', 'year'] as i (i)}
          <button type="button" class={secondary} aria-pressed={$state.interval === i} disabled={$state.started} on:click={() => step.setInterval(i === 'year' ? 'year' : 'month')}>{i === 'month' ? l.monthly : l.yearly}</button>
        {/each}
      </div>
    {/if}
    <p class={classFor('price', atlas.appearance, 'atlas-price')} data-atlas="checkout-price">
      {#if view.originalPrice}<s>{view.originalPrice}</s>{/if}
      {view.free ? l.free : view.price}
    </p>
    {#if !$state.started}
      <div data-atlas="checkout-coupon">
        <label>
          {l.code}
          <input value={$state.code} autocomplete="off" spellcheck="false" on:input={(e) => step.setCode(e.currentTarget.value)} />
        </label>
        <button type="button" class={secondary} disabled={$state.busy || !signedIn || !$state.code.trim()} on:click={() => void step.apply()}>{l.apply}</button>
        {#if $state.applied}<p role="status" data-atlas="checkout-coupon-applied">{formatLabel(l.applied, { what: $state.applied.text })}</p>{/if}
        {#if $state.problem}<p role="alert" data-atlas="checkout-coupon-problem">{$state.problem}</p>{/if}
      </div>
      {#if !signedIn}<p class="atlas-text">{l.signIn}</p>{/if}
      <button type="button" class={primary} disabled={!signedIn} on:click={() => void step.proceed()}>{embedded ? l.continue : l.subscribe}</button>
    {:else}
      <EmbeddedCheckout {planId} {orgId} {returnUrl} couponCode={$state.applied?.code} interval={plan.annual_available ? $state.interval : undefined} />
    {/if}
  </div>
{/if}

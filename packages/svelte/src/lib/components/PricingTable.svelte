<script lang="ts">
  import { BILLING_LABELS, formatLabel, pricingCards, type BillingLabels } from '@atlasauth/js';
  import { classFor } from '../appearance';
  import { controllerStore, createBillingController } from '../managed';

  /**
   * The instance's plans as cards: a locale-formatted price, features, a free-trial badge, a monthly/yearly
   * switch when a plan has an annual price, and a plan's promotion. The plan the subject is on is marked current
   * and its button opens the billing portal; a live base plan switches in place (prorated); add-ons are bought
   * alongside. `audience` shows only `user` or `org` plans. A label may be a template with `{placeholders}` or a
   * function of the value.
   */
  export let orgId: string | undefined = undefined;
  export let audience: 'user' | 'org' | undefined = undefined;
  export let locale: string | undefined = undefined;
  export let labels: Omit<BillingLabels, 'trial' | 'useCode'> & { trial?: string | ((days: number) => string); useCode?: string | ((code: string) => string) } = {};

  const { atlas, controller } = createBillingController({ orgId });
  const state = controllerStore(controller);
  const status = atlas.status;
  $: if ($status !== 'loading') void controller.load($status === 'signed_in');

  $: l = { ...BILLING_LABELS, ...labels };
  $: pageLocale = locale ?? (typeof document !== 'undefined' ? document.documentElement.lang || undefined : undefined);
  $: view = pricingCards($state, { audience, locale: pageLocale });
  const say = (label: string | ((v: never) => string), key: string, value: string | number) =>
    typeof label === 'function' ? (label as (v: string | number) => string)(value) : formatLabel(label, { [key]: value });
  $: tableClass = classFor('pricingTable', atlas.appearance, 'atlas-pricing-table');
  $: cardClass = classFor('card', atlas.appearance, 'atlas-card');
  $: primary = classFor('formButtonPrimary', atlas.appearance, 'atlas-button');
  $: secondary = classFor('formButtonSecondary', atlas.appearance, 'atlas-button-secondary');
</script>

{#if !$state.isLoaded}
  <div data-atlas="pricing-table" aria-busy="true"></div>
{:else}
  <div class={tableClass} data-atlas="pricing-table">
    {#if view.hasAnnual}
      <div role="group" aria-label="Billing interval" data-atlas="pricing-interval">
        {#each ['month', 'year'] as i (i)}
          <button type="button" class={secondary} aria-pressed={$state.interval === i} on:click={() => controller.setInterval(i === 'year' ? 'year' : 'month')}>{i === 'month' ? l.monthly : l.yearly}</button>
        {/each}
      </div>
    {/if}
    {#each view.cards as card (card.plan.id)}
      <div class={cardClass} data-atlas="pricing-plan" data-current={card.isCurrent} data-kind={card.isAddon ? 'addon' : 'base'}>
        <h3 class={classFor('planName', atlas.appearance, 'atlas-plan-name')}>{card.plan.name}</h3>
        {#if card.plan.badge}<p data-atlas="pricing-badge" class="atlas-badge">{card.plan.badge}</p>{/if}
        {#if card.plan.description}<p data-atlas="pricing-description" class="atlas-text">{card.plan.description}</p>{/if}
        {#if card.view.promotionLabel}<p data-atlas="pricing-promotion" class="atlas-badge">{card.view.promotionLabel}</p>{/if}
        <p class={classFor('price', atlas.appearance, 'atlas-price')}>
          {#if card.view.originalPrice}<s data-atlas="pricing-original">{card.view.originalPrice}</s>{/if}
          {card.view.free ? l.free : card.view.price}
          {#if !card.view.free}<span class="atlas-interval"> / {card.view.interval === 'year' ? l.perYear : l.perMonth}</span>{/if}
        </p>
        {#if card.view.trialDays}<p data-atlas="pricing-trial" class="atlas-badge">{say(l.trial, 'days', card.view.trialDays)}</p>{/if}
        {#if card.view.promotionCode}<p data-atlas="pricing-code" class="atlas-text">{say(l.useCode, 'code', card.view.promotionCode)}</p>{/if}
        {#if card.plan.features.length}
          <ul class="atlas-list">{#each card.plan.features as f}<li class="atlas-list-item">{f}</li>{/each}</ul>
        {/if}
        {#if card.isCurrent}
          <button type="button" class={primary} data-atlas="manage-billing" on:click={() => void controller.openPortal(card.heldSubscriptionId ? { subscriptionId: card.heldSubscriptionId } : {})}>{l.manage}</button>
        {:else}
          <button type="button" class={primary} disabled={$status !== 'signed_in' || $state.busyPlan === card.plan.id} on:click={() => void controller.choosePlan(card.plan)}>{l.subscribe}</button>
        {/if}
      </div>
    {/each}
    {#if $state.error}<p role="alert" class="atlas-alert">{$state.error}</p>{/if}
  </div>
{/if}

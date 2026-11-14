<script lang="ts">
  import { BILLING_LABELS, formatMoney, type BillingLabels } from '@atlasauth/js';
  import { classFor } from '../appearance';
  import { controllerStore, createBillingController } from '../managed';

  /** The subject's billing history: number, amount, status and a link to the hosted invoice. */
  export let orgId: string | undefined = undefined;
  export let labels: BillingLabels = {};

  const { atlas, controller } = createBillingController({ orgId });
  const state = controllerStore(controller);
  const status = atlas.status;
  $: if ($status !== 'loading') void controller.load($status === 'signed_in');
  $: l = { ...BILLING_LABELS, ...labels };
  $: cardClass = classFor('card', atlas.appearance, 'atlas-card');
</script>

{#if !$state.isLoaded}
  <div data-atlas="invoices" aria-busy="true"></div>
{:else}
  <div class={cardClass} data-atlas="invoices">
    <h3 class="atlas-section-title">{l.invoices}</h3>
    {#if $state.invoices.length === 0}
      <p class="atlas-text" data-atlas="invoices-empty">{l.noInvoices}</p>
    {:else}
      <ul class="atlas-list">
        {#each $state.invoices as inv (inv.id)}
          <li class="atlas-list-item" data-atlas="invoice" data-status={inv.status}>
            <span>{inv.number ?? inv.id}</span>
            <span>{formatMoney(inv.amount_paid || inv.amount_due, inv.currency)}</span>
            <span>{inv.status}</span>
            {#if inv.hosted_invoice_url}<a class="atlas-link" href={inv.hosted_invoice_url} target="_blank" rel="noreferrer">{l.viewInvoice}</a>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

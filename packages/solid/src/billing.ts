import { onCleanup, onMount, createSignal, type JSX } from 'solid-js';
import {
  BILLING_LABELS,
  CHECKOUT_LABELS,
  formatLabel,
  formatMoney,
  mountEmbeddedCheckout,
  pricingCards,
  type BillingLabels,
  type CheckoutLabels,
  type EmbeddedCheckoutHandle,
} from '@atlasauth/js';
import { h } from './h';
import { useAtlas } from './context';
import { createBilling, createCheckoutStep, useMeClients } from './managed';

/** A label is a template with `{placeholders}`, or a function of the value. */
type Label<T> = string | ((value: T) => string);
export type PricingTableLabels = Omit<BillingLabels, 'trial' | 'useCode'> & { trial?: Label<number>; useCode?: Label<string> };
const say = <T extends string | number>(label: Label<T>, key: string, value: T): string => (typeof label === 'function' ? label(value) : formatLabel(label, { [key]: value }));

/**
 * `<PricingTable/>` — the instance's plans as cards: a locale-formatted price, features, a free-trial badge, a
 * monthly/yearly switch when a plan has an annual price, and a plan's promotion. The plan the subject is on is
 * marked current and its button opens the billing portal; a live base plan switches in place (prorated);
 * add-ons are bought alongside. `audience` shows only `user` or `org` plans.
 */
export function PricingTable(props: { orgId?: string; locale?: string; audience?: 'user' | 'org'; labels?: PricingTableLabels } = {}): JSX.Element {
  const atlas = useAtlas();
  const { state, controller } = createBilling({ orgId: props.orgId });
  return (() => {
    const s = state();
    if (!s.isLoaded) return h('div', { 'data-atlas': 'pricing-table', 'aria-busy': 'true' });
    const L = { ...BILLING_LABELS, ...props.labels };
    const locale = props.locale ?? (typeof document !== 'undefined' ? document.documentElement.lang || undefined : undefined);
    const { cards, hasAnnual } = pricingCards(s, { audience: props.audience, locale });
    return h('div', { class: 'atlas-pricing-table', 'data-atlas': 'pricing-table' }, [
      hasAnnual
        ? h('div', { role: 'group', 'aria-label': 'Billing interval', 'data-atlas': 'pricing-interval' }, (['month', 'year'] as const).map((i) => h('button', { type: 'button', class: 'atlas-button-secondary', 'aria-pressed': s.interval === i, onClick: () => controller.setInterval(i) }, i === 'month' ? L.monthly : L.yearly)))
        : null,
      ...cards.map(({ plan, isAddon, isCurrent, heldSubscriptionId, view }) =>
        h('div', { class: 'atlas-card', 'data-atlas': 'pricing-plan', 'data-current': isCurrent, 'data-kind': isAddon ? 'addon' : 'base' }, [
          h('h3', { class: 'atlas-plan-name' }, plan.name),
          plan.badge ? h('p', { 'data-atlas': 'pricing-badge', class: 'atlas-badge' }, plan.badge) : null,
          plan.description ? h('p', { 'data-atlas': 'pricing-description', class: 'atlas-text' }, plan.description) : null,
          view.promotionLabel ? h('p', { 'data-atlas': 'pricing-promotion', class: 'atlas-badge' }, view.promotionLabel) : null,
          h('p', { class: 'atlas-price' }, [view.originalPrice ? h('s', { 'data-atlas': 'pricing-original' }, view.originalPrice) : null, ' ', view.free ? L.free : view.price, view.free ? null : h('span', { class: 'atlas-interval' }, ` / ${view.interval === 'year' ? L.perYear : L.perMonth}`)]),
          view.trialDays ? h('p', { 'data-atlas': 'pricing-trial', class: 'atlas-badge' }, say(L.trial, 'days', view.trialDays)) : null,
          view.promotionCode ? h('p', { 'data-atlas': 'pricing-code', class: 'atlas-text' }, say(L.useCode, 'code', view.promotionCode)) : null,
          plan.features.length ? h('ul', { class: 'atlas-list' }, plan.features.map((f) => h('li', { class: 'atlas-list-item' }, f))) : null,
          isCurrent
            ? h('button', { type: 'button', class: 'atlas-button', 'data-atlas': 'manage-billing', onClick: () => void controller.openPortal(heldSubscriptionId ? { subscriptionId: heldSubscriptionId } : {}) }, L.manage)
            : h('button', { type: 'button', class: 'atlas-button', disabled: atlas.state.status !== 'signed_in' || s.busyPlan === plan.id, onClick: () => void controller.choosePlan(plan) }, L.subscribe),
        ]),
      ),
      s.error ? h('p', { role: 'alert', class: 'atlas-alert' }, s.error) : null,
    ]);
  }) as unknown as JSX.Element;
}

/** `<Invoices/>` — the subject's billing history: number, amount, status and a link to the hosted invoice. */
export function Invoices(props: { orgId?: string; labels?: BillingLabels } = {}): JSX.Element {
  const { state } = createBilling({ orgId: props.orgId });
  return (() => {
    const s = state();
    const L = { ...BILLING_LABELS, ...props.labels };
    if (!s.isLoaded) return h('div', { 'data-atlas': 'invoices', 'aria-busy': 'true' });
    return h('div', { class: 'atlas-card', 'data-atlas': 'invoices' }, [
      h('h3', { class: 'atlas-section-title' }, L.invoices),
      s.invoices.length === 0
        ? h('p', { class: 'atlas-text', 'data-atlas': 'invoices-empty' }, L.noInvoices)
        : h(
            'ul',
            { class: 'atlas-list' },
            s.invoices.map((inv) =>
              h('li', { class: 'atlas-list-item', 'data-atlas': 'invoice', 'data-status': inv.status }, [
                h('span', inv.number ?? inv.id),
                ' ',
                h('span', formatMoney(inv.amount_paid || inv.amount_due, inv.currency)),
                ' ',
                h('span', inv.status),
                ' ',
                inv.hosted_invoice_url ? h('a', { class: 'atlas-link', href: inv.hosted_invoice_url, target: '_blank', rel: 'noreferrer' }, L.viewInvoice) : null,
              ]),
            ),
          ),
    ]);
  }) as unknown as JSX.Element;
}

/**
 * `<EmbeddedCheckout/>` — in-page checkout for a plan: the provider's own Embedded Checkout frame (its script
 * owns the card fields, no card data touches Atlas). When the instance has no embedded checkout it renders
 * `fallback`, or a button that starts the hosted checkout.
 */
export function EmbeddedCheckout(props: { planId: string; orgId?: string; returnUrl?: string; couponCode?: string; interval?: 'month' | 'year'; fallback?: JSX.Element; labels?: BillingLabels }): JSX.Element {
  const { client } = useMeClients();
  const { controller } = createBilling({ orgId: props.orgId });
  const [outcome, setOutcome] = createSignal<Pick<EmbeddedCheckoutHandle, 'status' | 'error'> | null>(null);
  let element: HTMLElement | undefined;
  let handle: EmbeddedCheckoutHandle | null = null;
  let gone = false;
  onMount(async () => {
    if (!element) return;
    handle = await mountEmbeddedCheckout(client, { planId: props.planId, orgId: props.orgId, returnUrl: props.returnUrl, couponCode: props.couponCode, interval: props.interval }, element, () => gone);
    setOutcome({ status: handle.status, error: handle.error });
  });
  onCleanup(() => {
    gone = true;
    handle?.destroy();
  });
  return (() => {
    const L = { ...BILLING_LABELS, ...props.labels };
    const o = outcome();
    if (o?.status === 'unavailable')
      return props.fallback ?? h('button', { type: 'button', 'data-atlas': 'checkout-fallback', onClick: () => void controller.checkout({ planId: props.planId, orgId: props.orgId, couponCode: props.couponCode, interval: props.interval }) }, L.subscribe);
    return h('div', { 'data-atlas': 'embedded-checkout' }, [o?.status === 'error' ? h('p', { role: 'alert' }, o.error ?? L.checkoutFailed) : null, h('div', { ref: (el: HTMLElement) => (element = el) })]);
  }) as unknown as JSX.Element;
}

/**
 * `<Checkout/>` — the step before payment for one plan: the plan and its price, a monthly/yearly choice when it
 * has an annual price, an optional discount code with a server-side "apply" check, and the way on to payment.
 * `embedded` mounts the in-page frame after "Continue"; otherwise the button redirects to the hosted page.
 */
export function Checkout(props: {
  planId: string;
  orgId?: string;
  embedded?: boolean;
  returnUrl?: string;
  locale?: string;
  labels?: BillingLabels & CheckoutLabels;
  onStarted?: (info: { planId: string; couponCode?: string; interval: 'month' | 'year' }) => void;
}): JSX.Element {
  const atlas = useAtlas();
  const { state: billing, controller: billingController } = createBilling({ orgId: props.orgId });
  const { state, controller } = createCheckoutStep(billingController, props.planId, {
    orgId: props.orgId,
    embedded: props.embedded,
    locale: props.locale,
    labels: props.labels,
    onStarted: props.onStarted,
  });
  return (() => {
    const L = { ...BILLING_LABELS, ...CHECKOUT_LABELS, ...props.labels };
    if (!billing().isLoaded) return h('div', { 'data-atlas': 'checkout', 'aria-busy': 'true' });
    const plan = controller.plan();
    if (!plan) return h('div', { 'data-atlas': 'checkout', role: 'alert' }, L.planGone);
    const s = state();
    const locale = props.locale ?? (typeof document !== 'undefined' ? document.documentElement.lang || undefined : undefined);
    const view = pricingCards({ plans: [plan], subscription: null, addons: [], interval: s.interval }, { locale }).cards[0]!.view;
    const signedIn = atlas.state.status === 'signed_in';
    return h('div', { class: 'atlas-card', 'data-atlas': 'checkout' }, [
      h('h3', { class: 'atlas-plan-name' }, plan.name),
      plan.badge ? h('p', { 'data-atlas': 'checkout-badge', class: 'atlas-badge' }, plan.badge) : null,
      plan.description ? h('p', { class: 'atlas-text' }, plan.description) : null,
      plan.annual_available
        ? h('div', { role: 'group', 'aria-label': 'Billing interval', 'data-atlas': 'checkout-interval' }, (['month', 'year'] as const).map((i) => h('button', { type: 'button', class: 'atlas-button-secondary', 'aria-pressed': s.interval === i, disabled: s.started, onClick: () => controller.setInterval(i) }, i === 'month' ? L.monthly : L.yearly)))
        : null,
      h('p', { class: 'atlas-price', 'data-atlas': 'checkout-price' }, [view.originalPrice ? h('s', view.originalPrice) : null, ' ', view.free ? L.free : view.price]),
      s.started
        ? null
        : h('div', { 'data-atlas': 'checkout-coupon' }, [
            h('label', [L.code, ' ', h('input', { value: s.code, autocomplete: 'off', spellcheck: false, onInput: (e: Event) => controller.setCode((e.target as HTMLInputElement).value) })]),
            ' ',
            h('button', { type: 'button', class: 'atlas-button-secondary', disabled: s.busy || !signedIn || !s.code.trim(), onClick: () => void controller.apply() }, L.apply),
            s.applied ? h('p', { role: 'status', 'data-atlas': 'checkout-coupon-applied' }, formatLabel(L.applied, { what: s.applied.text })) : null,
            s.problem ? h('p', { role: 'alert', 'data-atlas': 'checkout-coupon-problem' }, s.problem) : null,
          ]),
      s.started || signedIn ? null : h('p', { class: 'atlas-text' }, L.signIn),
      s.started ? null : h('button', { type: 'button', class: 'atlas-button', disabled: !signedIn, onClick: () => void controller.proceed() }, props.embedded ? L.continue : L.subscribe),
      s.started ? h(EmbeddedCheckout, { planId: props.planId, orgId: props.orgId, returnUrl: props.returnUrl, couponCode: s.applied?.code, interval: plan.annual_available ? s.interval : undefined }) : null,
    ]);
  }) as unknown as JSX.Element;
}

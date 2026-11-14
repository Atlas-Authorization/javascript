import { defineComponent, h, onBeforeUnmount, onMounted, shallowRef, type PropType, type VNode } from 'vue';
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
import { useAtlas } from './context';
import { useAuth } from './composables';
import { classFor, type ElementKey } from './appearance';
import { useBilling, useCheckoutStep, useMeClient } from './managed-components';

/** A label is a template with `{placeholders}`, or (kept from the first `<PricingTable/>`) a function of the value. */
type Label<T> = string | ((value: T) => string);
export type PricingTableLabels = Omit<BillingLabels, 'trial' | 'useCode'> & { trial?: Label<number>; useCode?: Label<string> };

const say = <T extends string | number>(label: Label<T>, key: string, value: T): string =>
  typeof label === 'function' ? label(value) : formatLabel(label, { [key]: value });

/**
 * `<PricingTable/>` — the instance's plans as cards: a locale-formatted price, features, a free-trial badge, a
 * monthly/yearly switch when a plan has an annual price, and a plan's promotion (label, struck-through price,
 * the code to enter at checkout). The plan the subject is on is marked current and its button opens the billing
 * portal; a subject with a live base plan switches plans in place (prorated); add-ons are bought alongside.
 * Needs a signed-in session to subscribe. `audience` shows only `user` or `org` plans.
 */
export const PricingTable = defineComponent({
  name: 'PricingTable',
  props: {
    audience: { type: String as PropType<'user' | 'org'>, default: undefined },
    orgId: { type: String, default: undefined },
    locale: { type: String, default: undefined },
    labels: { type: Object as PropType<PricingTableLabels>, default: () => ({}) },
  },
  setup(props) {
    const atlas = useAtlas();
    const { status } = useAuth();
    const { state, controller } = useBilling({ orgId: props.orgId });
    const cls = (key: ElementKey, base: string) => classFor(key, atlas.appearance, base);

    return () => {
      const s = state.value;
      if (!s.isLoaded) return h('div', { 'data-atlas': 'pricing-table', 'aria-busy': 'true' });
      const L = { ...BILLING_LABELS, ...props.labels };
      const locale = props.locale ?? (typeof document !== 'undefined' ? document.documentElement.lang || undefined : undefined);
      const { cards, hasAnnual } = pricingCards(s, { audience: props.audience, locale });
      return h('div', { class: cls('pricingTable', 'atlas-pricing-table'), 'data-atlas': 'pricing-table' }, [
        hasAnnual
          ? h(
              'div',
              { role: 'group', 'aria-label': 'Billing interval', 'data-atlas': 'pricing-interval' },
              (['month', 'year'] as const).map((i) =>
                h('button', { key: i, type: 'button', class: cls('formButtonSecondary', 'atlas-button-secondary'), 'aria-pressed': s.interval === i, onClick: () => controller.setInterval(i) }, i === 'month' ? L.monthly : L.yearly),
              ),
            )
          : null,
        ...cards.map(({ plan, isAddon, isCurrent, heldSubscriptionId, view }) =>
          h('div', { key: plan.id, class: cls('card', 'atlas-card'), 'data-atlas': 'pricing-plan', 'data-current': isCurrent, 'data-kind': isAddon ? 'addon' : 'base' }, [
            h('h3', { class: cls('planName', 'atlas-plan-name') }, plan.name),
            plan.badge ? h('p', { 'data-atlas': 'pricing-badge', class: cls('badge', 'atlas-badge') }, plan.badge) : null,
            plan.description ? h('p', { 'data-atlas': 'pricing-description', class: cls('text', 'atlas-text') }, plan.description) : null,
            view.promotionLabel ? h('p', { 'data-atlas': 'pricing-promotion', class: cls('badge', 'atlas-badge') }, view.promotionLabel) : null,
            h('p', { class: cls('price', 'atlas-price') }, [
              view.originalPrice ? h('s', { 'data-atlas': 'pricing-original' }, view.originalPrice) : null,
              ' ',
              view.free ? L.free : view.price,
              view.free ? null : h('span', { class: cls('priceInterval', 'atlas-interval') }, ` / ${view.interval === 'year' ? L.perYear : L.perMonth}`),
            ]),
            view.trialDays ? h('p', { 'data-atlas': 'pricing-trial', class: cls('badge', 'atlas-badge') }, say(L.trial, 'days', view.trialDays)) : null,
            view.promotionCode ? h('p', { 'data-atlas': 'pricing-code', class: cls('text', 'atlas-text') }, say(L.useCode, 'code', view.promotionCode)) : null,
            plan.features.length ? h('ul', { class: cls('list', 'atlas-list') }, plan.features.map((f, i) => h('li', { key: i, class: cls('listItem', 'atlas-list-item') }, f))) : null,
            isCurrent
              ? h('button', { type: 'button', class: cls('formButtonPrimary', 'atlas-button'), 'data-atlas': 'manage-billing', onClick: () => void controller.openPortal(heldSubscriptionId ? { subscriptionId: heldSubscriptionId } : {}) }, L.manage)
              : h('button', { type: 'button', class: cls('formButtonPrimary', 'atlas-button'), disabled: status.value !== 'signed_in' || s.busyPlan === plan.id, onClick: () => void controller.choosePlan(plan) }, L.subscribe),
          ]),
        ),
        s.error ? h('p', { role: 'alert', class: 'atlas-alert' }, s.error) : null,
      ]);
    };
  },
});

/**
 * `<Invoices/>` — the subject's billing history: number, amount, status and a link to the provider's hosted
 * invoice. Renders an empty state when there are none.
 */
export const Invoices = defineComponent({
  name: 'Invoices',
  props: {
    orgId: { type: String, default: undefined },
    labels: { type: Object as PropType<BillingLabels>, default: () => ({}) },
  },
  setup(props) {
    const atlas = useAtlas();
    const { state } = useBilling({ orgId: props.orgId });
    const cls = (key: ElementKey, base: string) => classFor(key, atlas.appearance, base);
    return () => {
      const s = state.value;
      const L = { ...BILLING_LABELS, ...props.labels };
      if (!s.isLoaded) return h('div', { 'data-atlas': 'invoices', 'aria-busy': 'true' });
      return h('div', { class: cls('card', 'atlas-card'), 'data-atlas': 'invoices' }, [
        h('h3', { class: 'atlas-section-title' }, L.invoices),
        s.invoices.length === 0
          ? h('p', { class: cls('text', 'atlas-text'), 'data-atlas': 'invoices-empty' }, L.noInvoices)
          : h(
              'ul',
              { class: cls('list', 'atlas-list') },
              s.invoices.map((inv) =>
                h('li', { key: inv.id, class: cls('listItem', 'atlas-list-item'), 'data-atlas': 'invoice', 'data-status': inv.status }, [
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
    };
  },
});

/**
 * `<EmbeddedCheckout/>` — in-page checkout for a plan: the provider's own Embedded Checkout frame (its script
 * owns the card fields, no card data touches Atlas). When the instance has no embedded checkout it renders the
 * default slot, or a button that starts the hosted checkout.
 */
export const EmbeddedCheckout = defineComponent({
  name: 'EmbeddedCheckout',
  props: {
    planId: { type: String, required: true },
    orgId: { type: String, default: undefined },
    returnUrl: { type: String, default: undefined },
    /** A discount code the buyer entered (see `<Checkout/>`). */
    couponCode: { type: String, default: undefined },
    interval: { type: String as PropType<'month' | 'year'>, default: undefined },
    labels: { type: Object as PropType<BillingLabels>, default: () => ({}) },
  },
  setup(props, { slots }) {
    const client = useMeClient();
    const { controller } = useBilling({ orgId: props.orgId });
    const el = shallowRef<HTMLElement | null>(null);
    const outcome = shallowRef<Pick<EmbeddedCheckoutHandle, 'status' | 'error'> | null>(null);
    let handle: EmbeddedCheckoutHandle | null = null;
    let gone = false;

    onMounted(async () => {
      if (!el.value) return;
      const made = await mountEmbeddedCheckout(client, { planId: props.planId, orgId: props.orgId, returnUrl: props.returnUrl, couponCode: props.couponCode, interval: props.interval }, el.value, () => gone);
      handle = made;
      outcome.value = { status: made.status, error: made.error };
    });
    onBeforeUnmount(() => {
      gone = true;
      handle?.destroy();
    });

    return (): VNode => {
      const L = { ...BILLING_LABELS, ...props.labels };
      if (outcome.value?.status === 'unavailable')
        return slots.default
          ? h('div', slots.default())
          : h('button', { type: 'button', 'data-atlas': 'checkout-fallback', onClick: () => void controller.checkout({ planId: props.planId, orgId: props.orgId, couponCode: props.couponCode, interval: props.interval }) }, L.subscribe);
      return h('div', { 'data-atlas': 'embedded-checkout' }, [outcome.value?.status === 'error' ? h('p', { role: 'alert' }, outcome.value.error ?? L.checkoutFailed) : null, h('div', { ref: el })]);
    };
  },
});

/**
 * `<Checkout/>` — the step before payment for one plan: the plan and its price, a monthly/yearly choice when it
 * has an annual price, an optional discount code with a server-side "apply" check, and the way on to payment.
 * `embedded` mounts the in-page frame after "Continue"; otherwise the button redirects to the hosted page.
 */
export const Checkout = defineComponent({
  name: 'Checkout',
  props: {
    planId: { type: String, required: true },
    orgId: { type: String, default: undefined },
    embedded: { type: Boolean, default: false },
    returnUrl: { type: String, default: undefined },
    locale: { type: String, default: undefined },
    labels: { type: Object as PropType<BillingLabels & CheckoutLabels>, default: () => ({}) },
  },
  emits: ['started'],
  setup(props, { emit }) {
    const atlas = useAtlas();
    const { status } = useAuth();
    const { state: billing, controller: billingController } = useBilling({ orgId: props.orgId });
    const { state, controller } = useCheckoutStep(billingController, props.planId, {
      orgId: props.orgId,
      embedded: props.embedded,
      locale: props.locale,
      labels: props.labels,
      onStarted: (info) => emit('started', info),
    });
    const cls = (key: ElementKey, base: string) => classFor(key, atlas.appearance, base);
    return () => {
      const L = { ...BILLING_LABELS, ...CHECKOUT_LABELS, ...props.labels };
      if (!billing.value.isLoaded) return h('div', { 'data-atlas': 'checkout', 'aria-busy': 'true' });
      const plan = controller.plan();
      if (!plan) return h('div', { 'data-atlas': 'checkout', role: 'alert' }, L.planGone);
      const s = state.value;
      const pageLocale = props.locale ?? (typeof document !== 'undefined' ? document.documentElement.lang || undefined : undefined);
      const view = pricingCards({ plans: [plan], subscription: null, addons: [], interval: s.interval }, { locale: pageLocale }).cards[0]!.view;
      const signedIn = status.value === 'signed_in';
      return h('div', { class: cls('card', 'atlas-card'), 'data-atlas': 'checkout' }, [
        h('h3', { class: cls('planName', 'atlas-plan-name') }, plan.name),
        plan.badge ? h('p', { 'data-atlas': 'checkout-badge', class: cls('badge', 'atlas-badge') }, plan.badge) : null,
        plan.description ? h('p', { class: cls('text', 'atlas-text') }, plan.description) : null,
        plan.annual_available
          ? h(
              'div',
              { role: 'group', 'aria-label': 'Billing interval', 'data-atlas': 'checkout-interval' },
              (['month', 'year'] as const).map((i) =>
                h('button', { key: i, type: 'button', class: cls('formButtonSecondary', 'atlas-button-secondary'), 'aria-pressed': s.interval === i, disabled: s.started, onClick: () => controller.setInterval(i) }, i === 'month' ? L.monthly : L.yearly),
              ),
            )
          : null,
        h('p', { class: cls('price', 'atlas-price'), 'data-atlas': 'checkout-price' }, [view.originalPrice ? h('s', view.originalPrice) : null, ' ', view.free ? L.free : view.price]),
        s.started
          ? null
          : h('div', { 'data-atlas': 'checkout-coupon' }, [
              h('label', [
                L.code,
                ' ',
                h('input', { value: s.code, autocomplete: 'off', spellcheck: false, onInput: (e: Event) => controller.setCode((e.target as HTMLInputElement).value) }),
              ]),
              ' ',
              h('button', { type: 'button', class: cls('formButtonSecondary', 'atlas-button-secondary'), disabled: s.busy || !signedIn || !s.code.trim(), onClick: () => void controller.apply() }, L.apply),
              s.applied ? h('p', { role: 'status', 'data-atlas': 'checkout-coupon-applied' }, formatLabel(L.applied, { what: s.applied.text })) : null,
              s.problem ? h('p', { role: 'alert', 'data-atlas': 'checkout-coupon-problem' }, s.problem) : null,
            ]),
        s.started || signedIn ? null : h('p', { class: cls('text', 'atlas-text') }, L.signIn),
        s.started ? null : h('button', { type: 'button', class: cls('formButtonPrimary', 'atlas-button'), disabled: !signedIn, onClick: () => void controller.proceed() }, props.embedded ? L.continue : L.subscribe),
        s.started
          ? h(EmbeddedCheckout, { planId: props.planId, orgId: props.orgId, returnUrl: props.returnUrl, couponCode: s.applied?.code, interval: plan.annual_available ? s.interval : undefined })
          : null,
      ]);
    };
  },
});

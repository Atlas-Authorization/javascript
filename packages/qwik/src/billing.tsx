import { component$, noSerialize, useSignal, useVisibleTask$, type NoSerialize, type QRL, type Signal } from '@builder.io/qwik';
import {
  BILLING_LABELS,
  BillingController,
  CHECKOUT_LABELS,
  CheckoutController,
  UsageController,
  formatLabel,
  formatMoney,
  mountEmbeddedCheckout,
  pricingCards,
  type BillingLabels,
  type BillingState,
  type CheckoutLabels,
  type CheckoutState,
  type EmbeddedCheckoutHandle,
  type UsageState,
} from '@atlasauth/js';
import { useAtlas } from './context';
import { meClients } from './managed';

const INITIAL: BillingState = { isLoaded: false, plans: [], subscription: null, subscriptions: [], addons: [], invoices: [], paymentMethod: null, interval: 'month', busyPlan: null, error: null };

/** Qwik props must serialize, so labels here are templates with `{placeholders}` (no functions). */
export type PricingTableLabels = BillingLabels;

/** One billing controller per component, created client-side and reloaded as the auth status settles. */
function useBillingController(orgId: string | undefined) {
  const store = useAtlas();
  const controller = useSignal<NoSerialize<BillingController>>();
  const snap = useSignal<BillingState>(INITIAL);
  // eslint-disable-next-line qwik/no-use-visible-task -- the controller is a live object the optimizer must not resume.
  useVisibleTask$(({ track, cleanup }) => {
    const status = track(() => store.status);
    if (!controller.value) {
      const c = new BillingController(meClients(store).client, { orgId });
      controller.value = noSerialize(c);
      cleanup(c.subscribe((s) => (snap.value = s)));
    }
    if (status !== 'loading') void controller.value!.load(status === 'signed_in');
  });
  return { store, controller, snap };
}

/**
 * `<PricingTable>` — the instance's plans as cards: a locale-formatted price, features, a free-trial badge, a
 * monthly/yearly switch when a plan has an annual price, and a plan's promotion. The plan the subject is on is
 * marked current and its button opens the billing portal; a live base plan switches in place (prorated);
 * add-ons are bought alongside. `audience` shows only `user` or `org` plans.
 */
export const PricingTable = component$<{ orgId?: string; locale?: string; audience?: 'user' | 'org'; labels?: PricingTableLabels }>((props) => {
  const { store, controller, snap } = useBillingController(props.orgId);
  const s = snap.value;
  if (!s.isLoaded) return <div data-atlas="pricing-table" aria-busy="true" />;
  const l = { ...BILLING_LABELS, ...props.labels };
  const { cards, hasAnnual } = pricingCards(s, { audience: props.audience, locale: props.locale });
  return (
    <div class="atlas-pricing-table" data-atlas="pricing-table">
      {hasAnnual ? (
        <div role="group" aria-label="Billing interval" data-atlas="pricing-interval">
          <button type="button" class="atlas-button-secondary" aria-pressed={s.interval === 'month'} onClick$={() => controller.value?.setInterval('month')}>{l.monthly}</button>
          <button type="button" class="atlas-button-secondary" aria-pressed={s.interval === 'year'} onClick$={() => controller.value?.setInterval('year')}>{l.yearly}</button>
        </div>
      ) : null}
      {cards.map(({ plan, isAddon, isCurrent, heldSubscriptionId, view }) => (
        <div class="atlas-card" data-atlas="pricing-plan" data-current={isCurrent} data-kind={isAddon ? 'addon' : 'base'} key={plan.id}>
          <h3 class="atlas-plan-name">{plan.name}</h3>
          {plan.badge ? <p data-atlas="pricing-badge" class="atlas-badge">{plan.badge}</p> : null}
          {plan.description ? <p data-atlas="pricing-description" class="atlas-text">{plan.description}</p> : null}
          {view.promotionLabel ? <p data-atlas="pricing-promotion" class="atlas-badge">{view.promotionLabel}</p> : null}
          <p class="atlas-price">
            {view.originalPrice ? <s data-atlas="pricing-original">{view.originalPrice}</s> : null} {view.free ? l.free : view.price}
            {view.free ? null : <span class="atlas-interval"> / {view.interval === 'year' ? l.perYear : l.perMonth}</span>}
          </p>
          {view.trialDays ? <p data-atlas="pricing-trial" class="atlas-badge">{formatLabel(l.trial, { days: view.trialDays })}</p> : null}
          {view.promotionCode ? <p data-atlas="pricing-code" class="atlas-text">{formatLabel(l.useCode, { code: view.promotionCode })}</p> : null}
          {plan.features.length ? <ul class="atlas-list">{plan.features.map((f, i) => <li class="atlas-list-item" key={i}>{f}</li>)}</ul> : null}
          {isCurrent ? (
            <button type="button" class="atlas-button" data-atlas="manage-billing" onClick$={() => void controller.value?.openPortal(heldSubscriptionId ? { subscriptionId: heldSubscriptionId } : {})}>{l.manage}</button>
          ) : (
            <button type="button" class="atlas-button" disabled={store.status !== 'signed_in' || s.busyPlan === plan.id} onClick$={() => void controller.value?.choosePlan(plan)}>{l.subscribe}</button>
          )}
        </div>
      ))}
      {s.error ? <p role="alert" class="atlas-alert">{s.error}</p> : null}
    </div>
  );
});

/** `<Invoices>` — the subject's billing history: number, amount, status and a link to the hosted invoice. */
export const Invoices = component$<{ orgId?: string; labels?: BillingLabels }>((props) => {
  const { snap } = useBillingController(props.orgId);
  const s = snap.value;
  const l = { ...BILLING_LABELS, ...props.labels };
  if (!s.isLoaded) return <div data-atlas="invoices" aria-busy="true" />;
  return (
    <div class="atlas-card" data-atlas="invoices">
      <h3 class="atlas-section-title">{l.invoices}</h3>
      {s.invoices.length === 0 ? (
        <p class="atlas-text" data-atlas="invoices-empty">{l.noInvoices}</p>
      ) : (
        <ul class="atlas-list">
          {s.invoices.map((inv) => (
            <li class="atlas-list-item" data-atlas="invoice" data-status={inv.status} key={inv.id}>
              <span>{inv.number ?? inv.id}</span> <span>{formatMoney(inv.amount_paid || inv.amount_due, inv.currency)}</span> <span>{inv.status}</span>{' '}
              {inv.hosted_invoice_url ? <a class="atlas-link" href={inv.hosted_invoice_url} target="_blank" rel="noreferrer">{l.viewInvoice}</a> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

/**
 * `<EmbeddedCheckout>` — in-page checkout for a plan: the provider's own Embedded Checkout frame (its script
 * owns the card fields, no card data touches Atlas). When the instance has no embedded checkout it renders a
 * button that starts the hosted checkout.
 */
export const EmbeddedCheckout = component$<{ planId: string; orgId?: string; returnUrl?: string; couponCode?: string; interval?: 'month' | 'year'; labels?: BillingLabels }>((props) => {
  const store = useAtlas();
  const frame = useSignal<HTMLElement>();
  const outcome = useSignal<{ status: EmbeddedCheckoutHandle['status']; error?: string } | null>(null);
  const hosted = useSignal<NoSerialize<BillingController>>();

  // eslint-disable-next-line qwik/no-use-visible-task -- mounts the provider's frame, a live DOM object.
  useVisibleTask$(({ cleanup }) => {
    const { client } = meClients(store);
    hosted.value = noSerialize(new BillingController(client, { orgId: props.orgId }));
    let gone = false;
    let handle: EmbeddedCheckoutHandle | null = null;
    cleanup(() => {
      gone = true;
      handle?.destroy();
    });
    if (!frame.value) return;
    void mountEmbeddedCheckout(client, { planId: props.planId, orgId: props.orgId, returnUrl: props.returnUrl, couponCode: props.couponCode, interval: props.interval }, frame.value, () => gone).then((made) => {
      handle = made;
      outcome.value = { status: made.status, error: made.error };
    });
  });

  const l = { ...BILLING_LABELS, ...props.labels };
  if (outcome.value?.status === 'unavailable')
    return (
      <button type="button" data-atlas="checkout-fallback" onClick$={() => void hosted.value?.checkout({ planId: props.planId, orgId: props.orgId, couponCode: props.couponCode, interval: props.interval })}>{l.subscribe}</button>
    );
  return (
    <div data-atlas="embedded-checkout">
      {outcome.value?.status === 'error' ? <p role="alert">{outcome.value.error ?? l.checkoutFailed}</p> : null}
      <div ref={frame} />
    </div>
  );
});

const INITIAL_STEP: CheckoutState = { interval: 'month', code: '', applied: null, problem: null, busy: false, started: false };

/**
 * `<Checkout>` — the step before payment for one plan: the plan and its price, a monthly/yearly choice when it
 * has an annual price, an optional discount code with a server-side "apply" check, and the way on to payment.
 * `embedded` mounts the in-page frame after "Continue"; otherwise the button redirects to the hosted page.
 * `onStarted$` is a QRL, called when the buyer continues to payment.
 */
export const Checkout = component$<{
  planId: string;
  orgId?: string;
  embedded?: boolean;
  returnUrl?: string;
  locale?: string;
  labels?: BillingLabels & CheckoutLabels;
  onStarted$?: QRL<(info: { planId: string; couponCode?: string; interval: 'month' | 'year' }) => void>;
}>((props) => {
  const { store, controller, snap } = useBillingController(props.orgId);
  const stepper = useSignal<NoSerialize<CheckoutController>>();
  const step = useSignal<CheckoutState>(INITIAL_STEP);
  // eslint-disable-next-line qwik/no-use-visible-task -- the step controller is a live object the optimizer must not resume.
  useVisibleTask$(({ cleanup }) => {
    if (!controller.value || stepper.value) return;
    const c = new CheckoutController(controller.value, props.planId, {
      orgId: props.orgId,
      embedded: props.embedded,
      locale: props.locale,
      labels: props.labels,
      onStarted: (info) => void props.onStarted$?.(info),
    });
    stepper.value = noSerialize(c);
    cleanup(c.subscribe((s) => (step.value = s)));
  });
  const s = snap.value;
  const l = { ...BILLING_LABELS, ...CHECKOUT_LABELS, ...props.labels };
  if (!s.isLoaded) return <div data-atlas="checkout" aria-busy="true" />;
  const plan = s.plans.find((p) => p.id === props.planId);
  if (!plan) return <div data-atlas="checkout" role="alert">{l.planGone}</div>;
  const t = step.value;
  const view = pricingCards({ plans: [plan], subscription: null, addons: [], interval: t.interval }, { locale: props.locale }).cards[0]!.view;
  const signedIn = store.status === 'signed_in';
  return (
    <div class="atlas-card" data-atlas="checkout">
      <h3 class="atlas-plan-name">{plan.name}</h3>
      {plan.badge ? <p data-atlas="checkout-badge" class="atlas-badge">{plan.badge}</p> : null}
      {plan.description ? <p class="atlas-text">{plan.description}</p> : null}
      {plan.annual_available ? (
        <div role="group" aria-label="Billing interval" data-atlas="checkout-interval">
          <button type="button" class="atlas-button-secondary" aria-pressed={t.interval === 'month'} disabled={t.started} onClick$={() => stepper.value?.setInterval('month')}>{l.monthly}</button>
          <button type="button" class="atlas-button-secondary" aria-pressed={t.interval === 'year'} disabled={t.started} onClick$={() => stepper.value?.setInterval('year')}>{l.yearly}</button>
        </div>
      ) : null}
      <p class="atlas-price" data-atlas="checkout-price">
        {view.originalPrice ? <s>{view.originalPrice}</s> : null} {view.free ? l.free : view.price}
      </p>
      {t.started ? (
        <EmbeddedCheckout planId={props.planId} orgId={props.orgId} returnUrl={props.returnUrl} couponCode={t.applied?.code} interval={plan.annual_available ? t.interval : undefined} />
      ) : (
        <>
          <div data-atlas="checkout-coupon">
            <label>
              {l.code} <input value={t.code} autoComplete="off" spellcheck={false} onInput$={(_, el) => stepper.value?.setCode(el.value)} />
            </label>{' '}
            <button type="button" class="atlas-button-secondary" disabled={t.busy || !signedIn || !t.code.trim()} onClick$={() => void stepper.value?.apply()}>{l.apply}</button>
            {t.applied ? <p role="status" data-atlas="checkout-coupon-applied">{formatLabel(l.applied, { what: t.applied.text })}</p> : null}
            {t.problem ? <p role="alert" data-atlas="checkout-coupon-problem">{t.problem}</p> : null}
          </div>
          {signedIn ? null : <p class="atlas-text">{l.signIn}</p>}
          <button type="button" class="atlas-button" disabled={!signedIn} onClick$={() => void stepper.value?.proceed()}>{props.embedded ? l.continue : l.subscribe}</button>
        </>
      )}
    </div>
  );
});

/**
 * The subject's metered usage this billing period, for a "you have used N" display, as a signal that fills in
 * client-side and reloads as the auth status settles. For UI only; enforce on your server.
 * Call during component setup: `const usage = useUsage({ feature: 'calls' })`, then read `usage.value.total`.
 */
export function useUsage(options: { orgId?: string; feature?: string } = {}): Signal<UsageState> {
  const store = useAtlas();
  const snap = useSignal<UsageState>({ isLoaded: false, total: null, since: null });
  // eslint-disable-next-line qwik/no-use-visible-task -- the controller is a live object the optimizer must not resume.
  useVisibleTask$(({ track, cleanup }) => {
    const status = track(() => store.status);
    const c = new UsageController(meClients(store).client, options);
    cleanup(c.subscribe((s) => (snap.value = s)));
    if (status !== 'loading') void c.load(status === 'signed_in');
  });
  return snap;
}

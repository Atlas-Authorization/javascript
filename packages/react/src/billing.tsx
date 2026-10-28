'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatMoney, planPriceView, type PublicBillingPlan } from '@atlasauth/js';
import { useAtlas } from './AtlasProvider';
import { currentUrl, navigateTo, useClass, useClasses, useErrorText, useMeClient, useText } from './components-shared';
import type {
  AtlasBillingInvoice,
  AtlasBillingPlan,
  AtlasBillingSubscription,
  AtlasFeatureCheck,
  AtlasPaymentMethod,
} from './types';

/**
 * §commerce (Clerk commerce). A thin, HONEST SDK surface over the REAL
 * Stripe-backed billing API (`/v1/client/billing/*`): list plans, read the
 * subject's subscription, and start a Checkout Session or open the Billing
 * Portal — both of which the server issues as real Stripe-hosted URLs the
 * caller is redirected to. There is deliberately NO in-page card form: taking
 * card details would need a PCI-scoped Stripe Elements integration, and faking
 * one would be a lie. Redirect-to-Checkout is the same posture Stripe itself
 * recommends for most apps.
 */
export interface CheckoutParams {
  /** The plan to buy. */
  planId: string;
  /** Buy for an organization (its admin) rather than for the user. */
  orgId?: string;
  /** Where Stripe returns on success / cancel. Defaults to the current URL. */
  successUrl?: string;
  cancelUrl?: string;
  /** Redirect to the Checkout URL (default true). False → the URL is only returned. */
  redirect?: boolean;
  /** Start on the plan's yearly price (when it has one). */
  interval?: 'month' | 'year';
}

export interface ChangePlanParams {
  planId: string;
  interval?: 'month' | 'year';
  /** Switch when the current period ends instead of now (prorated). */
  atPeriodEnd?: boolean;
  orgId?: string;
  /** Change this subscription (e.g. one add-on) instead of the primary one. */
  subscriptionId?: string;
}

/** The statuses in which a subscription is still running. */
const LIVE_STATUSES = ['active', 'trialing', 'past_due'];

/**
 * Where a change / cancel / restore goes: one subscription by id, or (no id)
 * the subject's primary subscription — the single-subscription behaviour.
 */
export function manageUrl(action: 'change' | 'cancel' | 'restore', subscriptionId?: string): string {
  return subscriptionId
    ? `/v1/client/billing/subscriptions/${encodeURIComponent(subscriptionId)}/${action}`
    : `/v1/client/billing/subscription/${action}`;
}

/**
 * Every subscription from the subject read: the server's `subscriptions[]`, or
 * — from a server that predates several subscriptions — the one it reports.
 */
export function subscriptionsOf(read: AtlasBillingSubscription | null | undefined): AtlasBillingSubscription[] {
  if (!read) return [];
  if (Array.isArray(read.subscriptions)) return read.subscriptions;
  return read.status !== null ? [read] : [];
}

/** The live add-on subscriptions among a subject's subscriptions. */
export function liveAddonsOf(subscriptions: AtlasBillingSubscription[]): AtlasBillingSubscription[] {
  return subscriptions.filter((s) => s.plan?.kind === 'addon' && LIVE_STATUSES.includes(String(s.status ?? '')));
}

/**
 * §commerce headless billing (Clerk `useCheckout`/subscription hooks combined).
 * Loads the instance's plans and — when signed in — the subject's subscription,
 * and exposes `checkout()` and `openPortal()`. Pass `{ orgId }` to operate on an
 * organization the user administers instead of on the user.
 */
export function useBilling(opts: { orgId?: string } = {}) {
  const { status } = useAtlas();
  const client = useMeClient();
  const orgId = opts.orgId;

  const [plans, setPlans] = useState<AtlasBillingPlan[]>([]);
  const [subscription, setSubscription] = useState<AtlasBillingSubscription | null>(null);
  const [subscriptions, setSubscriptions] = useState<AtlasBillingSubscription[]>([]);
  const [invoices, setInvoices] = useState<AtlasBillingInvoice[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<AtlasPaymentMethod | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  const reload = useCallback(async () => {
    const orgQuery = orgId ? `?org_id=${encodeURIComponent(orgId)}` : '';
    const plansRes = await client.get<{ object: string; data: AtlasBillingPlan[] }>(
      '/v1/client/billing/plans',
    );
    if (plansRes.ok && plansRes.data) setPlans(plansRes.data.data ?? []);
    // Subscription, invoices and payment method are subject-scoped — signed in only.
    if (status === 'signed_in') {
      const [subRes, invRes, pmRes] = await Promise.all([
        client.get<AtlasBillingSubscription>(`/v1/client/billing/subscription${orgQuery}`),
        client.get<{ data: AtlasBillingInvoice[] }>(`/v1/client/billing/invoices${orgQuery}`),
        client.get<{ payment_method: AtlasPaymentMethod | null }>(
          `/v1/client/billing/payment_method${orgQuery}`,
        ),
      ]);
      if (subRes.ok) {
        setSubscription(subRes.data ?? null);
        // Every subscription the subject holds (base + add-ons); an older server
        // without the list reports just the one.
        setSubscriptions(subscriptionsOf(subRes.data));
      }
      if (invRes.ok && invRes.data) setInvoices(invRes.data.data ?? []);
      if (pmRes.ok) setPaymentMethod(pmRes.data?.payment_method ?? null);
    } else {
      setSubscription(null);
      setSubscriptions([]);
      setInvoices([]);
      setPaymentMethod(null);
    }
    setIsLoaded(true);
  }, [client, status, orgId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const checkout = useCallback(
    async (params: CheckoutParams) => {
      const res = await client.post<{ url: string }>('/v1/client/billing/checkout', {
        plan_id: params.planId,
        org_id: params.orgId ?? orgId,
        success_url: params.successUrl ?? currentUrl(),
        cancel_url: params.cancelUrl ?? currentUrl(),
        ...(params.interval ? { interval: params.interval } : {}),
      });
      if (res.ok && res.data?.url && params.redirect !== false) navigateTo(res.data.url);
      return res;
    },
    [client, orgId],
  );

  const openPortal = useCallback(
    async (params: { returnUrl?: string; orgId?: string; redirect?: boolean; subscriptionId?: string } = {}) => {
      const res = await client.post<{ url: string }>('/v1/client/billing/portal', {
        org_id: params.orgId ?? orgId,
        return_url: params.returnUrl ?? currentUrl(),
        // The portal of that subscription's provider (default: the primary one's).
        ...(params.subscriptionId ? { subscription_id: params.subscriptionId } : {}),
      });
      if (res.ok && res.data?.url && params.redirect !== false) navigateTo(res.data.url);
      return res;
    },
    [client, orgId],
  );

  /** Switch a live subscription to another plan or interval (no checkout needed). */
  const changePlan = useCallback(
    async (params: ChangePlanParams) => {
      const res = await client.post<AtlasBillingSubscription>(manageUrl('change', params.subscriptionId), {
        plan_id: params.planId,
        org_id: params.orgId ?? orgId,
        ...(params.interval ? { interval: params.interval } : {}),
        schedule_at_period_end: params.atPeriodEnd === true,
      });
      if (res.ok) await reload();
      return res;
    },
    [client, orgId, reload],
  );

  /** Cancel at the end of the period (default), or now with `{ immediately: true }`. */
  const cancel = useCallback(
    async (params: { immediately?: boolean; orgId?: string; subscriptionId?: string } = {}) => {
      const res = await client.post<AtlasBillingSubscription>(manageUrl('cancel', params.subscriptionId), {
        org_id: params.orgId ?? orgId,
        immediately: params.immediately === true,
      });
      if (res.ok) await reload();
      return res;
    },
    [client, orgId, reload],
  );

  /** Undo a cancellation scheduled for the end of the period. */
  const restore = useCallback(
    async (params: { orgId?: string; subscriptionId?: string } = {}) => {
      const res = await client.post<AtlasBillingSubscription>(manageUrl('restore', params.subscriptionId), {
        org_id: params.orgId ?? orgId,
      });
      if (res.ok) await reload();
      return res;
    },
    [client, orgId, reload],
  );

  /**
   * May the subject use `feature` (needing `required` units)? Asked live of an
   * entitlement provider (Autumn, Commet) when the subject is on one, else from
   * the resolved entitlement. For UI only — gate on the server or the token.
   */
  const check = useCallback(
    async (feature: string, params: { required?: number; orgId?: string } = {}) => {
      const q = new URLSearchParams({ feature });
      if (params.required !== undefined) q.set('required', String(params.required));
      const org = params.orgId ?? orgId;
      if (org) q.set('org_id', org);
      return client.get<AtlasFeatureCheck>(`/v1/client/billing/check?${q.toString()}`);
    },
    [client, orgId],
  );

  /** The live add-on subscriptions (everything beyond the primary one). */
  const addons = liveAddonsOf(subscriptions);

  return {
    isLoaded,
    plans,
    subscription,
    subscriptions,
    addons,
    invoices,
    paymentMethod,
    checkout,
    openPortal,
    changePlan,
    cancel,
    restore,
    check,
    reload,
  };
}

/** §commerce Clerk-parity alias — just the `checkout` action from {@link useBilling}. */
export function useCheckout(opts: { orgId?: string } = {}) {
  const { checkout } = useBilling(opts);
  return { checkout };
}

/** §commerce Clerk-parity alias — the subject's subscription from {@link useBilling}. */
export function useSubscription(opts: { orgId?: string } = {}) {
  const { isLoaded, subscription, subscriptions, addons, openPortal, changePlan, cancel, restore, reload } = useBilling(opts);
  return { isLoaded, subscription, subscriptions, addons, openPortal, changePlan, cancel, restore, reload };
}

/** §commerce Clerk-parity alias — the subject's invoices from {@link useBilling}. */
export function useInvoices(opts: { orgId?: string } = {}) {
  const { isLoaded, invoices, reload } = useBilling(opts);
  return { isLoaded, invoices, reload };
}

/** §commerce Clerk-parity alias — the subject's default payment method + Portal to change it. */
export function usePaymentMethods(opts: { orgId?: string } = {}) {
  const { isLoaded, paymentMethod, openPortal, reload } = useBilling(opts);
  return { isLoaded, paymentMethod, openPortal, reload };
}

/** Format a minor-unit amount (cents) as a currency string, best-effort. */
const formatPrice = (amount: number, currency: string): string => formatMoney(amount, currency);

/** English defaults for the strings `<PricingTable>` adds beyond the localized commerce keys. */
const PRICING_LABELS = {
  monthly: 'Monthly',
  yearly: 'Yearly',
  perMonth: 'month',
  perYear: 'year',
  free: 'Free',
  trial: (days: number) => `${days}-day free trial`,
  useCode: (code: string) => `Use code ${code} at checkout`,
};
export type PricingLabels = Partial<typeof PRICING_LABELS>;

/**
 * §commerce (Clerk `<PricingTable>`). Renders the instance's plans as cards with
 * a locale-formatted price, features and a subscribe button that starts a real
 * provider Checkout. Shows a free-trial badge, a monthly/yearly switch when a
 * plan has an annual price, and a plan's promotion (label, struck-through price,
 * the code to enter at checkout). The plan the subject is on is marked current
 * (its button opens the Billing Portal instead).
 *
 * `locale` defaults to the page language; `labels` overrides the English text
 * this component adds (the subscribe / manage buttons stay localized as before).
 * `audience` shows only user or organization plans (default: every plan).
 */
export function PricingTable({
  orgId,
  locale,
  labels = {},
  audience,
}: { orgId?: string; locale?: string; labels?: PricingLabels; audience?: 'user' | 'org' } = {}) {
  const { isLoaded, plans, subscription, subscriptions, checkout, openPortal, changePlan } = useBilling({ orgId });
  const { status } = useAtlas();
  const t = useText();
  const L = { ...PRICING_LABELS, ...labels };

  const cardClass = useClass('card', 'atlas-card');
  const buttonClass = useClass('formButtonPrimary', 'atlas-button');
  const cls = useClasses();

  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [interval, setIntervalChoice] = useState<'month' | 'year'>('month');
  const currentPlanId = subscription?.plan?.id ?? null;
  // A subject with a live BASE subscription switches base plans in place
  // (prorated) instead of a second checkout; add-ons are bought alongside.
  const live = LIVE_STATUSES.includes(String(subscription?.status ?? '')) && subscription?.plan?.kind !== 'addon';
  const heldAddons = new Map(liveAddonsOf(subscriptions).map((s) => [s.plan!.id, s]));
  const pageLocale = locale ?? (typeof document !== 'undefined' ? document.documentElement.lang || undefined : undefined);

  if (!isLoaded) return <div data-atlas="pricing-table" aria-busy="true" />;

  const shown = audience ? plans.filter((p) => p.audience === audience) : plans;
  const hasAnnual = shown.some((p) => p.annual_available);

  return (
    <div className={cls('pricingTable', 'atlas-pricing-table')} data-atlas="pricing-table">
      {hasAnnual ? (
        <div role="group" aria-label="Billing interval" data-atlas="pricing-interval">
          {(['month', 'year'] as const).map((i) => (
            <button
              key={i}
              type="button"
              className={cls('formButtonSecondary', 'atlas-button-secondary')}
              aria-pressed={interval === i}
              onClick={() => setIntervalChoice(i)}
            >
              {i === 'month' ? L.monthly : L.yearly}
            </button>
          ))}
        </div>
      ) : null}
      {shown.map((plan) => {
        const isAddon = plan.kind === 'addon';
        const held = isAddon ? heldAddons.get(plan.id) : undefined;
        const isCurrent = isAddon ? Boolean(held) : plan.id === currentPlanId;
        const view = planPriceView(plan as PublicBillingPlan, { interval, locale: pageLocale });
        return (
          <div
            key={plan.id}
            className={cardClass}
            data-atlas="pricing-plan"
            data-current={isCurrent}
            data-kind={isAddon ? 'addon' : 'base'}
          >
            <h3 className={cls('planName', 'atlas-plan-name')}>{plan.name}</h3>
            {view.promotionLabel ? <p data-atlas="pricing-promotion" className={cls('badge', 'atlas-badge')}>{view.promotionLabel}</p> : null}
            <p className={cls('price', 'atlas-price')}>
              {view.originalPrice ? <s data-atlas="pricing-original">{view.originalPrice}</s> : null}{' '}
              {view.free ? L.free : view.price}
              {view.free ? null : (
                <span className={cls('priceInterval', 'atlas-interval')}> / {view.interval === 'year' ? L.perYear : L.perMonth}</span>
              )}
            </p>
            {view.trialDays ? <p data-atlas="pricing-trial" className={cls('badge', 'atlas-badge')}>{L.trial(view.trialDays)}</p> : null}
            {view.promotionCode ? <p data-atlas="pricing-code" className={cls('text', 'atlas-text')}>{L.useCode(view.promotionCode)}</p> : null}
            {plan.features.length ? (
              <ul className={cls('list', 'atlas-list')}>
                {plan.features.map((f, i) => (
                  <li className={cls('listItem', 'atlas-list-item')} key={i}>{f}</li>
                ))}
              </ul>
            ) : null}
            {isCurrent ? (
              <button
                type="button"
                className={buttonClass}
                data-atlas="manage-billing"
                onClick={() => void openPortal(held?.id ? { subscriptionId: held.id } : {})}
              >
                {t('commerce.manage')}
              </button>
            ) : (
              <button
                type="button"
                className={buttonClass}
                disabled={status !== 'signed_in' || busyPlan === plan.id}
                onClick={() => {
                  setBusyPlan(plan.id);
                  const action =
                    !isAddon && live && currentPlanId
                      ? changePlan({ planId: plan.id })
                      : checkout({ planId: plan.id, ...(plan.annual_available ? { interval } : {}) });
                  void action.finally(() => setBusyPlan(null));
                }}
              >
                {t('commerce.subscribe')}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * §commerce (Clerk `<Invoices>`). The subject's billing history — number, status,
 * amount, and a link to Stripe's hosted invoice / PDF. Renders nothing until
 * loaded, and an empty state when there are no invoices yet.
 */
export function Invoices({ orgId }: { orgId?: string } = {}) {
  const { isLoaded, invoices } = useInvoices({ orgId });
  const t = useText();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();

  if (!isLoaded) return <div data-atlas="invoices" aria-busy="true" />;

  return (
    <div className={cardClass} data-atlas="invoices">
      <h3 className={cls('sectionTitle', 'atlas-section-title')}>{t('commerce.invoices')}</h3>
      {invoices.length === 0 ? (
        <p className={cls('text', 'atlas-text')} data-atlas="invoices-empty">{t('commerce.noInvoices')}</p>
      ) : (
        <ul className={cls('list', 'atlas-list')}>
          {invoices.map((inv) => (
            <li className={cls('listItem', 'atlas-list-item')} key={inv.id} data-atlas="invoice" data-status={inv.status}>
              <span>{inv.number ?? inv.id}</span>{' '}
              <span>{formatPrice(inv.amount_paid || inv.amount_due, inv.currency)}</span>{' '}
              <span>{inv.status}</span>{' '}
              {inv.hosted_invoice_url ? (
                <a className={cls('link', 'atlas-link')} href={inv.hosted_invoice_url} target="_blank" rel="noreferrer">
                  {t('commerce.viewInvoice')}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Lazily inject Stripe.js once and resolve the global `Stripe` factory. */
let stripeJsPromise: Promise<unknown> | null = null;
function loadStripeJs(): Promise<unknown> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  const w = window as unknown as { Stripe?: unknown };
  if (w.Stripe) return Promise.resolve(w.Stripe);
  if (stripeJsPromise) return stripeJsPromise;
  stripeJsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://js.stripe.com/v3';
    script.async = true;
    script.onload = () => resolve((window as unknown as { Stripe?: unknown }).Stripe ?? null);
    script.onerror = () => reject(new Error('Failed to load Stripe.js'));
    document.head.appendChild(script);
  });
  return stripeJsPromise;
}

/**
 * §commerce (Clerk `<EmbeddedCheckout>`). In-page checkout for a plan: mounts
 * Stripe's own Embedded Checkout iframe — Stripe.js owns the card fields, so no
 * PCI-scoped data ever touches Atlas. Fetches the instance's Stripe publishable
 * key from `/billing/config`; when embedded checkout is not configured it renders
 * `fallback` (default: a hosted-redirect button) rather than a broken frame.
 */
export function EmbeddedCheckout({
  planId,
  orgId,
  returnUrl,
  fallback,
}: {
  planId: string;
  orgId?: string;
  /** Where Stripe returns after the in-page flow (defaults to the current URL). */
  returnUrl?: string;
  /** Rendered when embedded checkout is unavailable (no publishable key). */
  fallback?: ReactNode;
}) {
  const client = useMeClient();
  const { checkout } = useBilling({ orgId });
  const t = useText();
  const errorText = useErrorText();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let embedded: { unmount: () => void; destroy: () => void } | null = null;

    void (async () => {
      // 1) Is embedded checkout configured on this instance?
      const cfg = await client.get<{ stripe_publishable_key: string | null; embedded: boolean }>(
        '/v1/client/billing/config',
      );
      const pk = cfg.ok ? cfg.data?.stripe_publishable_key : null;
      if (!pk) {
        if (!cancelled) setUnavailable(true);
        return;
      }
      // 2) Create an embedded Checkout Session → client_secret.
      const res = await client.post<{ client_secret: string | null }>(
        '/v1/client/billing/checkout',
        {
          plan_id: planId,
          org_id: orgId,
          ui_mode: 'embedded',
          return_url: returnUrl ?? currentUrl(),
        },
      );
      if (!res.ok || !res.data?.client_secret) {
        if (!cancelled) setError(res.errors[0] ? errorText(res.errors[0]) : t('error.generic'));
        return;
      }
      // 3) Mount Stripe's Embedded Checkout.
      const factory = (await loadStripeJs()) as
        | ((key: string) => {
            initEmbeddedCheckout: (opts: {
              clientSecret: string;
            }) => Promise<{ mount: (el: HTMLElement) => void; unmount: () => void; destroy: () => void }>;
          })
        | null;
      if (!factory || cancelled) return;
      const stripe = factory(pk);
      const instance = await stripe.initEmbeddedCheckout({ clientSecret: res.data.client_secret });
      if (cancelled) {
        instance.destroy();
        return;
      }
      embedded = instance;
      if (containerRef.current) instance.mount(containerRef.current);
    })();

    return () => {
      cancelled = true;
      try {
        embedded?.destroy();
      } catch {
        /* already gone */
      }
    };
    // planId/orgId/returnUrl identify the session to create; client is stable.
  }, [client, planId, orgId, returnUrl, t, errorText]);

  if (unavailable) {
    return (
      <>
        {fallback ?? (
          <button
            type="button"
            data-atlas="checkout-fallback"
            onClick={() => void checkout({ planId, orgId })}
          >
            {t('commerce.subscribe')}
          </button>
        )}
      </>
    );
  }

  return (
    <div data-atlas="embedded-checkout">
      {error ? <p role="alert">{error}</p> : null}
      <div ref={containerRef} />
    </div>
  );
}

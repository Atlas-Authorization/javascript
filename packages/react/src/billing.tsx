'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAtlas } from './AtlasProvider';
import { currentUrl, navigateTo, useClass, useClasses, useErrorText, useMeClient, useText } from './components-shared';
import type {
  AtlasBillingInvoice,
  AtlasBillingPlan,
  AtlasBillingSubscription,
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
      if (subRes.ok) setSubscription(subRes.data ?? null);
      if (invRes.ok && invRes.data) setInvoices(invRes.data.data ?? []);
      if (pmRes.ok) setPaymentMethod(pmRes.data?.payment_method ?? null);
    } else {
      setSubscription(null);
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
      });
      if (res.ok && res.data?.url && params.redirect !== false) navigateTo(res.data.url);
      return res;
    },
    [client, orgId],
  );

  const openPortal = useCallback(
    async (params: { returnUrl?: string; orgId?: string; redirect?: boolean } = {}) => {
      const res = await client.post<{ url: string }>('/v1/client/billing/portal', {
        org_id: params.orgId ?? orgId,
        return_url: params.returnUrl ?? currentUrl(),
      });
      if (res.ok && res.data?.url && params.redirect !== false) navigateTo(res.data.url);
      return res;
    },
    [client, orgId],
  );

  return { isLoaded, plans, subscription, invoices, paymentMethod, checkout, openPortal, reload };
}

/** §commerce Clerk-parity alias — just the `checkout` action from {@link useBilling}. */
export function useCheckout(opts: { orgId?: string } = {}) {
  const { checkout } = useBilling(opts);
  return { checkout };
}

/** §commerce Clerk-parity alias — the subject's subscription from {@link useBilling}. */
export function useSubscription(opts: { orgId?: string } = {}) {
  const { isLoaded, subscription, openPortal, reload } = useBilling(opts);
  return { isLoaded, subscription, openPortal, reload };
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
function formatPrice(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/**
 * §commerce (Clerk `<PricingTable>`). Renders the instance's plans as cards with
 * price + features and a subscribe button that starts a real Stripe Checkout.
 * The plan the subject is currently on is marked as current (its button is
 * disabled and an "Manage billing" action opens the Billing Portal instead).
 */
export function PricingTable({ orgId }: { orgId?: string } = {}) {
  const { isLoaded, plans, subscription, checkout, openPortal } = useBilling({ orgId });
  const { status } = useAtlas();
  const t = useText();

  const cardClass = useClass('card', 'atlas-card');
  const buttonClass = useClass('formButtonPrimary', 'atlas-button');
  const cls = useClasses();

  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const currentPlanId = subscription?.plan?.id ?? null;

  if (!isLoaded) return <div data-atlas="pricing-table" aria-busy="true" />;

  return (
    <div className={cls('pricingTable', 'atlas-pricing-table')} data-atlas="pricing-table">
      {plans.map((plan) => {
        const isCurrent = plan.id === currentPlanId;
        return (
          <div key={plan.id} className={cardClass} data-atlas="pricing-plan" data-current={isCurrent}>
            <h3 className={cls('planName', 'atlas-plan-name')}>{plan.name}</h3>
            <p className={cls('price', 'atlas-price')}>
              {formatPrice(plan.amount, plan.currency)}
              <span className={cls('priceInterval', 'atlas-interval')}> / {plan.interval}</span>
            </p>
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
                onClick={() => void openPortal()}
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
                  void checkout({ planId: plan.id }).finally(() => setBusyPlan(null));
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

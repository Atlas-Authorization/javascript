import { listPublicPlans, planPriceView, startPlanCheckout, type PublicBillingPlan } from '@atlasauth/js';
import { createClient } from './client';
import { getScriptDefaults } from './config';
import type { MountTarget } from './mount';

export interface PricingTableOptions {
  publishableKey?: string;
  frontendApi?: string;
  /** `user` or `org` plans only (default: every plan). */
  audience?: 'user' | 'org';
  /** An organization to buy for (its admin). */
  organizationId?: string;
  /** Currency formatting language; default the page's. */
  locale?: string;
  /** Where the provider returns on success (default the current page). */
  successUrl?: string;
  /** Replace the English text the table adds. */
  labels?: Partial<{ monthly: string; yearly: string; perMonth: string; perYear: string; free: string; subscribe: string; trial: (days: number) => string; useCode: (code: string) => string }>;
  fetchImpl?: typeof fetch;
  /** Navigate to the Checkout URL (default `location.assign`). */
  navigate?: (url: string) => void;
  /** Called when checkout cannot start (not signed in, provider error). */
  onError?: (message: string) => void;
}

const h = (tag: string, props: Record<string, string> = {}, ...kids: Array<HTMLElement | string | null>): HTMLElement => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) node.setAttribute(k, v);
  for (const kid of kids) if (kid !== null) node.append(kid);
  return node;
};

/**
 * Mount the instance's pricing table into an element: locale-formatted prices, a
 * free-trial badge, a monthly/yearly switch when a plan has an annual price, and a
 * plan's promotion (label, struck-through price, code to use at checkout). The
 * subscribe button starts the provider's hosted Checkout for the signed-in visitor.
 */
export function mountPricingTable(target: MountTarget, options: PricingTableOptions = {}): { destroy(): void } | null {
  const host = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : (target as HTMLElement);
  const defaults = getScriptDefaults();
  const publishableKey = options.publishableKey ?? defaults.publishableKey;
  const frontendApi = options.frontendApi ?? defaults.frontendApi;
  if (!host) return null;
  if (!publishableKey || !frontendApi) {
    host.textContent = 'Atlas: a publishable key and a frontend API origin are required.';
    return null;
  }
  const client = createClient({ publishableKey, frontendApi, locale: options.locale ?? defaults.locale, fetchImpl: options.fetchImpl });
  const L = {
    monthly: 'Monthly', yearly: 'Yearly', perMonth: 'month', perYear: 'year', free: 'Free', subscribe: 'Subscribe',
    trial: (d: number) => `${d}-day free trial`, useCode: (c: string) => `Use code ${c} at checkout`,
    ...options.labels,
  };
  const locale = options.locale ?? (document.documentElement.lang || undefined);
  let interval: 'month' | 'year' = 'month';
  let plans: PublicBillingPlan[] = [];
  let alive = true;

  const render = () => {
    if (!alive) return;
    const children: HTMLElement[] = [];
    if (plans.some((p) => p.annual_available)) {
      const group = h('div', { role: 'group', 'aria-label': 'Billing interval', 'data-atlas': 'pricing-interval' });
      for (const i of ['month', 'year'] as const) {
        const b = h('button', { type: 'button', class: 'atlas-button-secondary', 'aria-pressed': String(interval === i) }, i === 'month' ? L.monthly : L.yearly);
        b.addEventListener('click', () => {
          interval = i;
          render();
        });
        group.append(b);
      }
      children.push(group);
    }
    for (const plan of plans) {
      const view = planPriceView(plan, { interval, locale });
      const price = h('p', { class: 'atlas-price' });
      if (view.originalPrice) price.append(h('s', { 'data-atlas': 'pricing-original' }, view.originalPrice), ' ');
      price.append(view.free ? L.free : view.price);
      if (!view.free) price.append(h('span', { class: 'atlas-interval' }, ` / ${view.interval === 'year' ? L.perYear : L.perMonth}`));
      const button = h('button', { type: 'button', class: 'atlas-button' }, L.subscribe);
      button.addEventListener('click', async () => {
        const out = await startPlanCheckout(client, {
          planId: plan.id,
          orgId: options.organizationId,
          ...(plan.annual_available ? { interval } : {}),
          successUrl: options.successUrl ?? window.location.href,
        });
        if (out.url) (options.navigate ?? ((u: string) => window.location.assign(u)))(out.url);
        else options.onError?.(out.error ?? 'Could not start checkout.');
      });
      children.push(
        h(
          'div',
          { class: 'atlas-card', 'data-atlas': 'pricing-plan' },
          h('h3', { class: 'atlas-plan-name' }, plan.name),
          view.promotionLabel ? h('p', { 'data-atlas': 'pricing-promotion', class: 'atlas-badge' }, view.promotionLabel) : null,
          price,
          view.trialDays ? h('p', { 'data-atlas': 'pricing-trial', class: 'atlas-badge' }, L.trial(view.trialDays)) : null,
          view.promotionCode ? h('p', { 'data-atlas': 'pricing-code' }, L.useCode(view.promotionCode)) : null,
          plan.features.length ? h('ul', { class: 'atlas-list' }, ...plan.features.map((f) => h('li', {}, f))) : null,
          button,
        ),
      );
    }
    host.dataset.atlas = 'pricing-table';
    host.replaceChildren(...children);
  };

  void listPublicPlans(client, { audience: options.audience }).then((list) => {
    plans = list;
    render();
  });
  return {
    destroy() {
      alive = false;
      host.replaceChildren();
    },
  };
}

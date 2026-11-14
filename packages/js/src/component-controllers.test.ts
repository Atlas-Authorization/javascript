import { describe, expect, it, vi } from 'vitest';
import {
  ApiKeysController,
  BillingController,
  DeviceAuthorizationController,
  ReverificationGate,
  REVERIFICATION_CANCELLED,
  apiKeyStatus,
  apiKeysAtCap,
  formatLabel,
  pricingCards,
  type BillingPlan,
} from './component-controllers';
import type { FapiClient } from './fapi';

const reauth = { api: 'https://fapi.test', publishableKey: 'pk_test_x', fetchImpl: vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch };
const ok = <T>(data: T) => ({ ok: true, status: 200, data, errors: [] });
const fail = (status: number, code: string, message = 'nope') => ({ ok: false, status, data: null, errors: [{ code, message }] });

describe('formatLabel', () => {
  it('fills known parameters and leaves unknown ones', () => {
    expect(formatLabel('In {days} days {x}', { days: 3 })).toBe('In 3 days {x}');
  });
});

describe('ReverificationGate', () => {
  it('parks a step-up, retries once after complete, and rejects on cancel', async () => {
    const changes: boolean[] = [];
    const gate = new ReverificationGate(reauth, (n) => changes.push(n));
    let calls = 0;
    const parked = gate.run(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('stale'), { code: 'STEP_UP_REQUIRED' });
      return 'done';
    });
    await vi.waitFor(() => expect(changes).toEqual([true]));
    await gate.complete({ strategy: 'password', password: 'pw' });
    await expect(parked).resolves.toBe('done');
    expect(changes).toEqual([true, false]);

    const cancelled = gate.run(async () => {
      throw Object.assign(new Error('stale'), { code: 'STEP_UP_REQUIRED' });
    });
    await vi.waitFor(() => expect(changes.at(-1)).toBe(true));
    gate.cancel();
    await expect(cancelled).rejects.toThrow(REVERIFICATION_CANCELLED);
  });

  it('keeps the action parked when the credential is wrong', async () => {
    const bad = { ...reauth, fetchImpl: (async () => new Response(JSON.stringify({ errors: [{ message: 'wrong' }] }), { status: 401 })) as unknown as typeof fetch };
    const gate = new ReverificationGate(bad, () => {});
    const parked = gate.run(async () => {
      throw Object.assign(new Error('stale'), { code: 'STEP_UP_REQUIRED' });
    });
    parked.catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    await expect(gate.complete({ strategy: 'password', password: 'x' })).rejects.toThrow();
    gate.cancel();
  });
});

describe('ApiKeysController', () => {
  const list = { data: [], allowed_scopes: ['a:read'], allowed_claims: [], scope_implications: {}, max_active_keys: 2, active_count: 2 };

  it('loads, and treats a 403 list as disabled', async () => {
    const client = { request: vi.fn(async () => ok(list)) } as unknown as FapiClient;
    const c = new ApiKeysController(client, reauth);
    await c.load();
    expect(c.getState().status).toBe('ready');
    expect(apiKeysAtCap(c.getState())).toBe(true);

    const off = new ApiKeysController({ request: vi.fn(async () => fail(403, 'FORBIDDEN')) } as unknown as FapiClient, reauth);
    await off.load();
    expect(off.getState().status).toBe('disabled');
  });

  it('holds the one-time secret until dismissed', async () => {
    const request = vi.fn(async (_p: string, init?: RequestInit) => (init?.method === 'POST' ? ok({ id: 'k1', secret: 'ak_secret', prefix: 'ak_x' }) : ok(list)));
    const c = new ApiKeysController({ request } as unknown as FapiClient, reauth, { organizationId: 'org_1' });
    const created = await c.createKey({ name: 'ci' });
    expect(created?.secret).toBe('ak_secret');
    expect(c.getState().secret).toBe('ak_secret');
    expect(JSON.parse(String(request.mock.calls.find((x) => x[1]?.method === 'POST')?.[1]?.body)).organization_id).toBe('org_1');
    c.dismissSecret();
    expect(c.getState().secret).toBeNull();
  });

  it('reports a failed create as actionError', async () => {
    const request = vi.fn(async (_p: string, init?: RequestInit) => (init?.method === 'POST' ? fail(400, 'BAD', 'bad scope') : ok(list)));
    const c = new ApiKeysController({ request } as unknown as FapiClient, reauth);
    expect(await c.createKey({})).toBeUndefined();
    expect(c.getState().actionError).toBe('bad scope');
  });

  it('classifies key status', () => {
    const base = { revoked_at: null, expires_at: null } as never;
    expect(apiKeyStatus(base)).toBe('active');
    expect(apiKeyStatus({ ...(base as object), expires_at: 1 } as never, 5)).toBe('expired');
    expect(apiKeyStatus({ ...(base as object), revoked_at: 1 } as never)).toBe('revoked');
  });
});

describe('DeviceAuthorizationController', () => {
  const wire = { object: 'device_authorization', id: 'd1', user_code: 'ABCD-EFGH', status: 'pending', client: { client_id: 'c', name: 'TV' }, scopes: [], created_at: 1, expires_at: 2 };

  it('looks up, then approves', async () => {
    const request = vi.fn(async () => ok(wire));
    const c = new DeviceAuthorizationController({ request } as unknown as FapiClient, reauth);
    await c.lookup('abcdefgh');
    expect(c.getState().status).toBe('review');
    await c.approve();
    expect(c.getState().status).toBe('approved');
    c.reset();
    expect(c.getState().status).toBe('idle');
  });

  it('flags an invalid code', async () => {
    const c = new DeviceAuthorizationController({ request: vi.fn(async () => fail(404, 'NOT_FOUND')) } as unknown as FapiClient, reauth);
    await c.lookup('zzzz-zzzz');
    expect(c.getState().status).toBe('error');
  });
});

describe('BillingController', () => {
  const plan = (id: string, extra: Partial<BillingPlan> = {}): BillingPlan =>
    ({ object: 'billing_plan', id, name: id, slug: id, interval: 'month', amount: 1000, currency: 'usd', features: [], audience: 'user', ...extra }) as BillingPlan;

  it('loads plans only when signed out and everything when signed in', async () => {
    const get = vi.fn(async (path: string) => {
      if (path.endsWith('/plans')) return ok({ data: [plan('pro')] });
      if (path.includes('/subscription')) return ok({ object: 'billing_subscription', subject_type: 'user', status: 'active', plan: plan('pro') });
      if (path.includes('/invoices')) return ok({ data: [] });
      return ok({ payment_method: null });
    });
    const c = new BillingController({ get } as unknown as FapiClient);
    await c.load(false);
    expect(c.getState().plans).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(1);
    await c.load(true);
    expect(c.getState().subscriptions).toHaveLength(1);
    const { cards } = pricingCards(c.getState());
    expect(cards[0]!.isCurrent).toBe(true);
  });

  it('switches a live base plan in place and checks out otherwise', async () => {
    const post = vi.fn(async () => ok({}));
    const get = vi.fn(async () => ok({ data: [] }));
    const c = new BillingController({ get, post } as unknown as FapiClient);
    await c.choosePlan(plan('pro', { annual_available: true }));
    expect((post.mock.calls as unknown as string[][])[0]![0]).toBe('/v1/client/billing/checkout');
    expect(c.getState().busyPlan).toBeNull();
  });
});

import { apiKeyInputFromDraft, scopePickerModel, toggleScope } from './component-controllers';

describe('API key draft helpers', () => {
  it('builds the request and drops blanks', () => {
    expect(apiKeyInputFromDraft({ name: ' ', expiryDays: 0, scopes: [], claims: { a: '', b: '5', c: 'x' } })).toEqual({ claims: { b: 5, c: 'x' } });
    expect(apiKeyInputFromDraft({ name: 'ci', expiryDays: 30, scopes: ['a:read'], claims: {} })).toEqual({ name: 'ci', expiresInSeconds: 2592000, scopes: ['a:read'] });
  });

  it('locks scopes implied by a chosen one', () => {
    const m = scopePickerModel(['calls:read', 'calls:write', 'admin'], { 'calls:write': ['calls:read'] }, ['calls:write']);
    expect(m.rows[0]).toMatchObject({ resource: 'calls', read: { checked: true, locked: true }, write: { checked: true, locked: false } });
    expect(m.other.map((b) => b.scope)).toEqual(['admin']);
    expect(toggleScope(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleScope(['a', 'b'], 'a', false)).toEqual(['b']);
  });
});

import { CheckoutController, UsageController, couponProblemText } from './component-controllers';

describe('CheckoutController', () => {
  const setup = async (post: ReturnType<typeof vi.fn>, options: ConstructorParameters<typeof CheckoutController>[2] = {}) => {
    const get = vi.fn(async () => ok({ data: [{ id: 'pro', name: 'Pro', annual_available: true, features: [] }] }));
    const billing = new BillingController({ get, post } as unknown as FapiClient);
    await billing.load(false);
    return { billing, checkout: new CheckoutController(billing, 'pro', options) };
  };

  it('applies a code the server accepts and sends it with the hosted checkout', async () => {
    const post = vi.fn(async (path: string) =>
      path.endsWith('/coupons/validate') ? ok({ valid: true, discount: { percent_off: 20, amount_off: null, currency: null, duration: 'forever', duration_months: null } }) : ok({}),
    );
    const { checkout } = await setup(post);
    checkout.setCode(' SAVE ');
    await checkout.apply();
    expect(checkout.getState().applied).toEqual({ code: 'SAVE', text: '20% off, forever' });
    checkout.setInterval('year');
    await checkout.proceed();
    expect(post).toHaveBeenLastCalledWith('/v1/client/billing/checkout', expect.objectContaining({ plan_id: 'pro', coupon_code: 'SAVE', interval: 'year' }));
  });

  it('shows the reason a code is refused and clears any applied code', async () => {
    const post = vi.fn(async () => ok({ valid: false, reason: 'expired' }));
    const { checkout } = await setup(post);
    checkout.setCode('OLD');
    await checkout.apply();
    expect(checkout.getState()).toMatchObject({ applied: null, problem: 'That code has expired.', busy: false });
    expect(couponProblemText('weird')).toBe('That code is not valid.');
  });

  it('embedded: proceed only marks started and locks the interval', async () => {
    const post = vi.fn();
    const seen: unknown[] = [];
    const { checkout } = await setup(post, { embedded: true, onStarted: (i) => seen.push(i) });
    await checkout.proceed();
    checkout.setInterval('year');
    expect(checkout.getState()).toMatchObject({ started: true, interval: 'month' });
    expect(post).not.toHaveBeenCalled();
    expect(seen).toEqual([{ planId: 'pro', interval: 'month' }]);
  });
});

describe('UsageController', () => {
  it('reads usage for the feature and org, and stays null when signed out', async () => {
    const get = vi.fn(async () => ok({ total: 7, since: 100 }));
    const c = new UsageController({ get } as unknown as FapiClient, { orgId: 'org_1', feature: 'api calls' });
    await c.load(false);
    expect(c.getState()).toEqual({ isLoaded: true, total: null, since: null });
    expect(get).not.toHaveBeenCalled();
    await c.load(true);
    expect(get).toHaveBeenCalledWith('/v1/client/billing/usage?org_id=org_1&feature=api+calls');
    expect(c.getState()).toEqual({ isLoaded: true, total: 7, since: 100 });
  });
});

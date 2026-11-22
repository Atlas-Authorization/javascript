import type { FapiClient } from './fapi';
import { reauthenticate, type ReauthInput, type ReauthOptions } from './reauth';
import {
  ApiKeyRequestError,
  createApiKey,
  listApiKeys,
  impliedScopes,
  revokeApiKey,
  scopeGrid,
  updateApiKey,
  type CreateUserApiKeyInput,
  type CreatedUserApiKey,
  type UserApiKey,
} from './api-keys';
import {
  DeviceAuthorizationError,
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  lookupDeviceAuthorization,
  type DeviceAuthorization,
} from './device-authorization';
import {
  describeDiscount,
  planPriceView,
  validatePlanCoupon,
  type CouponCheck,
  type PlanPriceView,
  type PublicBillingPlan,
} from './pricing';

/**
 * Framework-neutral controllers behind the API keys, billing and device authorization components of the
 * Vue, Svelte, Solid, Angular and Qwik SDKs (React keeps its own hooks). Each is a small observable store:
 * `getState()` is the current snapshot, `subscribe(fn)` calls `fn` with every new snapshot and returns the
 * unsubscribe. A binding only maps that to its own reactivity primitive and renders; the behaviour (step-up
 * parking, one-time secrets, plan switching) is the same everywhere.
 */

// ── Store ──────────────────────────────────────────────────────────────────

/** The observable base every controller extends. */
export class ObservableController<S extends object> {
  private snapshot: S;
  private readonly listeners = new Set<(state: S) => void>();

  constructor(initial: S) {
    this.snapshot = initial;
  }

  getState(): S {
    return this.snapshot;
  }

  subscribe(listener: (state: S) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  protected patch(next: Partial<S>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of [...this.listeners]) listener(this.snapshot);
  }
}

// ── Labels ─────────────────────────────────────────────────────────────────

/** Fill `{name}` placeholders in a label. A missing parameter is left as written. */
export function formatLabel(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in params ? String(params[key]) : whole));
}

/** The English text of the "Confirm it's you" prompt the three components share. */
export const REVERIFICATION_LABELS = {
  title: "Confirm it's you",
  subtitle: 'Re-enter your password to continue.',
  passwordLabel: 'Password',
  submit: 'Confirm',
  cancel: 'Cancel',
};
export type ReverificationLabels = Partial<typeof REVERIFICATION_LABELS>;

/** The English text of the API keys component; every entry can be overridden with `labels`. */
export const API_KEYS_LABELS = {
  title: 'API keys',
  subtitle: 'Keys let scripts and integrations act as you. Treat them like passwords.',
  organizationSubtitle: 'Keys let scripts and integrations act as this organization. Treat them like passwords.',
  empty: 'No API keys yet.',
  disabled: 'API keys are not available for this account.',
  create: 'Create key',
  nameLabel: 'Name',
  namePlaceholder: 'e.g. CI pipeline',
  expiresLabel: 'Expires',
  expiresNever: 'Never',
  expiresDays: 'In {days} days',
  scopesLabel: 'Scopes',
  submit: 'Create key',
  cancel: 'Cancel',
  secretTitle: 'Copy your new key',
  secretHint: 'This is the only time it will be shown. If you lose it, revoke it and create another.',
  copy: 'Copy',
  copied: 'Copied',
  done: 'Done',
  rename: 'Rename',
  save: 'Save',
  revoke: 'Revoke',
  revokeConfirm: 'Revoke this key? Anything using it will stop working.',
  revokeConfirmButton: 'Yes, revoke',
  unnamed: 'Unnamed key',
  revoked: 'Revoked',
  expired: 'Expired',
  lastUsed: 'Last used {date}',
  neverUsed: 'Never used',
  expiresOn: 'Expires {date}',
  limits: 'Limits',
  limitReached: "You've reached the maximum of {max} active keys. Revoke one to create another.",
};
export type ApiKeysLabels = Partial<typeof API_KEYS_LABELS>;

/** The English text of the device authorization component. */
export const DEVICE_AUTH_LABELS = {
  title: 'Sign in on a device',
  subtitle: 'Enter the code shown on your TV, console or terminal.',
  codeLabel: 'Code',
  continue: 'Continue',
  request: '{app} wants to sign in to your account on a device.',
  scopesTitle: 'It will be able to:',
  checkCode: 'Only continue if your device shows this code: {code}',
  approve: 'Allow',
  deny: 'Deny',
  approved: 'Your device is signed in. You can go back to it now.',
  denied: 'Sign-in denied. Nothing was shared with the device.',
  invalidCode: 'That code is not valid. It may have expired or already been used.',
  another: 'Enter another code',
};
export type DeviceAuthorizationLabels = Partial<typeof DEVICE_AUTH_LABELS>;

/** The English text of the pricing table, invoices and checkout components. */
export const BILLING_LABELS = {
  monthly: 'Monthly',
  yearly: 'Yearly',
  perMonth: 'month',
  perYear: 'year',
  free: 'Free',
  trial: '{days}-day free trial',
  useCode: 'Use code {code} at checkout',
  subscribe: 'Subscribe',
  manage: 'Manage billing',
  invoices: 'Invoices',
  noInvoices: 'No invoices yet.',
  viewInvoice: 'View',
  checkoutFailed: 'Could not start checkout.',
};
export type BillingLabels = Partial<typeof BILLING_LABELS>;

/** The English text of the checkout step (discount code, continue to payment). `{what}` is the discount line. */
export const CHECKOUT_LABELS = {
  code: 'Discount code',
  apply: 'Apply',
  applied: 'Code applied: {what}',
  invalid: 'That code is not valid.',
  expired: 'That code has expired.',
  exhausted: 'That code has been used up.',
  notForPlan: 'That code does not work on this plan.',
  firstTimeOnly: 'That code is for first-time customers only.',
  alreadyUsed: 'You have already used that code.',
  continue: 'Continue to payment',
  signIn: 'Sign in to subscribe.',
  planGone: 'That plan is not available.',
};
export type CheckoutLabels = Partial<typeof CHECKOUT_LABELS>;

const COUPON_REASON: Record<string, keyof typeof CHECKOUT_LABELS> = {
  expired: 'expired',
  exhausted: 'exhausted',
  plan_not_eligible: 'notForPlan',
  first_time_only: 'firstTimeOnly',
  already_used: 'alreadyUsed',
};

/** The message for a refused discount code's `reason`. */
export function couponProblemText(reason: string, labels: CheckoutLabels = {}): string {
  const l = { ...CHECKOUT_LABELS, ...labels };
  return l[COUPON_REASON[reason] ?? 'invalid'];
}

// ── Reverification ─────────────────────────────────────────────────────────

/** A cancelled reverification rejects the parked call with this message. */
export const REVERIFICATION_CANCELLED = 'Reverification cancelled.';

/** True for the rejection a user's own "Cancel" produces (not worth an error). */
export function isReverificationCancelled(err: unknown): boolean {
  return err instanceof Error && err.message === REVERIFICATION_CANCELLED;
}

function isStepUp(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== 'object') return false;
  if ((candidate as { code?: string }).code === 'STEP_UP_REQUIRED') return true;
  const errors = (candidate as { errors?: Array<{ code?: string }> }).errors;
  return Array.isArray(errors) && errors.some((e) => e?.code === 'STEP_UP_REQUIRED');
}

/**
 * Parks an action that came back `STEP_UP_REQUIRED` until the user re-authenticates, then retries it once.
 * The same behaviour as React's `useReverification`, without the hook.
 */
export class ReverificationGate {
  private pending: { action: () => unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void } | null = null;

  constructor(
    private readonly reauth: ReauthOptions,
    private readonly onChange: (needsReverification: boolean) => void,
  ) {}

  /** Run `action`; on a step-up demand, wait for `complete()` and resolve with the retry's result. */
  async run<T>(action: () => T | Promise<T>): Promise<T> {
    try {
      const result = await action();
      return isStepUp(result) ? await this.park(action) : result;
    } catch (err) {
      if (isStepUp(err)) return await this.park(action);
      throw err;
    }
  }

  private park<T>(action: () => T | Promise<T>): Promise<T> {
    // A second parked call replaces the first: the user is only ever asked once.
    this.pending?.reject(new Error(REVERIFICATION_CANCELLED));
    return new Promise<T>((resolve, reject) => {
      this.pending = { action, resolve: resolve as (v: unknown) => void, reject };
      this.onChange(true);
    });
  }

  /** Re-authenticate, then retry the parked action. A wrong credential throws and keeps the action parked. */
  async complete(input: ReauthInput): Promise<void> {
    await reauthenticate(input, this.reauth);
    const job = this.pending;
    this.pending = null;
    this.onChange(false);
    if (!job) return;
    try {
      job.resolve(await job.action());
    } catch (err) {
      job.reject(err);
    }
  }

  /** Abandon the parked action; its caller sees `REVERIFICATION_CANCELLED`. */
  cancel(): void {
    const job = this.pending;
    this.pending = null;
    this.onChange(false);
    job?.reject(new Error(REVERIFICATION_CANCELLED));
  }
}

const messageOf = (err: unknown, fallback = 'The request failed.'): string => (err instanceof Error && err.message ? err.message : fallback);

// ── API keys ───────────────────────────────────────────────────────────────

export type ApiKeysStatus = 'loading' | 'ready' | 'disabled' | 'error';

export interface ApiKeysState {
  status: ApiKeysStatus;
  keys: UserApiKey[];
  allowedScopes: string[];
  allowedClaims: string[];
  scopeImplications: Record<string, string[]>;
  maxActiveKeys: number;
  activeCount: number;
  /** Why the list could not load. */
  error: string | null;
  /** The last create / rename / revoke failure. */
  actionError: string | null;
  busy: boolean;
  /** The one-time secret of the key just created, until `dismissSecret()`. */
  secret: string | null;
  needsReverification: boolean;
}

/**
 * The signed-in user's own API keys (or their organization's, with `organizationId`): list, create with the
 * step-up wired in, rename and revoke. The secret of a new key is held in `state.secret` until dismissed.
 */
export class ApiKeysController extends ObservableController<ApiKeysState> {
  private readonly gate: ReverificationGate;

  constructor(
    private readonly client: FapiClient,
    reauth: ReauthOptions,
    private readonly options: { organizationId?: string } = {},
  ) {
    super({
      status: 'loading',
      keys: [],
      allowedScopes: [],
      allowedClaims: [],
      scopeImplications: {},
      maxActiveKeys: 0,
      activeCount: 0,
      error: null,
      actionError: null,
      busy: false,
      secret: null,
      needsReverification: false,
    });
    this.gate = new ReverificationGate(reauth, (needs) => this.patch({ needsReverification: needs }));
  }

  async load(): Promise<void> {
    try {
      const list = await listApiKeys(this.client, { organizationId: this.options.organizationId });
      this.patch({
        status: 'ready',
        error: null,
        keys: list.data,
        allowedScopes: list.allowedScopes,
        allowedClaims: list.allowedClaims,
        scopeImplications: list.scopeImplications,
        maxActiveKeys: list.maxActiveKeys,
        activeCount: list.activeCount,
      });
    } catch (err) {
      // A 403 on the LIST means the feature is off (or the role lacks the permission): nothing to act on.
      if (err instanceof ApiKeyRequestError && err.status === 403) this.patch({ status: 'disabled', error: messageOf(err) });
      else this.patch({ status: 'error', error: messageOf(err) });
    }
  }

  private async act<T>(fn: () => Promise<T>): Promise<T | undefined> {
    this.patch({ busy: true, actionError: null });
    try {
      const out = await fn();
      await this.load();
      return out;
    } catch (err) {
      if (!isReverificationCancelled(err)) this.patch({ actionError: messageOf(err) });
      return undefined;
    } finally {
      this.patch({ busy: false });
    }
  }

  /** Create a key. Resolves with it (and holds its secret); undefined when it failed or the user cancelled the step-up. */
  async createKey(input: Omit<CreateUserApiKeyInput, 'organizationId'> = {}): Promise<CreatedUserApiKey | undefined> {
    const org = this.options.organizationId;
    const created = await this.act(() => this.gate.run(() => createApiKey(this.client, { ...input, ...(org ? { organizationId: org } : {}) })));
    if (created) this.patch({ secret: created.secret });
    return created;
  }

  async renameKey(id: string, name: string | null): Promise<boolean> {
    return (await this.act(() => updateApiKey(this.client, id, { name }))) !== undefined;
  }

  async revokeKey(id: string): Promise<boolean> {
    return (await this.act(() => revokeApiKey(this.client, id))) !== undefined;
  }

  dismissSecret(): void {
    this.patch({ secret: null });
  }

  completeReverification(password: string): Promise<void> {
    return this.gate.complete({ strategy: 'password', password });
  }

  cancelReverification(): void {
    this.gate.cancel();
  }
}

/** `active`, `revoked` or `expired` for a key, so every binding words the status the same way. */
export function apiKeyStatus(key: UserApiKey, now: number = Date.now()): 'active' | 'revoked' | 'expired' {
  if (key.revoked_at) return 'revoked';
  if (key.expires_at && key.expires_at <= now) return 'expired';
  return 'active';
}

/** Whether a new key would exceed `maxActiveKeys` (0 means no cap). */
export function apiKeysAtCap(state: Pick<ApiKeysState, 'maxActiveKeys' | 'activeCount'>): boolean {
  return state.maxActiveKeys > 0 && state.activeCount >= state.maxActiveKeys;
}

/** The create form's draft: what the user typed, before it becomes a request. */
export interface ApiKeyDraft {
  name: string;
  /** Days until expiry; 0 means never. */
  expiryDays: number;
  scopes: string[];
  /** Claim name to the text typed for it (JSON when it parses, else a string; blank is dropped). */
  claims: Record<string, string>;
}

/** The request a draft makes. Blank fields are left out so the instance defaults apply. */
export function apiKeyInputFromDraft(draft: ApiKeyDraft): Omit<CreateUserApiKeyInput, 'organizationId'> {
  const claims: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(draft.claims)) {
    const text = raw.trim();
    if (!text) continue;
    try {
      claims[name] = JSON.parse(text);
    } catch {
      claims[name] = text;
    }
  }
  return {
    ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
    ...(draft.expiryDays > 0 ? { expiresInSeconds: draft.expiryDays * 24 * 60 * 60 } : {}),
    ...(draft.scopes.length > 0 ? { scopes: draft.scopes } : {}),
    ...(Object.keys(claims).length > 0 ? { claims } : {}),
  };
}

export interface ScopeBox {
  scope: string;
  /** Ticked: chosen, or implied by a chosen scope. */
  checked: boolean;
  /** Implied by a chosen scope: shown ticked and not editable (the key gets it anyway). */
  locked: boolean;
}

/**
 * The scope choices of the create form. `<resource>:read` / `<resource>:write` scopes form a grid of rows; any
 * other scope is a flat box. Only the explicitly chosen scopes are sent; implied ones show locked.
 */
export function scopePickerModel(
  allowedScopes: string[],
  implications: Record<string, string[]>,
  selected: string[],
): { rows: Array<{ resource: string; read: ScopeBox | null; write: ScopeBox | null }>; other: ScopeBox[] } {
  const implied = new Set(impliedScopes(selected, implications, allowedScopes).filter((s) => !selected.includes(s)));
  const box = (scope: string): ScopeBox => ({ scope, checked: selected.includes(scope) || implied.has(scope), locked: implied.has(scope) });
  const grid = scopeGrid(allowedScopes);
  return {
    rows: grid ? grid.rows.map((r) => ({ resource: r.resource, read: r.read ? box(r.read) : null, write: r.write ? box(r.write) : null })) : [],
    other: (grid ? grid.other : allowedScopes).map(box),
  };
}

/** Tick or untick one scope in the chosen list. */
export function toggleScope(selected: string[], scope: string, on: boolean): string[] {
  return on ? (selected.includes(scope) ? selected : [...selected, scope]) : selected.filter((s) => s !== scope);
}

// ── Device authorization ───────────────────────────────────────────────────

export type DeviceAuthorizationStatus = 'idle' | 'busy' | 'review' | 'approved' | 'denied' | 'error';

export interface DeviceAuthorizationState {
  status: DeviceAuthorizationStatus;
  authorization: DeviceAuthorization | null;
  error: string | null;
  /** True when the error is "the code is not valid", so a UI can show its own wording. */
  invalidCode: boolean;
  needsReverification: boolean;
}

/** Device sign-in (RFC 8628) approval on the app's own page: look up a code, then allow or deny. */
export class DeviceAuthorizationController extends ObservableController<DeviceAuthorizationState> {
  private readonly gate: ReverificationGate;

  constructor(
    private readonly client: FapiClient,
    reauth: ReauthOptions,
  ) {
    super({ status: 'idle', authorization: null, error: null, invalidCode: false, needsReverification: false });
    this.gate = new ReverificationGate(reauth, (needs) => this.patch({ needsReverification: needs }));
  }

  private fail(err: unknown): void {
    if (isReverificationCancelled(err)) {
      this.patch({ status: 'review' });
      return;
    }
    this.patch({
      status: 'error',
      invalidCode: err instanceof DeviceAuthorizationError && err.isInvalidCode,
      error: messageOf(err),
    });
  }

  async lookup(userCode: string): Promise<DeviceAuthorization | null> {
    this.patch({ status: 'busy', error: null, invalidCode: false });
    try {
      const found = await lookupDeviceAuthorization(this.client, userCode);
      this.patch({ authorization: found, status: 'review' });
      return found;
    } catch (err) {
      this.patch({ authorization: null });
      this.fail(err);
      return null;
    }
  }

  async approve(): Promise<void> {
    const authorization = this.getState().authorization;
    if (!authorization) return;
    this.patch({ status: 'busy', error: null, invalidCode: false });
    try {
      const done = await this.gate.run(() => approveDeviceAuthorization(this.client, authorization));
      this.patch({ authorization: done, status: 'approved' });
    } catch (err) {
      this.fail(err);
    }
  }

  async deny(): Promise<void> {
    const authorization = this.getState().authorization;
    if (!authorization) return;
    this.patch({ status: 'busy', error: null, invalidCode: false });
    try {
      const done = await denyDeviceAuthorization(this.client, authorization);
      this.patch({ authorization: done, status: 'denied' });
    } catch (err) {
      this.fail(err);
    }
  }

  reset(): void {
    this.patch({ authorization: null, error: null, invalidCode: false, status: 'idle' });
  }

  completeReverification(password: string): Promise<void> {
    return this.gate.complete({ strategy: 'password', password });
  }

  cancelReverification(): void {
    this.gate.cancel();
  }
}

// ── Billing ────────────────────────────────────────────────────────────────

export interface BillingPlan extends PublicBillingPlan {
  pricing_model?: string;
}

export interface BillingInvoice {
  object: 'billing_invoice';
  id: string;
  number: string | null;
  status: string;
  amount_due: number;
  amount_paid: number;
  currency: string;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  period_start: number | null;
  period_end: number | null;
  created_at: number;
}

export interface BillingPaymentMethod {
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
}

export interface BillingSubscription {
  object: 'billing_subscription';
  id?: string;
  subject_type: 'user' | 'org';
  subject_id?: string;
  /** null when the subject has never subscribed. */
  status: string | null;
  plan: BillingPlan | null;
  current_period_end?: number | null;
  cancel_at_period_end?: boolean;
  interval?: 'month' | 'year' | null;
  scheduled_plan_id?: string | null;
  scheduled_change_at?: number | null;
  trial_end?: number | null;
  provider?: string;
  quantity?: number;
  canceled_at?: number | null;
  trial_eligible?: boolean;
  /** Every subscription the subject holds: the base plan and any add-ons. */
  subscriptions?: BillingSubscription[];
}

export interface BillingFeatureCheck {
  object: 'billing_feature_check';
  feature: string;
  allowed: boolean;
  source: 'provider' | 'atlas';
  provider: string | null;
  remaining: number | null;
  granted: number | null;
  usage: number | null;
  unlimited: boolean;
}

export interface BillingCheckoutParams {
  planId: string;
  orgId?: string;
  successUrl?: string;
  cancelUrl?: string;
  /** Redirect to the Checkout URL (default true). False returns the URL only. */
  redirect?: boolean;
  interval?: 'month' | 'year';
  /** A discount code the buyer entered (see `BillingController.validateCoupon`). */
  couponCode?: string;
}

export interface BillingChangePlanParams {
  planId: string;
  interval?: 'month' | 'year';
  atPeriodEnd?: boolean;
  orgId?: string;
  subscriptionId?: string;
}

/** The statuses in which a subscription is still running. */
const LIVE_STATUSES = ['active', 'trialing', 'past_due'];

/** Where a change / cancel / restore goes: one subscription by id, or the subject's primary one. */
export function billingManageUrl(action: 'change' | 'cancel' | 'restore', subscriptionId?: string): string {
  return subscriptionId
    ? `/v1/client/billing/subscriptions/${encodeURIComponent(subscriptionId)}/${action}`
    : `/v1/client/billing/subscription/${action}`;
}

/** Every subscription from a subject read; a server that predates several subscriptions reports the one. */
export function billingSubscriptionsOf(read: BillingSubscription | null | undefined): BillingSubscription[] {
  if (!read) return [];
  if (Array.isArray(read.subscriptions)) return read.subscriptions;
  return read.status !== null ? [read] : [];
}

/** The live add-on subscriptions among a subject's subscriptions. */
export function billingLiveAddons(subscriptions: BillingSubscription[]): BillingSubscription[] {
  return subscriptions.filter((s) => s.plan?.kind === 'addon' && LIVE_STATUSES.includes(String(s.status ?? '')));
}

export interface BillingState {
  isLoaded: boolean;
  plans: BillingPlan[];
  subscription: BillingSubscription | null;
  subscriptions: BillingSubscription[];
  addons: BillingSubscription[];
  invoices: BillingInvoice[];
  paymentMethod: BillingPaymentMethod | null;
  /** The monthly / yearly switch of the pricing table. */
  interval: 'month' | 'year';
  /** The plan whose subscribe button is working. */
  busyPlan: string | null;
  error: string | null;
}

const hereUrl = (): string => (typeof window === 'undefined' || !window.location ? '/' : window.location.href);
const goto = (url: string): void => {
  if (typeof window !== 'undefined') window.location.assign(url);
};

/**
 * Plans, the subject's subscription, invoices and payment method, with checkout, portal, plan change,
 * cancel, restore and a live feature check. Checkout and the portal are provider-hosted pages: the caller is
 * redirected, no card form is rendered here. Pass `orgId` to act on an organization the user administers.
 */
export class BillingController extends ObservableController<BillingState> {
  private readonly orgId: string | undefined;

  constructor(
    private readonly client: FapiClient,
    options: { orgId?: string } = {},
  ) {
    super({
      isLoaded: false,
      plans: [],
      subscription: null,
      subscriptions: [],
      addons: [],
      invoices: [],
      paymentMethod: null,
      interval: 'month',
      busyPlan: null,
      error: null,
    });
    this.orgId = options.orgId;
  }

  /** Load plans, and (when `signedIn`) the subject's subscription, invoices and payment method. */
  async load(signedIn: boolean): Promise<void> {
    const orgQuery = this.orgId ? `?org_id=${encodeURIComponent(this.orgId)}` : '';
    const plansRes = await this.client.get<{ data: BillingPlan[] }>('/v1/client/billing/plans');
    if (plansRes.ok && plansRes.data) this.patch({ plans: plansRes.data.data ?? [] });
    if (signedIn) {
      const [subRes, invRes, pmRes] = await Promise.all([
        this.client.get<BillingSubscription>(`/v1/client/billing/subscription${orgQuery}`),
        this.client.get<{ data: BillingInvoice[] }>(`/v1/client/billing/invoices${orgQuery}`),
        this.client.get<{ payment_method: BillingPaymentMethod | null }>(`/v1/client/billing/payment_method${orgQuery}`),
      ]);
      if (subRes.ok) {
        const subscriptions = billingSubscriptionsOf(subRes.data);
        this.patch({ subscription: subRes.data ?? null, subscriptions, addons: billingLiveAddons(subscriptions) });
      }
      if (invRes.ok && invRes.data) this.patch({ invoices: invRes.data.data ?? [] });
      if (pmRes.ok) this.patch({ paymentMethod: pmRes.data?.payment_method ?? null });
    } else {
      this.patch({ subscription: null, subscriptions: [], addons: [], invoices: [], paymentMethod: null });
    }
    this.patch({ isLoaded: true });
  }

  setInterval(interval: 'month' | 'year'): void {
    this.patch({ interval });
  }

  async checkout(params: BillingCheckoutParams): Promise<{ url: string | null; error?: string }> {
    const res = await this.client.post<{ url?: string }>('/v1/client/billing/checkout', {
      plan_id: params.planId,
      ...((params.orgId ?? this.orgId) ? { org_id: params.orgId ?? this.orgId } : {}),
      success_url: params.successUrl ?? hereUrl(),
      cancel_url: params.cancelUrl ?? hereUrl(),
      ...(params.interval ? { interval: params.interval } : {}),
      ...(params.couponCode ? { coupon_code: params.couponCode } : {}),
    });
    if (res.ok && res.data?.url) {
      if (params.redirect !== false) goto(res.data.url);
      return { url: res.data.url };
    }
    const error = res.errors[0]?.message ?? 'Could not start checkout.';
    this.patch({ error });
    return { url: null, error };
  }

  /** Would this discount code work for this plan? For an "apply" button; needs a signed-in session. */
  validateCoupon(planId: string, code: string, params: { orgId?: string } = {}): Promise<CouponCheck> {
    return validatePlanCoupon(this.client, { planId, code, orgId: params.orgId ?? this.orgId });
  }

  async openPortal(params: { returnUrl?: string; orgId?: string; redirect?: boolean; subscriptionId?: string } = {}): Promise<string | null> {
    const org = params.orgId ?? this.orgId;
    const res = await this.client.post<{ url?: string }>('/v1/client/billing/portal', {
      ...(org ? { org_id: org } : {}),
      return_url: params.returnUrl ?? hereUrl(),
      ...(params.subscriptionId ? { subscription_id: params.subscriptionId } : {}),
    });
    if (res.ok && res.data?.url) {
      if (params.redirect !== false) goto(res.data.url);
      return res.data.url;
    }
    this.patch({ error: res.errors[0]?.message ?? 'Could not open the billing portal.' });
    return null;
  }

  /** Switch a live subscription to another plan or interval, no checkout needed. */
  async changePlan(params: BillingChangePlanParams): Promise<boolean> {
    const org = params.orgId ?? this.orgId;
    const res = await this.client.post<BillingSubscription>(billingManageUrl('change', params.subscriptionId), {
      plan_id: params.planId,
      ...(org ? { org_id: org } : {}),
      ...(params.interval ? { interval: params.interval } : {}),
      schedule_at_period_end: params.atPeriodEnd === true,
    });
    return this.afterManage(res.ok, res.errors[0]?.message);
  }

  /** Cancel at the end of the period, or now with `immediately`. */
  async cancel(params: { immediately?: boolean; orgId?: string; subscriptionId?: string } = {}): Promise<boolean> {
    const org = params.orgId ?? this.orgId;
    const res = await this.client.post<BillingSubscription>(billingManageUrl('cancel', params.subscriptionId), {
      ...(org ? { org_id: org } : {}),
      immediately: params.immediately === true,
    });
    return this.afterManage(res.ok, res.errors[0]?.message);
  }

  /** Undo a cancellation scheduled for the end of the period. */
  async restore(params: { orgId?: string; subscriptionId?: string } = {}): Promise<boolean> {
    const org = params.orgId ?? this.orgId;
    const res = await this.client.post<BillingSubscription>(billingManageUrl('restore', params.subscriptionId), {
      ...(org ? { org_id: org } : {}),
    });
    return this.afterManage(res.ok, res.errors[0]?.message);
  }

  private async afterManage(ok: boolean, message: string | undefined): Promise<boolean> {
    if (ok) await this.load(true);
    else this.patch({ error: message ?? 'The request failed.' });
    return ok;
  }

  /** May the subject use `feature` (needing `required` units)? For UI only; gate on the server or the token. */
  async check(feature: string, params: { required?: number; orgId?: string } = {}): Promise<BillingFeatureCheck | null> {
    const q = new URLSearchParams({ feature });
    if (params.required !== undefined) q.set('required', String(params.required));
    const org = params.orgId ?? this.orgId;
    if (org) q.set('org_id', org);
    const res = await this.client.get<BillingFeatureCheck>(`/v1/client/billing/check?${q.toString()}`);
    return res.ok ? res.data : null;
  }

  /**
   * What a pricing table's button for `plan` does: open the portal when it is the plan the subject holds, switch
   * a live base plan in place (prorated), or start a checkout. Tracks `busyPlan` while it works.
   */
  async choosePlan(plan: BillingPlan): Promise<void> {
    const state = this.getState();
    const isAddon = plan.kind === 'addon';
    const currentPlanId = state.subscription?.plan?.id ?? null;
    const live = LIVE_STATUSES.includes(String(state.subscription?.status ?? '')) && state.subscription?.plan?.kind !== 'addon';
    this.patch({ busyPlan: plan.id, error: null });
    try {
      if (!isAddon && live && currentPlanId) await this.changePlan({ planId: plan.id });
      else await this.checkout({ planId: plan.id, ...(plan.annual_available ? { interval: state.interval } : {}) });
    } finally {
      this.patch({ busyPlan: null });
    }
  }
}

/** One card of the pricing table, resolved: what to render and what its button does. */
export interface PricingCard {
  plan: BillingPlan;
  isAddon: boolean;
  isCurrent: boolean;
  /** The held add-on subscription, for the add-on's portal button. */
  heldSubscriptionId: string | null;
  view: PlanPriceView;
}

/** The cards of a pricing table for the controller's current state, `audience` narrowing to user or org plans. */
export function pricingCards(
  state: Pick<BillingState, 'plans' | 'subscription' | 'addons' | 'interval'>,
  options: { audience?: 'user' | 'org'; locale?: string } = {},
): { cards: PricingCard[]; hasAnnual: boolean } {
  const shown = options.audience ? state.plans.filter((p) => p.audience === options.audience) : state.plans;
  const currentPlanId = state.subscription?.plan?.id ?? null;
  const held = new Map(state.addons.map((s) => [s.plan!.id, s]));
  return {
    hasAnnual: shown.some((p) => p.annual_available),
    cards: shown.map((plan) => {
      const isAddon = plan.kind === 'addon';
      const sub = isAddon ? held.get(plan.id) : undefined;
      return {
        plan,
        isAddon,
        isCurrent: isAddon ? Boolean(sub) : plan.id === currentPlanId,
        heldSubscriptionId: sub?.id ?? null,
        view: planPriceView(plan, { interval: state.interval, locale: options.locale }),
      };
    }),
  };
}

// ── Embedded checkout ──────────────────────────────────────────────────────

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
    script.onerror = () => {
      stripeJsPromise = null;
      reject(new Error('Failed to load Stripe.js'));
    };
    document.head.appendChild(script);
  });
  return stripeJsPromise;
}

export interface EmbeddedCheckoutHandle {
  /** `mounted`, `unavailable` (no embedded checkout on this instance: show a hosted-redirect button) or `error`. */
  status: 'mounted' | 'unavailable' | 'error';
  error?: string;
  /** Tear the frame down. Safe to call twice. */
  destroy(): void;
}

/**
 * Mount the provider's Embedded Checkout for a plan into `element`. The provider's own script owns the card
 * fields, so no card data touches Atlas. Resolves `unavailable` when the instance has no embedded checkout.
 * Pass `isCancelled` so a component torn down mid-setup does not leave a frame behind.
 */
export async function mountEmbeddedCheckout(
  client: FapiClient,
  input: { planId: string; orgId?: string; returnUrl?: string; couponCode?: string; interval?: 'month' | 'year' },
  element: HTMLElement,
  isCancelled: () => boolean = () => false,
): Promise<EmbeddedCheckoutHandle> {
  const noop = { destroy() {} };
  const cfg = await client.get<{ stripe_publishable_key: string | null; embedded: boolean }>('/v1/client/billing/config');
  const key = cfg.ok ? cfg.data?.stripe_publishable_key : null;
  if (!key) return { status: 'unavailable', ...noop };
  const res = await client.post<{ client_secret: string | null }>('/v1/client/billing/checkout', {
    plan_id: input.planId,
    ...(input.orgId ? { org_id: input.orgId } : {}),
    ui_mode: 'embedded',
    return_url: input.returnUrl ?? hereUrl(),
    ...(input.couponCode ? { coupon_code: input.couponCode } : {}),
    ...(input.interval ? { interval: input.interval } : {}),
  });
  if (!res.ok || !res.data?.client_secret) return { status: 'error', error: res.errors[0]?.message ?? 'Could not start checkout.', ...noop };
  let factory: unknown;
  try {
    factory = await loadStripeJs();
  } catch (err) {
    return { status: 'error', error: messageOf(err), ...noop };
  }
  if (typeof factory !== 'function' || isCancelled()) return { status: 'error', error: 'Embedded checkout is not available.', ...noop };
  type Embedded = { mount(el: HTMLElement): void; unmount(): void; destroy(): void };
  const stripe = (factory as (k: string) => { initEmbeddedCheckout(o: { clientSecret: string }): Promise<Embedded> })(key);
  const instance = await stripe.initEmbeddedCheckout({ clientSecret: res.data.client_secret });
  if (isCancelled()) {
    instance.destroy();
    return { status: 'error', error: 'Cancelled.', ...noop };
  }
  instance.mount(element);
  let destroyed = false;
  return {
    status: 'mounted',
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try {
        instance.destroy();
      } catch {
        /* already gone */
      }
    },
  };
}

// ── Checkout step ──────────────────────────────────────────────────────────

export interface CheckoutState {
  interval: 'month' | 'year';
  /** What the buyer typed. */
  code: string;
  /** The code the server accepted, with its one-line description. */
  applied: { code: string; text: string } | null;
  problem: string | null;
  busy: boolean;
  /** Embedded only: the buyer continued, so the in-page frame should mount. */
  started: boolean;
}

export interface CheckoutControllerOptions {
  orgId?: string;
  /** Mount the in-page frame after "continue" instead of redirecting (the component reads `state.started`). */
  embedded?: boolean;
  locale?: string;
  labels?: CheckoutLabels;
  /** Called when the buyer continues to payment. */
  onStarted?: (info: { planId: string; couponCode?: string; interval: 'month' | 'year' }) => void;
}

/**
 * The step before payment for one plan: interval choice, an optional discount code with a server-side "apply"
 * check, and the way on to payment (hosted redirect, or `started` for an embedded frame). Reads the plan from a
 * loaded {@link BillingController}. The server validates and applies the code, so nothing here decides a price.
 */
export class CheckoutController extends ObservableController<CheckoutState> {
  constructor(
    private readonly billing: BillingController,
    private readonly planId: string,
    private readonly options: CheckoutControllerOptions = {},
  ) {
    super({ interval: 'month', code: '', applied: null, problem: null, busy: false, started: false });
  }

  /** The plan, once the billing controller has loaded; null when it does not exist. */
  plan(): BillingPlan | null {
    return this.billing.getState().plans.find((p) => p.id === this.planId) ?? null;
  }

  setCode(code: string): void {
    this.patch({ code });
  }

  setInterval(interval: 'month' | 'year'): void {
    if (!this.getState().started) this.patch({ interval });
  }

  /** Ask the server whether the typed code works for this plan. */
  async apply(): Promise<void> {
    const entered = this.getState().code.trim();
    if (!entered) return;
    this.patch({ busy: true, problem: null });
    const res = await this.billing.validateCoupon(this.planId, entered, { orgId: this.options.orgId });
    if (res.valid) this.patch({ busy: false, applied: { code: entered, text: describeDiscount(res.discount, this.options.locale) } });
    else this.patch({ busy: false, applied: null, problem: couponProblemText(res.reason, this.options.labels) });
  }

  /** Continue to payment: redirects to the hosted page, or sets `started` for the embedded frame. */
  async proceed(): Promise<void> {
    const plan = this.plan();
    if (!plan) return;
    const { applied, interval } = this.getState();
    this.options.onStarted?.({ planId: this.planId, ...(applied ? { couponCode: applied.code } : {}), interval });
    if (this.options.embedded) {
      this.patch({ started: true });
      return;
    }
    await this.billing.checkout({ planId: this.planId, orgId: this.options.orgId, interval: plan.annual_available ? interval : undefined, couponCode: applied?.code });
  }
}

// ── Usage ──────────────────────────────────────────────────────────────────

export interface UsageState {
  isLoaded: boolean;
  /** Metered units this billing period, or null when signed out or not readable. */
  total: number | null;
  since: number | null;
}

/**
 * The subject's metered usage this billing period, for a "you have used N" display (`feature` narrows to one
 * feature). Reads what Atlas recorded; for UI only, since enforcement belongs on your server.
 */
export class UsageController extends ObservableController<UsageState> {
  constructor(
    private readonly client: FapiClient,
    private readonly options: { orgId?: string; feature?: string } = {},
  ) {
    super({ isLoaded: false, total: null, since: null });
  }

  async load(signedIn: boolean): Promise<void> {
    if (!signedIn) {
      this.patch({ isLoaded: true, total: null, since: null });
      return;
    }
    const q = new URLSearchParams();
    if (this.options.orgId) q.set('org_id', this.options.orgId);
    if (this.options.feature) q.set('feature', this.options.feature);
    const res = await this.client.get<{ total: number; since: number | null }>(`/v1/client/billing/usage${q.size ? `?${q.toString()}` : ''}`);
    if (res.ok && res.data) this.patch({ total: res.data.total, since: res.data.since });
    this.patch({ isLoaded: true });
  }
}

import type { FapiClient } from './fapi';
import { detectConsent, type AppConsent, type ConsentDecision } from './referral-detect';

/**
 * Marketing attribution: capture the UTM tags and ad click ids a visitor arrived
 * with, keep them (only with consent) until they sign up, and attach them to the
 * new user's private metadata (`marketing.first_touch` / `last_touch`) and to
 * lead-form submissions. The instance decides which parameters are captured
 * (`GET /v1/client/marketing`); the server re-validates everything it receives.
 *
 * Consent: the page's consent manager decides for the instance's category (default
 * `marketing`), else the app's own `consent`. With no decision nothing is stored.
 */

export interface MarketingConfig {
  enabled: boolean;
  params: string[];
  consentCategory: string;
}

export interface MarketingTouch {
  params: Record<string, string>;
  landing_url: string | null;
  referrer: string | null;
  captured_at: string;
}

export interface StoredMarketing {
  first_touch: MarketingTouch;
  last_touch: MarketingTouch;
  /** The attribution has been sent to the server for the user who signed up. */
  sent?: boolean;
}

export interface MarketingOptions {
  /** Your own consent decision, used when no consent manager is on the page. */
  consent?: AppConsent;
  /** Where the capture is kept. Default `localStorage`. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** The page (default `window`), for tests and non-browser hosts. */
  win?: { location?: { search?: string; origin?: string; pathname?: string }; document?: { referrer?: string } } | null;
}

export const MARKETING_STORAGE_KEY = 'atlas_marketing';
const TTL_MS = 90 * 24 * 60 * 60_000;
const DISABLED: MarketingConfig = { enabled: false, params: [], consentCategory: 'marketing' };
const configs = new Map<string, Promise<MarketingConfig>>();

/** Forget the cached per-instance config (tests). */
export function resetMarketingCapture(): void {
  configs.clear();
}

export function loadMarketingConfig(client: FapiClient): Promise<MarketingConfig> {
  const key = client.referralCacheKey;
  let cached = configs.get(key);
  if (!cached) {
    cached = client
      .get<{ capture?: { enabled?: boolean; params?: unknown; consent_category?: unknown } }>('/v1/client/marketing')
      .then((res) => {
        const c = res.ok ? res.data?.capture : undefined;
        if (!c?.enabled) return DISABLED;
        const params = Array.isArray(c.params) ? c.params.filter((p): p is string => typeof p === 'string') : [];
        return { enabled: true, params, consentCategory: typeof c.consent_category === 'string' ? c.consent_category : 'marketing' };
      })
      .catch(() => DISABLED);
    configs.set(key, cached);
  }
  return cached;
}

const defaultWindow = () => (typeof window === 'undefined' ? null : (window as unknown as NonNullable<MarketingOptions['win']>));
const defaultStorage = () => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** origin + path of a URL (no query, no fragment), or null. */
const originPath = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? `${u.origin}${u.pathname}` : null;
  } catch {
    return null;
  }
};

/** The touch a page URL carries: its allowed parameters, the landing page and the referrer. Null when it carries none. */
export function marketingTouchFromPage(config: MarketingConfig, win: NonNullable<MarketingOptions['win']>, now = new Date()): MarketingTouch | null {
  const search = new URLSearchParams(win.location?.search ?? '');
  const params: Record<string, string> = {};
  for (const name of config.params.length ? config.params : []) {
    const v = search.get(name);
    if (v && v.trim()) params[name] = v.trim().slice(0, 200);
  }
  if (Object.keys(params).length === 0) return null;
  const landing = win.location?.origin ? `${win.location.origin}${win.location.pathname ?? '/'}` : null;
  return { params, landing_url: originPath(landing), referrer: originPath(win.document?.referrer), captured_at: now.toISOString() };
}

const read = (storage: MarketingOptions['storage']): StoredMarketing | null => {
  try {
    const raw = storage?.getItem(MARKETING_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as StoredMarketing & { expires_at?: number };
    if (v.expires_at !== undefined && v.expires_at < Date.now()) {
      storage?.removeItem(MARKETING_STORAGE_KEY);
      return null;
    }
    return v.first_touch && v.last_touch ? v : null;
  } catch {
    return null;
  }
};

/** What has been captured so far, or null. */
export function storedMarketing(options: MarketingOptions = {}): StoredMarketing | null {
  return read(options.storage === undefined ? defaultStorage() : options.storage);
}

function consentFor(config: MarketingConfig, win: unknown, options: MarketingOptions): ConsentDecision {
  return detectConsent(win, [config.consentCategory], { provider: 'auto', appConsent: options.consent });
}

/**
 * Capture the current page's campaign parameters, when the instance captures them
 * and the visitor has consented. The first touch is kept; the last touch follows
 * the newest. Resolves true when something was stored.
 */
export async function captureMarketing(client: FapiClient, options: MarketingOptions = {}): Promise<boolean> {
  const win = options.win === undefined ? defaultWindow() : options.win;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  if (!win || !storage) return false;
  // A touch needs a query parameter; without one there is nothing to capture, so skip the config request.
  if (!win.location?.search || win.location.search === '?') return false;
  const config = await loadMarketingConfig(client);
  if (!config.enabled) return false;
  const touch = marketingTouchFromPage(config, win);
  if (!touch) return false;
  if (!consentFor(config, win, options).granted) return false;
  const prior = read(storage);
  const next = { first_touch: prior?.first_touch ?? touch, last_touch: touch, expires_at: Date.now() + TTL_MS };
  try {
    storage.setItem(MARKETING_STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/**
 * Send what was captured to the server for the signed-in user (call after a
 * sign-up completes). The server attributes only a recently created user, so an
 * existing user is untouched. Sent once; resolves true when the server recorded it.
 */
export async function flushMarketing(client: FapiClient, options: MarketingOptions = {}): Promise<boolean> {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const stored = read(storage);
  if (!stored || stored.sent) return false;
  const res = await client.post<{ recorded?: boolean }>('/v1/client/me/marketing', { ...stored.last_touch, first_touch: stored.first_touch });
  if (!res.ok) return false;
  // Whatever the server said (recorded or "not a new user"), do not keep asking.
  try {
    storage?.setItem(MARKETING_STORAGE_KEY, JSON.stringify({ ...stored, sent: true, expires_at: Date.now() + TTL_MS }));
  } catch {
    /* best effort */
  }
  return res.data?.recorded === true;
}

export interface LeadInput {
  email: string;
  name?: string;
  /** Which form this is (default `default`); one row per email per form. */
  form?: string;
  /** The person agreed to be contacted (a checkbox, or an implicit subscribe). */
  consent?: boolean;
  /** A hidden honeypot field's value: a person leaves it empty. */
  website?: string;
}

/** Submit a lead / subscribe form, with the captured attribution when there is some. */
export async function submitLead(client: FapiClient, input: LeadInput, options: MarketingOptions = {}): Promise<{ ok: boolean; error?: string }> {
  const stored = storedMarketing(options);
  const res = await client.post('/v1/client/marketing/leads', {
    email: input.email,
    ...(input.name ? { name: input.name } : {}),
    ...(input.form ? { form: input.form } : {}),
    consent: input.consent === true,
    ...(input.website ? { website: input.website } : {}),
    ...(stored ? { marketing: { ...stored.first_touch } } : {}),
  });
  return res.ok ? { ok: true } : { ok: false, error: res.errors[0]?.message ?? 'Could not submit.' };
}

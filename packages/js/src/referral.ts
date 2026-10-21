/**
 * Referral attribution: capture the referral a visitor arrived with and send it
 * on every sign-in / sign-up start, so the user Atlas creates is attributed to
 * whoever referred them.
 *
 * What is captured, when the instance has referrals on (`referrals` in
 * `GET /v1/client/environment`):
 *  - the referral code from the page URL — the instance's URL parameters
 *    (default `ref`, `via`, `aff`) on the current page, the page the SDK first
 *    loaded on, and the `redirect_url` / `after_url` query of either;
 *  - with consent, the referral platform's first-party tracking cookie (the
 *    instance's `context_cookie`): JSON or URL-encoded JSON
 *    `{code?, clickId?, anonId?}`, or a plain click id. A URL code wins over the
 *    cookie's code.
 *
 * Consent: when Cookie Munch is on the page (`window.CookieMunch`), the cookie
 * is read only when the instance's consent category is granted (else its
 * fallback category). Without a consent manager the cookie is read only when
 * the app says its own consent manager allowed it (`referralConsent:
 * 'granted'`). Otherwise the URL code alone is sent. The SDK never writes the
 * cookie. Nothing captured is trusted: the server re-validates every field.
 *
 * Opt out with `referral: false` (per client, or page-wide with
 * {@link configureReferralCapture}).
 */

/** The instance's public referral settings, camelCased. */
export interface ReferralConfig {
  enabled: boolean;
  /** URL query parameters that carry a code, in priority order. */
  urlParams: string[];
  /** The tracking cookie to read under consent; null = never read a cookie. */
  contextCookie: string | null;
  consentCategory: string;
  consentFallbackCategory: string | null;
  /** `always`: a sign-up carrying a referral code must pass the bot challenge. */
  challengeReferredSignups: 'always' | 'inherit';
}

/** The `referral` object a sign-in / sign-up request carries (snake_case, as the API takes it). */
export interface ReferralCapture {
  code: string | null;
  click_id: string | null;
  anon_id: string | null;
  consent: 'granted' | 'not_required';
  /** ISO 8601. */
  captured_at: string;
}

/**
 * The app's own consent decision for the referral cookie, used only when no
 * Cookie Munch is on the page. `'granted'` / `true` allow reading it; anything
 * else does not. A function is asked at each sign-in / sign-up start.
 */
export type ReferralConsent =
  | 'granted'
  | 'denied'
  | boolean
  | (() => 'granted' | 'denied' | boolean | null | undefined);

/** The referral options a FAPI client and the prebuilt components take. */
export interface ReferralCaptureOptions {
  /** `false` turns referral capture off. */
  referral?: false | undefined;
  /** See {@link ReferralConsent}. */
  referralConsent?: ReferralConsent;
}

export const DISABLED_REFERRAL_CONFIG: Readonly<ReferralConfig> = Object.freeze({
  enabled: false,
  urlParams: [],
  contextCookie: null,
  consentCategory: 'referrals',
  consentFallbackCategory: 'marketing',
  challengeReferredSignups: 'inherit',
});

const TOKEN = /^[A-Za-z0-9_-]{3,64}$/;
const PARAM = /^[A-Za-z0-9_.-]{1,40}$/;
const COOKIE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** A well-formed code / click id / anonymous id, or null. */
export function referralToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return TOKEN.test(v) ? v : null;
}

/**
 * Read the referral config from a `/v1/client/environment` body (or its
 * `referrals` object). Missing or malformed → disabled.
 */
export function referralConfigFrom(body: unknown): ReferralConfig {
  const raw = isRecord(body) && isRecord(body.referrals) ? body.referrals : body;
  if (!isRecord(raw) || raw.enabled !== true) return { ...DISABLED_REFERRAL_CONFIG, urlParams: [] };
  const params = Array.isArray(raw.url_params)
    ? raw.url_params.filter((p): p is string => typeof p === 'string' && PARAM.test(p)).slice(0, 10)
    : [];
  return {
    enabled: true,
    urlParams: params.length ? params : ['ref', 'via', 'aff'],
    contextCookie:
      typeof raw.context_cookie === 'string' && COOKIE_NAME.test(raw.context_cookie) ? raw.context_cookie : null,
    consentCategory:
      typeof raw.consent_category === 'string' && raw.consent_category ? raw.consent_category : 'referrals',
    consentFallbackCategory:
      typeof raw.consent_fallback_category === 'string' && raw.consent_fallback_category
        ? raw.consent_fallback_category
        : null,
    challengeReferredSignups: raw.challenge_referred_signups === 'always' ? 'always' : 'inherit',
  };
}

/** The first well-formed code among `params` in a query string. */
export function referralCodeFromSearch(search: string | null | undefined, params: readonly string[]): string | null {
  if (!search) return null;
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(search);
  } catch {
    return null;
  }
  for (const name of params) {
    const code = referralToken(query.get(name));
    if (code) return code;
  }
  return null;
}

/** The query strings a code may be in: each search, plus its `redirect_url` / `after_url` targets' queries. */
export function referralSearches(searches: readonly string[], base?: string): string[] {
  const out: string[] = [];
  const add = (s: string | null | undefined) => {
    if (s && !out.includes(s)) out.push(s);
  };
  for (const search of searches) add(search);
  for (const search of searches) {
    let query: URLSearchParams;
    try {
      query = new URLSearchParams(search);
    } catch {
      continue;
    }
    for (const key of ['redirect_url', 'after_url', 'redirect_url_complete', 'after_sign_up_url', 'after_sign_in_url']) {
      const target = query.get(key);
      if (!target) continue;
      try {
        add(new URL(target, base ?? 'https://invalid.example').search);
      } catch {
        // not a URL
      }
    }
  }
  return out;
}

/**
 * Parse a tracking-cookie value: JSON or URL-encoded JSON `{code?, clickId?,
 * anonId?}` (snake_case accepted too); a plain value is a click id.
 */
export function parseReferralCookie(
  value: string | null | undefined,
): { code: string | null; clickId: string | null; anonId: string | null } | null {
  if (typeof value !== 'string' || !value || value.length > 4096) return null;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // keep the raw value
  }
  const json = (s: string): Record<string, unknown> | null => {
    if (!s.startsWith('{')) return null;
    try {
      const parsed = JSON.parse(s) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const obj = json(value.trim()) ?? json(decoded.trim());
  if (obj) {
    const out = {
      code: referralToken(obj.code),
      clickId: referralToken(obj.clickId ?? obj.click_id),
      anonId: referralToken(obj.anonId ?? obj.anon_id),
    };
    return out.code || out.clickId || out.anonId ? out : null;
  }
  const clickId = referralToken(decoded);
  return clickId ? { code: null, clickId, anonId: null } : null;
}

/** A cookie's value from a `document.cookie` string, or null. */
export function readCookieValue(cookies: string | null | undefined, name: string): string | null {
  if (!cookies) return null;
  for (const part of cookies.split(';')) {
    const p = part.trim();
    if (p.startsWith(`${name}=`)) return p.slice(name.length + 1);
  }
  return null;
}

/**
 * Whether the referral cookie may be read. Cookie Munch on the page decides
 * when present (the instance's category, else its fallback category); else
 * the app's own `referralConsent`.
 */
export function referralConsentGranted(
  config: Pick<ReferralConfig, 'consentCategory' | 'consentFallbackCategory'>,
  cookieMunch: unknown,
  appConsent: ReferralConsent | undefined,
): boolean {
  let consent: unknown;
  try {
    consent = isRecord(cookieMunch) || typeof cookieMunch === 'function' ? (cookieMunch as { consent?: unknown }).consent : undefined;
  } catch {
    consent = undefined;
  }
  if (isRecord(consent)) {
    let v = consent[config.consentCategory];
    if (typeof v !== 'boolean' && config.consentFallbackCategory) v = consent[config.consentFallbackCategory];
    return v === true;
  }
  let decision: unknown = appConsent;
  if (typeof appConsent === 'function') {
    try {
      decision = appConsent();
    } catch {
      decision = undefined;
    }
  }
  return decision === 'granted' || decision === true;
}

/** Everything {@link captureReferral} reads from the page. */
export interface ReferralPage {
  /** Query strings to look in, most relevant first (current page, landing page). */
  searches: readonly string[];
  /** `document.cookie`. */
  cookies?: string | null;
  /** `window.CookieMunch`, if any. */
  cookieMunch?: unknown;
  /** Base for resolving a relative redirect_url. */
  base?: string;
  /** ISO time of capture. */
  capturedAt?: string;
}

/** Capture the referral for a request, or null when there is nothing to send. Pure. */
export function captureReferral(
  config: ReferralConfig,
  page: ReferralPage,
  appConsent?: ReferralConsent,
): ReferralCapture | null {
  if (!config.enabled) return null;
  let code: string | null = null;
  for (const search of referralSearches(page.searches, page.base)) {
    code = referralCodeFromSearch(search, config.urlParams);
    if (code) break;
  }
  const cookie =
    config.contextCookie && referralConsentGranted(config, page.cookieMunch, appConsent)
      ? parseReferralCookie(readCookieValue(page.cookies, config.contextCookie))
      : null;
  const out: ReferralCapture = {
    code: code ?? cookie?.code ?? null,
    click_id: cookie?.clickId ?? null,
    anon_id: cookie?.anonId ?? null,
    consent: cookie ? 'granted' : 'not_required',
    captured_at: page.capturedAt ?? new Date().toISOString(),
  };
  return out.code || out.click_id || out.anon_id ? out : null;
}

/** The FAPI POST paths that take `referral`: every sign-in / sign-up start and the steps that continue one. */
const REFERRAL_EXACT = new Set([
  '/v1/client/sign_ups',
  '/v1/client/sign_ins',
  '/v1/client/sign_ins/oauth',
  '/v1/client/sign_ins/sso',
  '/v1/client/sign_ins/saml',
  '/v1/client/sign_ins/discourse',
  '/v1/client/sign_ins/id_token',
  '/v1/client/sign_ins/id_token/nonce',
  '/v1/client/sign_ins/external_jwt',
  '/v1/client/sign_ins/ldap',
  '/v1/client/sign_ins/passkey/finish',
  '/v1/oauth/telegram',
  '/v1/oauth/siwe/nonce',
  '/v1/oauth/siwe/verify',
  '/v1/oauth/siws/nonce',
  '/v1/oauth/siws/verify',
  '/v1/oauth/siwf/nonce',
  '/v1/oauth/siwf/verify',
]);
const REFERRAL_STEP = /^\/v1\/client\/(sign_ins\/[^/]+\/(prepare_first_factor|attempt_first_factor)|sign_ups\/[^/]+\/(prepare_verification|attempt_verification))$/;

/** Whether a FAPI POST path starts or continues a sign-in / sign-up (and so takes `referral`). */
export function acceptsReferral(path: string): boolean {
  const p = path.split('?')[0] ?? path;
  return REFERRAL_EXACT.has(p) || REFERRAL_STEP.test(p);
}

// ── Page-level state ────────────────────────────────────────────────────────

type BrowserWindow = {
  location?: { search?: string; href?: string };
  document?: { cookie?: string };
  CookieMunch?: unknown;
};

const browser = (): BrowserWindow | null =>
  typeof window === 'undefined' ? null : (window as unknown as BrowserWindow);

/** The query strings the page has shown since the SDK loaded (the landing query first). */
const landingSearches: string[] = [];
let landingAt: string | null = null;

/**
 * Remember the current page's query, so a code the visitor landed with
 * survives client-side navigation that drops it. In memory only (never
 * stored). Called when the SDK loads and whenever a client is created.
 */
export function rememberReferralLanding(): void {
  const search = browser()?.location?.search;
  if (!search || landingSearches.includes(search)) return;
  landingSearches.push(search);
  landingAt ??= new Date().toISOString();
}
rememberReferralLanding();

let pageOptions: ReferralCaptureOptions = {};

/**
 * Page-wide referral options, for apps whose framework creates FAPI clients
 * internally: `configureReferralCapture({ referral: false })` opts out,
 * `{ referralConsent: 'granted' }` tells the SDK the app's own consent
 * manager allowed the referral cookie. A client's own options win.
 */
export function configureReferralCapture(options: ReferralCaptureOptions): void {
  pageOptions = { ...options };
}

/** The page-wide options set with {@link configureReferralCapture}. */
export function referralCaptureDefaults(): ReferralCaptureOptions {
  return pageOptions;
}

const configs = new Map<string, Promise<ReferralConfig>>();

/** The key an instance's referral config is cached under (a FAPI origin + publishable key). */
export function referralCacheKeyFor(baseUrl: string | null | undefined, publishableKey: string): string {
  return `${baseUrl ?? ''}|${publishableKey}`;
}

/**
 * Record an instance's referral config from a `/v1/client/environment` or
 * `/v1/appearance` body it was fetched with. A body without `referrals` (an
 * older server) is ignored.
 */
export function seedReferralConfig(cacheKey: string, environmentBody: unknown): void {
  if (!isRecord(environmentBody) || !('referrals' in environmentBody)) return;
  configs.set(cacheKey, Promise.resolve(referralConfigFrom(environmentBody)));
}

/** Forget every cached referral config (tests; an app switching instances). */
export function resetReferralCapture(): void {
  configs.clear();
  landingSearches.length = 0;
  landingAt = null;
  pageOptions = {};
}

/** What the referral helpers need from a FAPI client. */
export interface ReferralClient {
  readonly referralCacheKey: string;
  readonly referralOptions: ReferralCaptureOptions;
  get<T>(path: string): Promise<{ ok: boolean; data: T | null }>;
}

/** The instance's referral config, fetched once per page (and seeded by any environment read). */
export function loadReferralConfig(client: ReferralClient): Promise<ReferralConfig> {
  let pending = configs.get(client.referralCacheKey);
  if (!pending) {
    const key = client.referralCacheKey;
    // A failed read reads as "off" for this start and is not cached, so a later
    // start asks again.
    const failed = (): ReferralConfig => {
      if (configs.get(key) === pending) configs.delete(key);
      return { ...DISABLED_REFERRAL_CONFIG, urlParams: [] };
    };
    pending = client
      .get<unknown>('/v1/client/environment')
      .then((r) => (r.ok ? referralConfigFrom(r.data) : failed()))
      .catch(failed);
    configs.set(key, pending);
  }
  return pending;
}

/**
 * No config yet (no environment / appearance read on this page) and no query
 * anywhere to find a code in: nothing to send, and no reason to ask the
 * server. A cookie-only referral is sent once a prebuilt form (or any
 * environment read) has loaded the config.
 */
function worthAsking(client: ReferralClient): boolean {
  return configs.has(client.referralCacheKey) || !!browser()?.location?.search || landingSearches.length > 0;
}

function effectiveOptions(client: ReferralClient): ReferralCaptureOptions {
  const own = client.referralOptions;
  return {
    referral: own.referral ?? pageOptions.referral,
    referralConsent: own.referralConsent ?? pageOptions.referralConsent,
  };
}

/** The referral this client should send now, or null (off, opted out, nothing captured). Never throws. */
export async function currentReferral(client: ReferralClient): Promise<ReferralCapture | null> {
  const win = browser();
  if (!win) return null;
  const options = effectiveOptions(client);
  if (options.referral === false) return null;
  try {
    const current = win.location?.search ?? '';
    if (!worthAsking(client)) return null;
    const config = await loadReferralConfig(client);
    if (!config.enabled) return null;
    return captureReferral(
      config,
      {
        searches: [current, ...landingSearches],
        cookies: win.document?.cookie ?? null,
        cookieMunch: win.CookieMunch,
        base: win.location?.href,
        capturedAt: landingAt ?? undefined,
      },
      options.referralConsent,
    );
  } catch {
    return null;
  }
}

/**
 * Whether a sign-up / sign-in form should show the bot challenge because a
 * referral code was captured and the instance requires it for referred
 * sign-ups (even with the captcha otherwise off).
 */
export async function referralChallengeRequired(client: ReferralClient): Promise<boolean> {
  if (!browser() || effectiveOptions(client).referral === false || !worthAsking(client)) return false;
  try {
    const config = await loadReferralConfig(client);
    if (config.challengeReferredSignups !== 'always') return false;
    const ref = await currentReferral(client);
    return !!ref?.code;
  } catch {
    return false;
  }
}

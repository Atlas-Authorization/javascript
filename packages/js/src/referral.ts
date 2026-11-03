/**
 * Referral attribution: capture the referral a visitor arrived with and send it
 * on every sign-in / sign-up start, so the user Atlas creates is attributed to
 * whoever referred them.
 *
 * What is captured, when the instance has referrals on (`referrals` in
 * `GET /v1/client/environment`): ONE source, in precedence order, never
 * mixing fields across sources:
 *  1. the app's own reader (`referralSource`), for any referral program;
 *  2. a referral program's script on the page, among the instance's
 *     `browser_sources` (Referalli's `aff.getReferral()`, Rewardful, Tolt,
 *     PromoteKit; see ./referral-detect);
 *  3. explicit `ref_*` parameters (`ref`, `ref_click_id`, `ref_anon_id`,
 *     `ref_consent`, `ref_captured_at`) on the page URL;
 *  4. the referral code from the page URL — the instance's URL parameters
 *     (default `ref`, `via`, `aff`) on the current page, the page the SDK first
 *     loaded on, and the `redirect_url` / `after_url` query of either;
 *  5. the instance's tracking cookie (`context_cookie`): JSON or URL-encoded
 *     JSON `{code?, clickId?, anonId?, ts?, exp?}`, or a plain click id. An
 *     expired cookie is ignored;
 *  6. a referral program's own cookies, among `browser_sources`
 *     (FirstPromoter, PartnerStack, Dub).
 * Click and anonymous ids are sent only with consent; without it only the
 * code goes. The capture says where it came from (`source`) and who decided
 * consent (`consent_by`), for the delivery log.
 *
 * Consent: the consent manager on the page decides (the instance's
 * `consent_provider`: `auto` finds Cookie Munch, OneTrust, Cookiebot, Didomi,
 * Usercentrics, Osano, CookieYes, Complianz, Klaro, any IAB TCF v2 manager or
 * Google Consent Mode), for the instance's consent category, else its fallback
 * category. With no manager on the page, or `consent_provider: 'app'`, the
 * app's own decision (`referralConsent`) applies. Otherwise only the code is
 * sent. The SDK never writes a
 * cookie. Nothing captured is trusted: the server re-validates every field.
 *
 * Opt out with `referral: false` (per client, or page-wide with
 * {@link configureReferralCapture}). `'auto'` is the default.
 *
 * Redirects to a hosted page or `/oauth2/authorize` carry the same referral as
 * `ref_*` query parameters: {@link signIn} / {@link signUp},
 * {@link withReferralParams} and {@link referralParams}.
 */

import {
  REFERRAL_BROWSER_SOURCES,
  customReferral,
  detectConsent,
  detectReferralSource,
  listenForTcfConsent,
  type DetectedReferral,
  type ReferralSourceReader,
} from './referral-detect';

export type { ReferralSourceReader } from './referral-detect';

/** Browser sources kept in page script globals (read before the URL); the rest are cookies (read after). */
const SCRIPT_SOURCES = new Set(['referalli', 'rewardful', 'tolt', 'promotekit']);

/** The instance's public referral settings, camelCased. */
export interface ReferralConfig {
  enabled: boolean;
  /** The referral programs' scripts and cookies to read (`browser_sources`), in order. */
  sources: string[];
  /** Which consent manager decides: `auto`, a manager id, or `app` (only the app's `referralConsent`). */
  consentProvider: string;
  /** URL query parameters that carry a code, in priority order. */
  urlParams: string[];
  /** The first tracking cookie to read under consent; null = never read a cookie. */
  contextCookie: string | null;
  /** Every tracking cookie to try, in order (absent = just `contextCookie`). */
  contextCookies?: string[];
  consentCategory: string;
  consentFallbackCategory: string | null;
  /** `always`: a sign-up carrying a referral code must pass the bot challenge. */
  challengeReferredSignups: 'always' | 'inherit';
  /** Public "Invited by" lookup URL template with `{code}`, or null. See {@link lookupReferralCode}. */
  codeLookupUrl: string | null;
  /** The instance shows an optional "Referral code" field on sign-up. */
  signupCodeField: boolean;
}

/** The `referral` object a sign-in / sign-up request carries (snake_case, as the API takes it). */
export interface ReferralCapture {
  code: string | null;
  click_id: string | null;
  anon_id: string | null;
  consent: 'granted' | 'not_required';
  /** ISO 8601. */
  captured_at: string;
  /** Where it came from: `custom`, a program id (e.g. `rewardful`), `url` or `cookie`. */
  source?: string;
  /** Who decided consent for the ids: `app`, `url`, a consent manager id, or `none`. */
  consent_by?: string;
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
  /** `false` turns referral capture off; `'auto'` (the default) captures when the instance has referrals on. */
  referral?: false | 'auto' | undefined;
  /** See {@link ReferralConsent}. */
  referralConsent?: ReferralConsent;
  /**
   * Your own reader, for a referral program the SDK doesn't know: return
   * `{code, clickId, anonId}` (any of them) or null. Tried before everything else.
   */
  referralSource?: ReferralSourceReader;
}

/** The browser sources an older server (one that sends no `browser_sources`) implies. */
const DEFAULT_SOURCES = ['referalli'];

export const DISABLED_REFERRAL_CONFIG: Readonly<ReferralConfig> = Object.freeze({
  enabled: false,
  sources: [] as string[],
  consentProvider: 'auto',
  urlParams: [],
  contextCookie: null,
  contextCookies: [] as string[],
  consentCategory: 'referrals',
  consentFallbackCategory: 'marketing',
  challengeReferredSignups: 'inherit',
  codeLookupUrl: null,
  signupCodeField: false,
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
  if (!isRecord(raw) || raw.enabled !== true) return { ...DISABLED_REFERRAL_CONFIG, urlParams: [], sources: [] };
  const params = Array.isArray(raw.url_params)
    ? raw.url_params.filter((p): p is string => typeof p === 'string' && PARAM.test(p)).slice(0, 10)
    : [];
  const sources = Array.isArray(raw.browser_sources)
    ? raw.browser_sources
        .filter((s): s is string => typeof s === 'string' && /^[a-z0-9_]{1,40}$/.test(s))
        // `referally` is the retired spelling of `referalli`.
        .map((s) => (s === 'referally' ? 'referalli' : s))
        .slice(0, 20)
    : [...DEFAULT_SOURCES];
  const cookies = (
    Array.isArray(raw.context_cookies) ? raw.context_cookies : typeof raw.context_cookie === 'string' ? [raw.context_cookie] : []
  )
    .filter((c): c is string => typeof c === 'string' && COOKIE_NAME.test(c))
    .filter((c, i, all) => all.indexOf(c) === i)
    .slice(0, 5);
  return {
    enabled: true,
    sources,
    consentProvider:
      typeof raw.consent_provider === 'string' && /^[a-z0-9_]{1,40}$/.test(raw.consent_provider) ? raw.consent_provider : 'auto',
    urlParams: params.length ? params : ['ref', 'via', 'aff'],
    contextCookie: cookies[0] ?? null,
    contextCookies: cookies,
    consentCategory:
      typeof raw.consent_category === 'string' && raw.consent_category ? raw.consent_category : 'referrals',
    consentFallbackCategory:
      typeof raw.consent_fallback_category === 'string' && raw.consent_fallback_category
        ? raw.consent_fallback_category
        : null,
    challengeReferredSignups: raw.challenge_referred_signups === 'always' ? 'always' : 'inherit',
    codeLookupUrl:
      typeof raw.code_lookup_url === 'string' && /^https?:\/\//i.test(raw.code_lookup_url) && raw.code_lookup_url.includes('{code}')
        ? raw.code_lookup_url
        : null,
    signupCodeField: raw.signup_code_field === true,
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

/** An ISO time from an ISO string or unix seconds / milliseconds, or null. */
export function referralTime(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  if (typeof value !== 'string' || !value || value.length > 40) return null;
  if (/^\d{9,13}$/.test(value)) return referralTime(Number(value));
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** One referral source's raw fields. */
export interface ReferralSourceFields {
  code: string | null;
  clickId: string | null;
  anonId: string | null;
  /** ISO 8601, when the source says when it captured the referral. */
  capturedAt?: string;
}

/**
 * Parse a tracking-cookie value: JSON or URL-encoded JSON `{code?, clickId?,
 * anonId?, ts?, exp?}` (snake_case accepted too); a plain value is a click id.
 * `ts` (unix seconds or ms) becomes `capturedAt`; a cookie past its `exp` is
 * ignored.
 */
export function parseReferralCookie(value: string | null | undefined, now: number = Date.now()): ReferralSourceFields | null {
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
    const exp = referralTime(obj.exp);
    if (exp && Date.parse(exp) <= now) return null;
    const out: ReferralSourceFields = {
      code: referralToken(obj.code),
      clickId: referralToken(obj.clickId ?? obj.click_id),
      anonId: referralToken(obj.anonId ?? obj.anon_id),
    };
    const ts = referralTime(obj.ts);
    if (ts) out.capturedAt = ts;
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
 * Whether the referral cookie may be read, with only Cookie Munch to ask (the
 * shape before consent managers were detected generally). Cookie Munch on the
 * page decides when present (the instance's category, else its fallback
 * category); else the app's own `referralConsent`. See {@link detectConsent}
 * for every manager.
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
  /** `window`: its referral scripts and consent manager are read. */
  win?: unknown;
  /** `window.CookieMunch`, when no `win` is given (older callers). */
  cookieMunch?: unknown;
  /** `window.aff`, when no `win` is given (older callers). */
  aff?: unknown;
  /** Base for resolving a relative redirect_url. */
  base?: string;
  /** ISO time of capture. */
  capturedAt?: string;
}

/** The `ref_*` keys that mark a query as carrying an explicit referral (a bare `?ref=` is a landing code). */
const EXPLICIT_MARKERS = ['ref_click_id', 'ref_anon_id', 'ref_consent', 'ref_captured_at'];

/** What the page's referral script (`window.aff.getReferral()`) holds, or null. Never throws. */
export function referralFromScript(aff: unknown): ReferralSourceFields | null {
  let r: unknown;
  try {
    const get = isRecord(aff) || typeof aff === 'function' ? (aff as { getReferral?: unknown }).getReferral : undefined;
    r = typeof get === 'function' ? (get as () => unknown).call(aff) : null;
  } catch {
    return null;
  }
  if (!isRecord(r)) return null;
  const out: ReferralSourceFields = {
    code: referralToken(r.code),
    clickId: referralToken(r.clickId ?? r.click_id),
    anonId: referralToken(r.anonId ?? r.anon_id),
  };
  const ts = referralTime(r.ts);
  if (ts) out.capturedAt = ts;
  return out.code || out.clickId || out.anonId ? out : null;
}

/** The explicit `ref_*` referral in a query string, or null. `consent` is whether ids may be kept. */
export function explicitReferralFromSearch(
  search: string | null | undefined,
): (ReferralSourceFields & { consentGranted: boolean }) | null {
  if (!search) return null;
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(search);
  } catch {
    return null;
  }
  if (!EXPLICIT_MARKERS.some((k) => query.get(k) !== null)) return null;
  const granted = query.get('ref_consent') === 'granted';
  const out: ReferralSourceFields & { consentGranted: boolean } = {
    code: referralToken(query.get('ref')),
    clickId: referralToken(query.get('ref_click_id')),
    anonId: referralToken(query.get('ref_anon_id')),
    consentGranted: granted,
  };
  const at = referralTime(query.get('ref_captured_at'));
  if (at) out.capturedAt = at;
  return out.code || out.clickId || out.anonId ? out : null;
}

/** One source as the API's `referral` object: ids only with consent; null when nothing usable remains. */
function asCapture(
  source: ReferralSourceFields,
  consent: () => { granted: boolean; by: string },
  capturedAt: string,
  from: string,
): ReferralCapture | null {
  const hasIds = !!(source.clickId || source.anonId);
  const decision = hasIds ? consent() : null;
  const ids = !!decision?.granted;
  const out: ReferralCapture = {
    code: source.code,
    click_id: ids ? source.clickId : null,
    anon_id: ids ? source.anonId : null,
    consent: ids ? 'granted' : 'not_required',
    captured_at: source.capturedAt ?? capturedAt,
    source: from,
    ...(decision ? { consent_by: decision.by } : {}),
  };
  return out.code || out.click_id || out.anon_id ? out : null;
}

/** The page's `window` for the readers: `page.win`, else the older `cookieMunch` / `aff` fields. */
function pageWindow(page: ReferralPage): unknown {
  if (page.win !== undefined) return page.win;
  return { CookieMunch: page.cookieMunch, aff: page.aff };
}

/**
 * Capture the referral for a request, or null when there is nothing to send.
 * Pure. One source wins, in the order described at the top of this module;
 * fields are never mixed across sources. Ids need consent: the app's
 * `referralConsent`, `ref_consent=granted` on an explicit URL, or the consent
 * manager on the page.
 */
export function captureReferral(
  config: ReferralConfig,
  page: ReferralPage,
  appConsent?: ReferralConsent,
  customSource?: ReferralSourceReader,
): ReferralCapture | null {
  if (!config.enabled) return null;
  const at = page.capturedAt ?? new Date().toISOString();
  const win = pageWindow(page);
  let decided: { granted: boolean; by: string } | undefined;
  const consent = () =>
    (decided ??= detectConsent(win, [config.consentCategory, config.consentFallbackCategory], {
      provider: config.consentProvider,
      appConsent,
    }));
  const fromDetected = (d: DetectedReferral | null) => (d ? asCapture(d, consent, at, d.source) : null);
  const sources = config.sources ?? DEFAULT_SOURCES;
  const detectPage = { win, cookies: page.cookies };

  const custom = fromDetected(customReferral(customSource));
  if (custom) return custom;
  const script = fromDetected(detectReferralSource(detectPage, sources.filter((s) => SCRIPT_SOURCES.has(s))));
  if (script) return script;
  const searches = referralSearches(page.searches, page.base);
  for (const search of searches) {
    const explicit = explicitReferralFromSearch(search);
    if (!explicit) continue;
    const out = asCapture(explicit, () => (explicit.consentGranted ? { granted: true, by: 'url' } : consent()), at, 'url');
    if (out) return out;
  }
  for (const search of searches) {
    const code = referralCodeFromSearch(search, config.urlParams);
    if (code) return { code, click_id: null, anon_id: null, consent: 'not_required', captured_at: at, source: 'url' };
  }
  // The tracking cookies in order: the first one that holds a usable referral wins.
  for (const name of config.contextCookies ?? (config.contextCookie ? [config.contextCookie] : [])) {
    const cookie = parseReferralCookie(readCookieValue(page.cookies, name));
    const fromCookie = cookie ? asCapture(cookie, consent, at, 'cookie') : null;
    if (fromCookie) return fromCookie;
  }
  return fromDetected(detectReferralSource(detectPage, sources.filter((s) => !SCRIPT_SOURCES.has(s))));
}

/** The FAPI POST paths that take `referral`: every sign-in / sign-up start and the steps that continue one. */
const REFERRAL_EXACT = new Set([
  '/v1/client/sign_ups',
  '/v1/client/sign_ups/passkey',
  '/v1/client/sign_ins',
  '/v1/client/sign_ins/oauth',
  '/v1/client/sign_ins/sso',
  '/v1/client/sign_ins/saml',
  '/v1/client/sign_ins/wsfed',
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
  '/v1/oauth/siwb/nonce',
  '/v1/oauth/siwb/verify',
  '/v1/oauth/siwf/nonce',
  '/v1/oauth/siwf/verify',
]);
const REFERRAL_STEP = /^\/v1\/client\/(sign_ins\/[^/]+\/(prepare_first_factor|attempt_first_factor)|sign_ups\/[^/]+\/(prepare_verification|attempt_verification|passkey\/finish))$/;

/** Whether a FAPI POST path starts or continues a sign-in / sign-up (and so takes `referral`). */
export function acceptsReferral(path: string): boolean {
  const p = path.split('?')[0] ?? path;
  return REFERRAL_EXACT.has(p) || REFERRAL_STEP.test(p);
}

// ── Page-level state ────────────────────────────────────────────────────────

type BrowserWindow = {
  location?: { search?: string; href?: string; assign?: (url: string) => void };
  document?: { cookie?: string };
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
// An IAB TCF manager answers through a callback: listen early so its answer is ready at sign-in.
if (browser()) listenForTcfConsent(browser());

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
  const win = browser();
  return (
    configs.has(client.referralCacheKey) ||
    !!win?.location?.search ||
    landingSearches.length > 0 ||
    customReferral(effectiveOptions(client).referralSource) !== null ||
    detectReferralSource({ win, cookies: win?.document?.cookie ?? null }, REFERRAL_BROWSER_SOURCES) !== null
  );
}

function effectiveOptions(client: ReferralClient): ReferralCaptureOptions {
  const own = client.referralOptions;
  return {
    referral: own.referral ?? pageOptions.referral,
    referralConsent: own.referralConsent ?? pageOptions.referralConsent,
    referralSource: own.referralSource ?? pageOptions.referralSource,
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
    listenForTcfConsent(win);
    return captureReferral(
      config,
      {
        searches: [current, ...landingSearches],
        cookies: win.document?.cookie ?? null,
        win,
        base: win.location?.href,
        capturedAt: landingAt ?? undefined,
      },
      options.referralConsent,
      options.referralSource,
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

// ── Redirects: the referral as ref_* query parameters ──────────────────────

/** Options for {@link referralParams}, {@link withReferralParams}, {@link signIn} and {@link signUp}. */
export interface ReferralRedirectOptions {
  /** `false`: add nothing. `'auto'` (default): capture as described above. */
  referral?: false | 'auto';
  /**
   * The app's consent for referral tracking (click and anonymous ids). When
   * omitted, the page-wide `referralConsent` applies, else the consent manager
   * on the page (`referrals`, else `marketing`), else no consent (code only).
   */
  consent?: ReferralConsent;
  /** Your own reader for a referral program the SDK doesn't know (see {@link ReferralCaptureOptions.referralSource}). */
  source?: ReferralSourceReader;
  /**
   * The instance's config, when the app has it. Defaults: `ref` / `via` /
   * `aff`, no tracking cookie, every known referral script and cookie, and
   * any consent manager.
   */
  config?: ReferralConfig;
}

/**
 * The referral this page would send, as `ref_*` query parameters (`[]` when
 * there is none). Synchronous: it uses the instance config when one was
 * loaded on this page (or passed), else the default URL parameters. Consent
 * comes from `consent`, else Cookie Munch on the page.
 */
export function referralParams(options: ReferralRedirectOptions = {}): Array<[string, string]> {
  const win = browser();
  if (!win || options.referral === false || pageOptions.referral === false) return [];
  try {
    const config: ReferralConfig = options.config?.enabled
      ? options.config
      : { ...DISABLED_REFERRAL_CONFIG, enabled: true, urlParams: ['ref', 'via', 'aff'], sources: [...REFERRAL_BROWSER_SOURCES] };
    listenForTcfConsent(win);
    const ref = captureReferral(
      config,
      {
        searches: [win.location?.search ?? '', ...landingSearches],
        cookies: win.document?.cookie ?? null,
        win,
        base: win.location?.href,
        capturedAt: landingAt ?? undefined,
      },
      options.consent ?? pageOptions.referralConsent,
      options.source ?? pageOptions.referralSource,
    );
    if (!ref) return [];
    const out: Array<[string, string]> = [];
    if (ref.code) out.push(['ref', ref.code]);
    if (ref.click_id) out.push(['ref_click_id', ref.click_id]);
    if (ref.anon_id) out.push(['ref_anon_id', ref.anon_id]);
    out.push(['ref_consent', ref.consent]);
    out.push(['ref_captured_at', ref.captured_at]);
    if (ref.source) out.push(['ref_source', ref.source]);
    if (ref.consent_by) out.push(['ref_consent_by', ref.consent_by]);
    return out;
  } catch {
    return [];
  }
}

/** `url` with the page's referral added as `ref_*` parameters (existing ones are kept, never replaced). */
export function withReferralParams(url: string, options: ReferralRedirectOptions = {}): string {
  const params = referralParams(options);
  if (!params.length) return url;
  let u: URL;
  try {
    u = new URL(url, browser()?.location?.href ?? undefined);
  } catch {
    return url;
  }
  for (const [k, v] of params) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  return u.toString();
}

/** Where {@link signIn} / {@link signUp} go. */
export interface HostedRedirectOptions extends ReferralRedirectOptions {
  /**
   * A full URL to go to: a hosted page, `/oauth2/authorize?...`, or your own
   * login route. Wins over `frontendApi`.
   */
  url?: string;
  /** The instance's Frontend API host or origin (e.g. `accounts.example.com`), for its hosted page. */
  frontendApi?: string;
  /** Where the hosted page sends the user afterwards (`redirect_url`). */
  redirectUrl?: string;
  /** `false`: return the URL without navigating. Default true. */
  navigate?: boolean;
}

function hostedUrl(page: 'sign-in' | 'sign-up', options: HostedRedirectOptions): string {
  if (options.url) return options.url;
  if (!options.frontendApi) throw new Error('signIn/signUp need url or frontendApi');
  const origin = /^https?:\/\//i.test(options.frontendApi) ? options.frontendApi : `https://${options.frontendApi}`;
  const u = new URL(`/hosted/${page}`, origin);
  if (options.redirectUrl) u.searchParams.set('redirect_url', options.redirectUrl);
  return u.toString();
}

function go(page: 'sign-in' | 'sign-up', options: HostedRedirectOptions): string {
  const target = withReferralParams(hostedUrl(page, options), options);
  if (options.navigate !== false) browser()?.location?.assign?.(target);
  return target;
}

/**
 * Send the visitor to the hosted sign-in page (or `url`), carrying the
 * referral they arrived with as `ref_*` parameters (`referral: 'auto'`, the
 * default). Returns the URL it went to.
 *
 * ```ts
 * signIn({ frontendApi: 'accounts.example.com', redirectUrl: location.href, consent: () => cmp.granted('referrals') });
 * ```
 */
export function signIn(options: HostedRedirectOptions): string {
  return go('sign-in', options);
}

/** {@link signIn} for the hosted sign-up page. */
export function signUp(options: HostedRedirectOptions): string {
  return go('sign-up', options);
}

// ── "Invited by" ─────────────────────────────────────────────────────────────

/** What a code lookup answers. */
export interface ReferralCodeLookup {
  valid: boolean;
  partnerDisplayName?: string;
  /** Platform-defined; a string or an object with a `description`. */
  refereeReward?: unknown;
}

/**
 * Ask the instance's public code lookup (`code_lookup_url`) about a code, for
 * an "X invited you" line. No credentials, `timeoutMs` (default 3000). Null
 * when there is no lookup, the code is malformed, or the lookup fails: never
 * block a sign-up on it.
 */
export async function lookupReferralCode(
  config: Pick<ReferralConfig, 'codeLookupUrl'> | string | null | undefined,
  code: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ReferralCodeLookup | null> {
  const template = typeof config === 'string' ? config : config?.codeLookupUrl;
  const token = referralToken(code);
  const f = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!template || !token || !f) return null;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), options.timeoutMs ?? 3000);
  try {
    const res = await f(template.split('{code}').join(encodeURIComponent(token)), {
      method: 'GET',
      credentials: 'omit',
      headers: { accept: 'application/json' },
      signal: ctrl?.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (!isRecord(body) || typeof body.valid !== 'boolean') return null;
    return {
      valid: body.valid,
      ...(typeof body.partnerDisplayName === 'string' ? { partnerDisplayName: body.partnerDisplayName } : {}),
      ...(body.refereeReward !== undefined ? { refereeReward: body.refereeReward } : {}),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

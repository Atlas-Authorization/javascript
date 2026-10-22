/**
 * Referral sources and consent managers the SDK recognises on the page, so
 * referral capture works with any referral program and any consent manager.
 *
 * Sources: the referral script or cookie a program puts on the merchant's
 * site. Each reader returns `{code, clickId, anonId}` (and `capturedAt` when
 * the source says when): the code is the referrer's, the ids are the
 * visitor's (sent only with consent). The instance lists which sources to read
 * (`browser_sources`), so one program's script never feeds another program's
 * connection. A custom program passes its own reader as `referralSource`.
 *
 * Consent: the first consent manager found on the page decides whether the
 * referral cookie's ids may be read, for the instance's consent category, else
 * its fallback category. The visitor's answer in a consent manager is the
 * source of truth: the app's own decision (`referralConsent`) applies only
 * when no manager is on the page, or when the instance says the app decides
 * (`consent_provider: 'app'`). Common names map onto each manager's own:
 * `marketing` (also advertising / targeting), `statistics` (analytics /
 * performance) and `preferences` (functional / personalization); any other
 * name is looked up as the manager's own category id. IAB TCF v2 managers
 * answer with Purpose 1 (store and access information on a device).
 *
 * Every reader is defensive: a missing, half-loaded or throwing script reads
 * as "nothing here". The ES5 copy in the Atlas API (hosted pages and the Sign
 * in with Atlas button) follows the same rules and is tested against the same
 * fixtures.
 */

const TOKEN = /^[A-Za-z0-9_-]{3,64}$/;

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => !!v && typeof v === 'object' && !Array.isArray(v);
const token = (v: unknown): string | null => (typeof v === 'string' && TOKEN.test(v.trim()) ? v.trim() : null);

/** What a browser source holds. */
export interface DetectedReferral {
  /** The source id (e.g. `rewardful`), or `custom` for the app's own reader. */
  source: string;
  code: string | null;
  clickId: string | null;
  anonId: string | null;
  /** ISO 8601, when the source says when it captured the referral. */
  capturedAt?: string;
}

/** The app's own reader, for a referral program the SDK doesn't know. */
export type ReferralSourceReader = () =>
  | { code?: string | null; clickId?: string | null; anonId?: string | null; capturedAt?: string | number | null }
  | null
  | undefined;

/** The browser sources the SDK reads, in the order it tries them. */
export const REFERRAL_BROWSER_SOURCES = [
  'referally',
  'rewardful',
  'tolt',
  'promotekit',
  'firstpromoter',
  'partnerstack',
  'dub',
] as const;
export type ReferralBrowserSource = (typeof REFERRAL_BROWSER_SOURCES)[number];

/** The consent managers the SDK reads, in the order `auto` tries them. */
export const CONSENT_PROVIDERS = [
  'cookiemunch',
  'onetrust',
  'cookiebot',
  'didomi',
  'usercentrics',
  'osano',
  'cookieyes',
  'complianz',
  'klaro',
  'tcf',
  'consent_mode',
] as const;
export type ConsentProvider = (typeof CONSENT_PROVIDERS)[number];

/** The page as the readers see it: `window`, and `document.cookie`. */
export interface DetectPage {
  win: unknown;
  cookies: string | null | undefined;
}

function prop(o: unknown, key: string): unknown {
  try {
    return o != null && (typeof o === 'object' || typeof o === 'function') ? (o as Bag)[key] : undefined;
  } catch {
    return undefined;
  }
}

function call(fn: unknown, self: unknown, ...args: unknown[]): unknown {
  try {
    return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown).apply(self, args) : undefined;
  } catch {
    return undefined;
  }
}

function cookie(cookies: string | null | undefined, name: string): string | null {
  if (!cookies) return null;
  for (const part of cookies.split(';')) {
    const p = part.trim();
    if (p.startsWith(`${name}=`)) {
      const raw = p.slice(name.length + 1);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

function time(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && v && v.length <= 40) {
    if (/^\d{9,13}$/.test(v)) return time(Number(v));
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return undefined;
}

function found(source: string, code: unknown, clickId: unknown, anonId: unknown, at?: unknown): DetectedReferral | null {
  const out: DetectedReferral = { source, code: token(code), clickId: token(clickId), anonId: token(anonId) };
  const ts = time(at);
  if (ts) out.capturedAt = ts;
  return out.code || out.clickId || out.anonId ? out : null;
}

/** Each known source: where its script or cookie keeps the referral. */
const READERS: Record<ReferralBrowserSource, (page: DetectPage) => DetectedReferral | null> = {
  // Referally's aff.js: aff.getReferral() → {code, clickId, anonId, ts}.
  referally: ({ win }) => {
    const aff = prop(win, 'aff');
    const r = call(prop(aff, 'getReferral'), aff);
    if (!isBag(r)) return null;
    return found('referally', r.code, r.clickId ?? r.click_id, r.anonId ?? r.anon_id, r.ts);
  },
  // Rewardful's rw.js: Rewardful.referral (the referral id) and Rewardful.affiliate.token (the link code).
  rewardful: ({ win }) => {
    const rw = prop(win, 'Rewardful');
    return found('rewardful', prop(prop(rw, 'affiliate'), 'token'), prop(rw, 'referral'), null);
  },
  // Tolt's script: window.tolt_referral (the referral id).
  tolt: ({ win }) => found('tolt', null, prop(win, 'tolt_referral'), null),
  // PromoteKit's script: window.promotekit_referral (the referral id).
  promotekit: ({ win }) => found('promotekit', null, prop(win, 'promotekit_referral'), null),
  // FirstPromoter's cookies: _fprom_tid (tracking id) and _fprom_ref (the referral code).
  firstpromoter: ({ cookies }) => found('firstpromoter', cookie(cookies, '_fprom_ref'), cookie(cookies, '_fprom_tid'), null),
  // PartnerStack's cookies: ps_xid (click id) and ps_partner_key (the partner's key).
  partnerstack: ({ cookies }) => found('partnerstack', cookie(cookies, 'ps_partner_key'), cookie(cookies, 'ps_xid'), null),
  // Dub's analytics script cookie: dub_id (click id).
  dub: ({ cookies }) => found('dub', null, cookie(cookies, 'dub_id'), null),
};

/** The app's own reader, as a detected referral (source `custom`). Never throws. */
export function customReferral(reader: ReferralSourceReader | undefined): DetectedReferral | null {
  if (typeof reader !== 'function') return null;
  let r: unknown;
  try {
    r = reader();
  } catch {
    return null;
  }
  if (!isBag(r)) return null;
  return found('custom', r.code, r.clickId ?? r.click_id, r.anonId ?? r.anon_id, r.capturedAt ?? r.ts);
}

/** The first of `sources` with a referral on the page, or null. Unknown ids are skipped. */
export function detectReferralSource(page: DetectPage, sources: readonly string[]): DetectedReferral | null {
  for (const id of sources) {
    const read = (READERS as Record<string, ((p: DetectPage) => DetectedReferral | null) | undefined>)[id];
    if (!read) continue;
    let r: DetectedReferral | null = null;
    try {
      r = read(page);
    } catch {
      r = null;
    }
    if (r) return r;
  }
  return null;
}

// ── Consent ──────────────────────────────────────────────────────────────────

type Canonical = 'necessary' | 'preferences' | 'statistics' | 'marketing';
const ALIASES: Record<string, Canonical> = {
  necessary: 'necessary',
  essential: 'necessary',
  strictly_necessary: 'necessary',
  preferences: 'preferences',
  functional: 'preferences',
  functionality: 'preferences',
  personalization: 'preferences',
  statistics: 'statistics',
  analytics: 'statistics',
  performance: 'statistics',
  marketing: 'marketing',
  advertising: 'marketing',
  advertisement: 'marketing',
  targeting: 'marketing',
  ads: 'marketing',
};

/** A consent category's common meaning, if it has one. */
export function canonicalCategory(name: string): Canonical | null {
  return ALIASES[name.trim().toLowerCase()] ?? null;
}

/** A manager's answer for one category: true / false, or undefined when it doesn't know the category. */
type Asker = (win: unknown, category: string) => boolean | undefined;
/** Whether the manager is on the page, and how to ask it. */
interface Manager {
  present(win: unknown): boolean;
  ask: Asker;
}

const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** Look a category up by its own name, then by its common meaning's native name. */
function byName(native: Partial<Record<Canonical, string>>, lookup: (key: string) => boolean | undefined): Asker {
  return (_win, category) => {
    const own = lookup(category);
    if (own !== undefined) return own;
    const c = canonicalCategory(category);
    const mapped = c ? native[c] : undefined;
    return mapped ? lookup(mapped) : undefined;
  };
}

/** The latest IAB TCF data, kept by a listener registered when the SDK loads. */
let tcfCache: { gdprApplies?: unknown; purpose?: unknown; eventStatus?: unknown } | null = null;
let tcfListening = false;

/**
 * Start listening to an IAB TCF v2 manager (`__tcfapi`), so its answer is
 * ready synchronously when a sign-in starts. Safe to call more than once.
 */
export function listenForTcfConsent(win: unknown): void {
  const api = prop(win, '__tcfapi');
  if (tcfListening || typeof api !== 'function') return;
  tcfListening = true;
  call(api, win, 'addEventListener', 2, (data: unknown, ok: unknown) => {
    if (ok && isBag(data)) tcfCache = data;
  });
}

/** Forget the cached TCF data (tests). */
export function resetConsentDetection(): void {
  tcfCache = null;
  tcfListening = false;
}

function tcfData(win: unknown): Bag | null {
  if (tcfCache) return tcfCache as Bag;
  // Most managers answer getTCData synchronously once loaded.
  let data: Bag | null = null;
  call(prop(win, '__tcfapi'), win, 'getTCData', 2, (d: unknown, ok: unknown) => {
    if (ok && isBag(d)) data = d;
  });
  return data;
}

const STANDARD = { necessary: 'necessary', preferences: 'preferences', statistics: 'statistics', marketing: 'marketing' } as const;
const has = (list: unknown, k: string) => Array.isArray(list) && list.includes(k);

const MANAGERS: Record<ConsentProvider, Manager> = {
  // Cookie Munch: CookieMunch.consent → {necessary, preferences, statistics, marketing, <custom>…}.
  cookiemunch: {
    present: (w) => isBag(prop(prop(w, 'CookieMunch'), 'consent')),
    ask: (w, category) => {
      const c = prop(prop(w, 'CookieMunch'), 'consent');
      return byName(STANDARD, (k) => bool(prop(c, k)))(w, category);
    },
  },
  // OneTrust: OnetrustActiveGroups = ",C0001,C0002,…" (the groups consented to).
  onetrust: {
    present: (w) => typeof (prop(w, 'OnetrustActiveGroups') ?? prop(w, 'OptanonActiveGroups')) === 'string',
    ask: (w, category) => {
      const groups = String(prop(w, 'OnetrustActiveGroups') ?? prop(w, 'OptanonActiveGroups') ?? '')
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);
      // A group id (C0004, or a custom one the page uses) is answered by membership; other names are unknown.
      return byName({ necessary: 'C0001', statistics: 'C0002', preferences: 'C0003', marketing: 'C0004' }, (k) =>
        /^C\d{4}$/.test(k) || groups.includes(k) ? groups.includes(k) : undefined,
      )(w, category);
    },
  },
  // Cookiebot: Cookiebot.consent → {necessary, preferences, statistics, marketing}. Cookie Munch also
  // publishes a Cookiebot alias, so Cookiebot counts only without Cookie Munch.
  cookiebot: {
    present: (w) => !prop(w, 'CookieMunch') && isBag(prop(prop(w, 'Cookiebot'), 'consent')),
    ask: (w, category) => {
      const c = prop(prop(w, 'Cookiebot'), 'consent');
      return byName(STANDARD, (k) => bool(prop(c, k)))(w, category);
    },
  },
  // Didomi: Didomi.getUserStatus().purposes.global.{enabled, disabled}. Marketing maps to
  // Purpose 1 ("cookies": store and access information on a device).
  didomi: {
    present: (w) => typeof prop(prop(w, 'Didomi'), 'getUserStatus') === 'function',
    ask: (w, category) => {
      const didomi = prop(w, 'Didomi');
      const global = prop(prop(call(prop(didomi, 'getUserStatus'), didomi), 'purposes'), 'global');
      const enabled = prop(global, 'enabled');
      const disabled = prop(global, 'disabled');
      return byName({ marketing: 'cookies', statistics: 'measure_content_performance' }, (k) =>
        has(enabled, k) ? true : has(disabled, k) ? false : undefined,
      )(w, category);
    },
  },
  // Usercentrics: UC_UI.getServicesBaseInfo() → [{categorySlug, consent: {status}}]; a category is
  // granted when every service in it is.
  usercentrics: {
    present: (w) => typeof prop(prop(w, 'UC_UI'), 'getServicesBaseInfo') === 'function',
    ask: (w, category) => {
      const uc = prop(w, 'UC_UI');
      const services = call(prop(uc, 'getServicesBaseInfo'), uc);
      if (!Array.isArray(services)) return undefined;
      return byName({ necessary: 'essential', preferences: 'functional', statistics: 'functional', marketing: 'marketing' }, (slug) => {
        const inCategory = services.filter((s) => prop(s, 'categorySlug') === slug);
        return inCategory.length ? inCategory.every((s) => prop(prop(s, 'consent'), 'status') === true) : undefined;
      })(w, category);
    },
  },
  // Osano: Osano.cm.getConsent() → {MARKETING: 'ACCEPT' | 'DENY', ANALYTICS, PERSONALIZATION, ESSENTIAL}.
  osano: {
    present: (w) => typeof prop(prop(prop(w, 'Osano'), 'cm'), 'getConsent') === 'function',
    ask: (w, category) => {
      const cm = prop(prop(w, 'Osano'), 'cm');
      const consent = call(prop(cm, 'getConsent'), cm);
      return byName({ necessary: 'ESSENTIAL', preferences: 'PERSONALIZATION', statistics: 'ANALYTICS', marketing: 'MARKETING' }, (k) => {
        const v = prop(consent, k) ?? prop(consent, k.toUpperCase());
        return v === 'ACCEPT' ? true : v === 'DENY' ? false : undefined;
      })(w, category);
    },
  },
  // CookieYes: getCkyConsent().categories → {necessary, functional, analytics, performance, advertisement}.
  cookieyes: {
    present: (w) => typeof prop(w, 'getCkyConsent') === 'function',
    ask: (w, category) => {
      const categories = prop(call(prop(w, 'getCkyConsent'), w), 'categories');
      return byName({ necessary: 'necessary', preferences: 'functional', statistics: 'analytics', marketing: 'advertisement' }, (k) =>
        bool(prop(categories, k)),
      )(w, category);
    },
  },
  // Complianz: cmplz_has_consent(category) → boolean.
  complianz: {
    present: (w) => typeof prop(w, 'cmplz_has_consent') === 'function',
    ask: (w, category) =>
      byName({ necessary: 'functional', preferences: 'preferences', statistics: 'statistics', marketing: 'marketing' }, (k) =>
        bool(call(prop(w, 'cmplz_has_consent'), w, k)),
      )(w, category),
  },
  // Klaro: klaro.getManager().consents → {service: boolean}; the category names a service.
  klaro: {
    present: (w) => typeof prop(prop(w, 'klaro'), 'getManager') === 'function',
    ask: (w, category) => {
      const klaro = prop(w, 'klaro');
      const consents = prop(call(prop(klaro, 'getManager'), klaro), 'consents');
      return bool(prop(consents, category));
    },
  },
  // IAB TCF v2: Purpose 1 (store and access information on a device) governs the cookie; where
  // GDPR doesn't apply, no consent is needed.
  tcf: {
    present: (w) => typeof prop(w, '__tcfapi') === 'function',
    ask: (w) => {
      const data = tcfData(w);
      if (!data) return undefined;
      if (data.gdprApplies === false) return true;
      return bool(prop(prop(prop(data, 'purpose'), 'consents'), '1')) ?? false;
    },
  },
  // Google Consent Mode: ad_storage / analytics_storage / functionality_storage, updated else default.
  consent_mode: {
    present: (w) => isBag(prop(prop(prop(w, 'google_tag_data'), 'ics'), 'entries')),
    ask: (w, category) => {
      const entries = prop(prop(prop(w, 'google_tag_data'), 'ics'), 'entries');
      return byName({ preferences: 'functionality_storage', statistics: 'analytics_storage', marketing: 'ad_storage' }, (k) => {
        const e = prop(entries, k);
        return bool(prop(e, 'update')) ?? bool(prop(e, 'default'));
      })(w, category);
    },
  },
};

/** A consent decision and who made it (`app`, a manager id, or `none`). */
export interface ConsentDecision {
  granted: boolean;
  by: string;
}

/** The app's own decision (`referralConsent`), when definite. */
export type AppConsent = 'granted' | 'denied' | boolean | (() => 'granted' | 'denied' | boolean | null | undefined);

function appDecision(appConsent: AppConsent | undefined): boolean | undefined {
  let d: unknown = appConsent;
  if (typeof appConsent === 'function') {
    try {
      d = appConsent();
    } catch {
      d = undefined;
    }
  }
  if (d === 'granted' || d === true) return true;
  if (d === 'denied' || d === false) return false;
  return undefined;
}

/**
 * Whether the referral cookie's ids may be read, and who decided. A consent
 * manager on the page decides (`provider`: `auto` tries each in order, a
 * manager id asks only that one); a manager that doesn't know either category
 * answers no. With no manager, or `provider: 'app'`, the app's definite answer
 * decides; else no.
 */
export function detectConsent(
  win: unknown,
  categories: readonly (string | null | undefined)[],
  options: { provider?: string | null; appConsent?: AppConsent } = {},
): ConsentDecision {
  const provider = options.provider || 'auto';
  const fromApp = (): ConsentDecision => {
    const app = appDecision(options.appConsent);
    return app === undefined ? { granted: false, by: 'none' } : { granted: app, by: 'app' };
  };
  if (provider === 'app') return fromApp();
  const ids: readonly string[] = provider === 'auto' ? CONSENT_PROVIDERS : [provider];
  const names = categories.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
  for (const id of ids) {
    const m = (MANAGERS as Record<string, Manager | undefined>)[id];
    let present = false;
    try {
      present = !!m && m.present(win);
    } catch {
      present = false;
    }
    if (!m || !present) continue;
    for (const name of names) {
      let v: boolean | undefined;
      try {
        v = m.ask(win, name);
      } catch {
        v = undefined;
      }
      if (v !== undefined) return { granted: v, by: id };
    }
    return { granted: false, by: id };
  }
  return fromApp();
}

/** Which consent manager is on the page (`auto` order), or null. For diagnostics. */
export function detectConsentProvider(win: unknown): ConsentProvider | null {
  for (const id of CONSENT_PROVIDERS) {
    try {
      if (MANAGERS[id].present(win)) return id;
    } catch {
      // keep looking
    }
  }
  return null;
}

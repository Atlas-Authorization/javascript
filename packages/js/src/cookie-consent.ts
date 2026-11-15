/**
 * The cookie consent store, from the browser. Your consent banner (or a custom one) keeps each
 * visitor's choice with Atlas, asks on the next visit whether it still stands, and records a
 * Global Privacy Control signal as a refusal of every optional category.
 *
 *  - `getCookieConsent()` — the standing choice and whether to ask again (`reprompt`, with a reason).
 *  - `saveCookieConsent()` — record a choice. `necessary` is always on; a Global Privacy Control signal turns
 *    the rest off whatever was sent.
 *  - `forgetCookieConsent()` — delete the visitor's records.
 *  - `linkCookieConsent()` — a signed-in visitor attaches their earlier choices to the account.
 *  - `visitorId()` — the random, long-lived id the visitor is known by (kept in localStorage when it works).
 *
 * The store is turned on with `compliance.cookieConsent.enabled`; until then every call answers 400.
 */
import type { FapiClient, FapiResponse } from './fapi';
import type { FieldError } from './attempt';

export interface CookieConsentState {
  object: 'cookie_consent_state';
  enabled: boolean;
  subject: string;
  /** Each category and whether it is allowed right now (the stored choice, else the safe default). */
  categories: Record<string, boolean>;
  /** A choice is stored. */
  decided: boolean;
  /** Ask the visitor again. */
  reprompt: boolean;
  reprompt_reason: 'no_choice' | 'policy_changed' | 'expired' | 'categories_changed' | null;
  policy_version: string | null;
  config: { categories: string[]; honor_gpc: boolean; honor_dnt: boolean; reprompt_days: number };
  /** The browser signal that forced optional categories off (`gpc` or `dnt`). */
  signal_applied: 'gpc' | 'dnt' | null;
  recorded_at: number | null;
}

export interface CookieConsentRecord {
  object: 'cookie_consent_record';
  id: string;
  subject: string;
  user_id: string | null;
  categories: Record<string, boolean>;
  policy_version: string | null;
  source: 'banner' | 'api' | 'signal';
  gpc: boolean;
  dnt: boolean;
  signal_applied: 'gpc' | 'dnt' | null;
  region: string | null;
  locale: string | null;
  created_at: number;
  reprompt: boolean;
}

export type CookieConsentResult<T> = { ok: true; data: T } | { ok: false; errors: FieldError[] };

const wrap = <T>(res: FapiResponse<T>): CookieConsentResult<T> => (res.ok && res.data ? { ok: true, data: res.data } : { ok: false, errors: res.errors });

/** Whether the browser asks sites not to sell or share data (`navigator.globalPrivacyControl`). The `Sec-GPC` header is sent by the browser itself. */
export function globalPrivacyControlOn(): boolean {
  return typeof navigator !== 'undefined' && (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
}

const KEY = 'atlas.cookie_consent.visitor';

/** A random visitor id (24 bytes, URL-safe). Not derived from anything about the person. */
export function newVisitorId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The visitor's id: the stored one, else a new one stored for next time (memory only where storage is blocked). */
export function visitorId(): string {
  try {
    const have = localStorage.getItem(KEY);
    if (have && /^[A-Za-z0-9_-]{16,128}$/.test(have)) return have;
    const id = newVisitorId();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return newVisitorId();
  }
}

/** `GET /v1/client/cookie_consent` */
export async function getCookieConsent(client: FapiClient, subject: string = visitorId()): Promise<CookieConsentResult<CookieConsentState>> {
  return wrap(await client.request<CookieConsentState>(`/v1/client/cookie_consent?subject=${encodeURIComponent(subject)}`, { method: 'GET' }));
}

export interface SaveCookieConsentInput {
  categories: Record<string, boolean>;
  subject?: string;
  locale?: string;
  region?: string;
  /** The cookie policy version the banner showed; a stale one is refused (409) so it is never recorded as current. */
  policyVersion?: string;
  source?: 'banner' | 'api' | 'signal';
  /** Makes a retry return the first record. */
  idempotencyKey?: string;
}

/** `POST /v1/client/cookie_consent` */
export async function saveCookieConsent(client: FapiClient, input: SaveCookieConsentInput): Promise<CookieConsentResult<CookieConsentRecord>> {
  const gpc = globalPrivacyControlOn();
  return wrap(
    await client.request<CookieConsentRecord>('/v1/client/cookie_consent', {
      method: 'POST',
      body: JSON.stringify({
        subject: input.subject ?? visitorId(),
        categories: input.categories,
        ...(gpc ? { gpc: true } : {}),
        ...(input.locale ? { locale: input.locale } : {}),
        ...(input.region ? { region: input.region } : {}),
        ...(input.policyVersion ? { policy_version: input.policyVersion } : {}),
        ...(input.source ? { source: input.source } : {}),
      }),
      headers: input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {},
    }),
  );
}

/** `DELETE /v1/client/cookie_consent` */
export async function forgetCookieConsent(client: FapiClient, subject: string = visitorId()): Promise<CookieConsentResult<{ object: 'cookie_consent_erasure'; subject: string; removed: number }>> {
  return wrap(await client.request(`/v1/client/cookie_consent?subject=${encodeURIComponent(subject)}`, { method: 'DELETE' }));
}

/** `POST /v1/client/me/cookie_consent/link` — for a signed-in visitor. */
export async function linkCookieConsent(client: FapiClient, subject: string = visitorId()): Promise<CookieConsentResult<{ object: 'cookie_consent_link'; linked: number }>> {
  return wrap(await client.request('/v1/client/me/cookie_consent/link', { method: 'POST', body: JSON.stringify({ subject }) }));
}

/** Everything allowed, for a banner's "accept all" (necessary included). */
export const acceptAllCategories = (config: CookieConsentState['config']): Record<string, boolean> => Object.fromEntries(config.categories.map((c) => [c, true]));
/** Only what is necessary, for "reject all". */
export const rejectOptionalCategories = (config: CookieConsentState['config']): Record<string, boolean> => Object.fromEntries(config.categories.map((c) => [c, c === 'necessary']));

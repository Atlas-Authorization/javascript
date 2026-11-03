/**
 * Moving to Atlas without signing anyone out, BROWSER SIDE, for vendors whose
 * SDK keeps the session in browser storage rather than in a cookie a server
 * middleware could read: Firebase (IndexedDB), AWS Amplify / Cognito
 * (localStorage), MSAL for Azure AD B2C / Entra External ID (session or local
 * storage), Supabase SPAs (localStorage), Appwrite (its localStorage cookie
 * fallback), PocketBase (localStorage) and Nhost
 * (localStorage).
 *
 * A reader finds the old token on this page; {@link exchangeMigrationBrowserSession}
 * sends it ONCE to `POST /v1/client/migrations/{source}/exchange` with cookie
 * delivery, so Atlas sets its session exactly as a sign-in does, and then
 * clears the old storage. Atlas verifies the token (against the vendor's keys,
 * or the sessions imported in the migration bundle) — nothing here is trusted.
 *
 *   const found = await readFirebaseBrowserSession();
 *   if (found) await exchangeMigrationBrowserSession(client, { source: 'firebase', ...found });
 *
 * Where the vendor allows a public refresh (Firebase's securetoken endpoint
 * with the project's web API key, Cognito's REFRESH_TOKEN_AUTH with a public
 * client id), an expired token is refreshed first, so the exchange presents a
 * live one.
 */
import type { FapiClient } from './fapi';

/** A token found on this page, and how to remove the old session once exchanged. */
export interface BrowserSessionToken {
  token: string;
  /** Remove the old vendor session from this browser. */
  clear: () => void | Promise<void>;
}

export type MigrationBrowserExchangeOutcome =
  | { status: 'none' }
  | { status: 'complete'; sessionId: string; userId: string; jwt: string }
  | { status: 'needs_second_factor' | 'needs_mfa_enrollment'; attemptId: string }
  | { status: 'refused'; outcome: string };

export function migrationBrowserExchangePath(source: string): string {
  return `/v1/client/migrations/${encodeURIComponent(source)}/exchange`;
}

/** Refusals after which the old session will never exchange: it is cleared. */
const FINAL = new Set(['invalid', 'signature_invalid', 'expired', 'reused', 'user_unavailable', 'user_unknown']);

/**
 * Exchange an old vendor session found on this page for an Atlas session.
 * Never throws. On success (or a final refusal) the old session is cleared.
 */
export async function exchangeMigrationBrowserSession(
  client: FapiClient,
  input: { source: string; token?: string; clear?: () => void | Promise<void>; remember?: boolean },
): Promise<MigrationBrowserExchangeOutcome> {
  if (!input.token) return { status: 'none' };
  const clear = async () => {
    try {
      await input.clear?.();
    } catch {
      // Clearing is best-effort: the exchange already happened (or never will).
    }
  };
  let response;
  try {
    response = await client.post<{ object?: string; id?: string; user_id?: string; jwt?: string; status?: string }>(
      migrationBrowserExchangePath(input.source),
      { token: input.token, delivery: 'cookie', ...(input.remember === false ? { remember: false } : {}) },
    );
  } catch {
    return { status: 'refused', outcome: 'error' };
  }
  const data = response.data;
  if (response.ok && data?.object === 'session' && data.id && data.jwt) {
    await clear();
    return { status: 'complete', sessionId: data.id, userId: data.user_id ?? '', jwt: data.jwt };
  }
  if (response.ok && data?.object === 'sign_in_attempt' && data.id && (data.status === 'needs_second_factor' || data.status === 'needs_mfa_enrollment')) {
    await clear();
    return { status: data.status, attemptId: data.id };
  }
  const outcome = response.errors[0]?.meta?.bridge_outcome;
  const reason = typeof outcome === 'string' ? outcome : 'error';
  if (FINAL.has(reason)) await clear();
  return { status: 'refused', outcome: reason };
}

// ── shared helpers ────────────────────────────────────────────────────────────

type StorageLike = Pick<Storage, 'getItem' | 'removeItem' | 'key' | 'length'> & { setItem?(key: string, value: string): void };

function storages(given?: StorageLike[]): StorageLike[] {
  if (given) return given;
  const out: StorageLike[] = [];
  try {
    if (typeof localStorage !== 'undefined') out.push(localStorage);
  } catch {
    // Storage access can throw (privacy modes, sandboxed frames).
  }
  try {
    if (typeof sessionStorage !== 'undefined') out.push(sessionStorage);
  } catch {
    // As above.
  }
  return out;
}

function keysOf(s: StorageLike): string[] {
  const keys: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k !== null) keys.push(k);
  }
  return keys;
}

function json(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The unverified payload of a JWT (only to read `exp` / `iss` before choosing to refresh). */
export function peekJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return json(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function expired(token: string, skewSeconds = 30): boolean {
  const exp = peekJwtPayload(token)?.exp;
  return typeof exp === 'number' && exp * 1000 <= Date.now() + skewSeconds * 1000;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

// ── Firebase (IndexedDB) ──────────────────────────────────────────────────────

export interface FirebaseBrowserSessionOptions {
  /** Only this project's web API key (default: the first signed-in Firebase app on the page). */
  apiKey?: string;
  /** Refresh an expired ID token with the securetoken endpoint first (default true). */
  refresh?: boolean;
  indexedDB?: IDBFactory;
  storage?: StorageLike[];
  fetchImpl?: typeof fetch;
}

const FIREBASE_DB = 'firebaseLocalStorageDb';
const FIREBASE_STORE = 'firebaseLocalStorage';
const FIREBASE_KEY = /^firebase:authUser:([^:]+):/;

interface FirebaseUserRecord {
  key: string;
  apiKey: string;
  accessToken?: string;
  refreshToken?: string;
}

function firebaseRecord(key: string, value: unknown): FirebaseUserRecord | null {
  const m = FIREBASE_KEY.exec(key);
  if (!m) return null;
  const v = (typeof value === 'string' ? json(value) : value) as Record<string, unknown> | null;
  const sts = v && typeof v.stsTokenManager === 'object' ? (v.stsTokenManager as Record<string, unknown>) : null;
  if (!sts) return null;
  return { key, apiKey: m[1]!, accessToken: str(sts.accessToken), refreshToken: str(sts.refreshToken) };
}

function idbAll(factory: IDBFactory): Promise<Array<{ fbase_key?: unknown; value?: unknown }>> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(FIREBASE_DB);
    } catch {
      resolve([]);
      return;
    }
    request.onerror = () => resolve([]);
    request.onupgradeneeded = () => {
      // The database did not exist: abort the creation, there is no session.
      request.transaction?.abort();
      resolve([]);
    };
    request.onsuccess = () => {
      const db = request.result;
      try {
        if (!db.objectStoreNames.contains(FIREBASE_STORE)) {
          db.close();
          resolve([]);
          return;
        }
        const all = db.transaction(FIREBASE_STORE, 'readonly').objectStore(FIREBASE_STORE).getAll();
        all.onsuccess = () => {
          db.close();
          resolve((all.result ?? []) as Array<{ fbase_key?: unknown; value?: unknown }>);
        };
        all.onerror = () => {
          db.close();
          resolve([]);
        };
      } catch {
        db.close();
        resolve([]);
      }
    };
  });
}

function idbDelete(factory: IDBFactory, key: string): Promise<void> {
  return new Promise((resolve) => {
    const request = factory.open(FIREBASE_DB);
    request.onerror = () => resolve();
    request.onsuccess = () => {
      const db = request.result;
      try {
        const tx = db.transaction(FIREBASE_STORE, 'readwrite');
        tx.objectStore(FIREBASE_STORE).delete(key);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          resolve();
        };
      } catch {
        db.close();
        resolve();
      }
    };
  });
}

/** Firebase's public token refresh (the web SDK's own call): a fresh ID token, or undefined. */
export async function refreshFirebaseIdToken(apiKey: string, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { id_token?: unknown };
    return str(body.id_token);
  } catch {
    return undefined;
  }
}

/** The Firebase ID token this page is signed in with (IndexedDB, else local/session storage persistence). */
export async function readFirebaseBrowserSession(options: FirebaseBrowserSessionOptions = {}): Promise<BrowserSessionToken | undefined> {
  const factory = options.indexedDB ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined);
  const candidates: Array<FirebaseUserRecord & { remove: () => void | Promise<void> }> = [];
  if (factory) {
    for (const row of await idbAll(factory)) {
      const key = str(row.fbase_key);
      const rec = key ? firebaseRecord(key, row.value) : null;
      if (rec) candidates.push({ ...rec, remove: () => idbDelete(factory, rec.key) });
    }
  }
  for (const s of storages(options.storage)) {
    for (const key of keysOf(s)) {
      const rec = firebaseRecord(key, s.getItem(key));
      if (rec) candidates.push({ ...rec, remove: () => s.removeItem(key) });
    }
  }
  const found = candidates.find((c) => !options.apiKey || c.apiKey === options.apiKey);
  if (!found?.accessToken) return undefined;
  let token = found.accessToken;
  if (expired(token) && options.refresh !== false && found.refreshToken) {
    token = (await refreshFirebaseIdToken(found.apiKey, found.refreshToken, options.fetchImpl)) ?? token;
  }
  return { token, clear: found.remove };
}

// ── AWS Amplify / Cognito (localStorage) ─────────────────────────────────────

export interface AmplifyBrowserSessionOptions {
  /** The app client id (default: the first one with a signed-in user). */
  clientId?: string;
  /** Refresh an expired ID token with REFRESH_TOKEN_AUTH first (default true; public clients only). */
  refresh?: boolean;
  storage?: StorageLike[];
  fetchImpl?: typeof fetch;
}

const AMPLIFY_LAST_USER = /^CognitoIdentityServiceProvider\.([^.]+)\.LastAuthUser$/;

/** Cognito's public refresh: a fresh ID token for a client without a secret, or undefined. */
export async function refreshCognitoIdToken(idToken: string, clientId: string, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const iss = str(peekJwtPayload(idToken)?.iss);
  const region = iss?.match(/^https:\/\/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com\//)?.[1];
  if (!region) return undefined;
  try {
    const res = await fetchImpl(`https://cognito-idp.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
      body: JSON.stringify({ AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: clientId, AuthParameters: { REFRESH_TOKEN: refreshToken } }),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { AuthenticationResult?: { IdToken?: unknown } };
    return str(body.AuthenticationResult?.IdToken);
  } catch {
    return undefined;
  }
}

/** The Cognito ID token Amplify (v5/v6) or amazon-cognito-identity-js keeps for this page. */
export async function readAmplifyBrowserSession(options: AmplifyBrowserSessionOptions = {}): Promise<BrowserSessionToken | undefined> {
  for (const s of storages(options.storage)) {
    for (const key of keysOf(s)) {
      const m = AMPLIFY_LAST_USER.exec(key);
      if (!m || (options.clientId && m[1] !== options.clientId)) continue;
      const clientId = m[1]!;
      const username = s.getItem(key);
      if (!username) continue;
      const prefix = `CognitoIdentityServiceProvider.${clientId}.${username}`;
      let token = s.getItem(`${prefix}.idToken`);
      if (!token) continue;
      const refreshToken = s.getItem(`${prefix}.refreshToken`);
      if (expired(token) && options.refresh !== false && refreshToken) {
        token = (await refreshCognitoIdToken(token, clientId, refreshToken, options.fetchImpl)) ?? token;
      }
      return {
        token,
        clear: () => {
          for (const k of keysOf(s)) if (k.startsWith(`CognitoIdentityServiceProvider.${clientId}.`)) s.removeItem(k);
        },
      };
    }
  }
  return undefined;
}

// ── MSAL (Azure AD B2C / Entra External ID) ──────────────────────────────────

/**
 * The ID token in an msal-browser v2/v3 cache (sessionStorage by default,
 * localStorage when the app chose it). msal-browser v4 encrypts its cache, so
 * nothing is found there: those apps rely on lazy migration.
 */
export async function readMsalBrowserSession(options: { clientId?: string; storage?: StorageLike[] } = {}): Promise<BrowserSessionToken | undefined> {
  for (const s of storages(options.storage)) {
    for (const key of keysOf(s)) {
      const v = json(s.getItem(key));
      if (!v || v.credentialType !== 'IdToken') continue;
      if (options.clientId && v.clientId !== options.clientId) continue;
      const token = str(v.secret);
      if (!token || token.split('.').length !== 3) continue;
      const clientId = str(v.clientId);
      return {
        token,
        clear: () => {
          for (const k of keysOf(s)) {
            if (k.startsWith('msal.') || (clientId && k.includes(clientId))) s.removeItem(k);
          }
        },
      };
    }
  }
  return undefined;
}

// ── Supabase SPA (localStorage) ──────────────────────────────────────────────

/** The access token supabase-js keeps in `sb-<ref>-auth-token` (an SPA; SSR apps use the server middleware). */
export async function readSupabaseBrowserSession(options: { storageKey?: string; storage?: StorageLike[] } = {}): Promise<BrowserSessionToken | undefined> {
  for (const s of storages(options.storage)) {
    for (const key of keysOf(s)) {
      if (options.storageKey ? key !== options.storageKey : !/^sb-[^.]+-auth-token$/.test(key)) continue;
      const v = json(s.getItem(key));
      const nested = v && typeof v.currentSession === 'object' ? (v.currentSession as Record<string, unknown>) : null;
      const token = str(v?.access_token) ?? str(nested?.access_token);
      if (!token) continue;
      return { token, clear: () => s.removeItem(key) };
    }
  }
  return undefined;
}

// ── Appwrite (localStorage cookie fallback) ──────────────────────────────────

/**
 * The session the Appwrite Web SDK keeps in localStorage `cookieFallback`
 * (`{"a_session_<projectId>": "<session>"}`) when third-party cookies are
 * blocked. Atlas checks it with Appwrite (the `appwrite` remote bridge preset).
 */
export async function readAppwriteBrowserSession(options: { projectId?: string; storage?: StorageLike[] } = {}): Promise<BrowserSessionToken | undefined> {
  for (const s of storages(options.storage)) {
    const v = json(s.getItem('cookieFallback'));
    if (!v) continue;
    for (const [key, value] of Object.entries(v)) {
      if (options.projectId ? key !== `a_session_${options.projectId}` : !key.startsWith('a_session_') || key.endsWith('_legacy')) continue;
      const token = str(value);
      if (!token) continue;
      return {
        token,
        clear: () => {
          const rest = { ...v };
          delete rest[key];
          delete rest[`${key}_legacy`];
          if (Object.keys(rest).length && s.setItem) s.setItem('cookieFallback', JSON.stringify(rest));
          else s.removeItem('cookieFallback');
        },
      };
    }
  }
  return undefined;
}

// ── PocketBase (localStorage) ─────────────────────────────────────────────────

/** The auth token the PocketBase JS SDK keeps in `pocketbase_auth`. */
export async function readPocketBaseBrowserSession(options: { storageKey?: string; storage?: StorageLike[] } = {}): Promise<BrowserSessionToken | undefined> {
  const name = options.storageKey ?? 'pocketbase_auth';
  for (const s of storages(options.storage)) {
    const token = str(json(s.getItem(name))?.token);
    if (token) return { token, clear: () => s.removeItem(name) };
  }
  return undefined;
}

// ── Nhost (localStorage) ──────────────────────────────────────────────────────

/** The refresh token nhost-js v2/v3 keeps in `nhostRefreshToken` (matched against the sessions in the bundle). */
export async function readNhostBrowserSession(options: { storage?: StorageLike[] } = {}): Promise<BrowserSessionToken | undefined> {
  for (const s of storages(options.storage)) {
    const v4 = json(s.getItem('nhostSession'));
    const token = s.getItem('nhostRefreshToken') ?? str(v4?.refreshToken);
    if (token) {
      return {
        token,
        clear: () => {
          s.removeItem('nhostRefreshToken');
          s.removeItem('nhostRefreshTokenExpiresAt');
          s.removeItem('nhostSession');
        },
      };
    }
  }
  return undefined;
}

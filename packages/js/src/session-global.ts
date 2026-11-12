/**
 * `window.Atlas.session`: a stable browser global so ANY script on the page
 * (a third-party widget, a payments snippet) can ask for the signed-in user's
 * session token without holding a reference to the app's SDK instance.
 *
 *   const jwt = await window.Atlas.session.getToken();   // null when signed out
 *
 * The global is an extension of `window.Atlas`, never a replacement: whatever
 * is already there (the embed bundle's mount functions) is kept. Whichever SDK
 * owns the page's session (the embed bundle, `@atlasauth/react`'s provider, or
 * a bare `FapiClient`) registers itself as the source; the latest owner wins.
 */
import { TokenCache, type CachedToken } from './token-cache';
import { getIntegrationToken, getTemplateToken, type FapiClient } from './fapi';

/** What `getToken` can mint: the session JWT by default. */
export interface SessionGlobalTokenOptions {
  /** A named JWT template. */
  template?: string;
  /** An identity integration id: its integration token. */
  for?: string;
  spaceId?: string;
  audience?: string;
  cbid?: string;
  audienceParams?: Record<string, string>;
  /** With `for`: per-mint claims signed into the token (must be on the integration's allow-list). */
  context?: Record<string, string>;
}

/** The slice of a user the global exposes. */
export interface SessionGlobalUser {
  id: string;
  external_id?: string | null;
  [key: string]: unknown;
}

/** What an SDK registers to own `window.Atlas.session`. */
export interface SessionSource {
  getToken(options?: SessionGlobalTokenOptions): Promise<string | null>;
  /** The signed-in user, or null (also while still loading). */
  user(): SessionGlobalUser | null;
  /** The `external_id` of the session's claims, when known. */
  externalId?(): string | null;
}

export interface AtlasSessionGlobal {
  /** The verifiable session JWT (60 s life; refreshed as needed), or null when signed out. */
  getToken(options?: SessionGlobalTokenOptions): Promise<string | null>;
  /** Alias of `getToken()` for platforms that ask for an "ID token": the same verifiable session JWT. */
  getIdToken(options?: SessionGlobalTokenOptions): Promise<string | null>;
  readonly user: SessionGlobalUser | null;
  readonly isSignedIn: boolean;
}

export interface AtlasBillingGlobal {
  /** `{ atlas_user_id, atlas_external_id? }` to put on payment-provider customers; null when signed out. */
  customerMetadata(): Record<string, string> | null;
}

declare global {
  interface Window {
    Atlas?: { session?: AtlasSessionGlobal; billing?: AtlasBillingGlobal; [key: string]: unknown };
  }
}

/** The event dispatched on `window` when the signed-in user changes (`detail: { signedIn, userId }`). */
export const SESSION_EVENT = 'atlas:session';

/** `{ atlas_user_id, ...(external_id ? { atlas_external_id } : {}) }`: the match keys for a referral platform. */
export function customerMetadataFor(user: { id: string; external_id?: string | null }): Record<string, string> {
  return { atlas_user_id: user.id, ...(user.external_id ? { atlas_external_id: user.external_id } : {}) };
}

let owner: object | null = null;
let lastUserId: string | null | undefined;

/** True when some SDK already owns the global on this page. */
export function sessionGlobalInstalled(): boolean {
  return owner !== null;
}

/**
 * Register `source` as the owner of `window.Atlas.session` (extending any
 * existing `window.Atlas`). Returns a function that unregisters it, a no-op if
 * a later owner has replaced it. Does nothing outside a browser.
 */
export function installSessionGlobal(source: SessionSource): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const token = {};
  owner = token;
  const get = (o?: SessionGlobalTokenOptions) => source.getToken(o);
  const session: AtlasSessionGlobal = {
    getToken: get,
    getIdToken: get,
    get user() {
      return source.user();
    },
    get isSignedIn() {
      return source.user() !== null;
    },
  };
  const billing: AtlasBillingGlobal = {
    customerMetadata() {
      const u = source.user();
      if (!u) return null;
      return customerMetadataFor({ id: u.id, external_id: u.external_id ?? source.externalId?.() ?? null });
    },
  };
  const existing = window.Atlas ?? {};
  window.Atlas = Object.assign(existing, { session, billing }) as Window['Atlas'];
  return () => {
    if (owner !== token) return;
    owner = null;
    const atlas = window.Atlas;
    if (atlas) {
      delete atlas.session;
      delete atlas.billing;
    }
  };
}

/** Dispatch `atlas:session` if the signed-in user differs from the last announcement. */
export function announceSessionChange(userId: string | null): void {
  // A partial window (SSR shim, test stub) may lack dispatchEvent / CustomEvent.
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function' || lastUserId === userId) return;
  lastUserId = userId;
  window.dispatchEvent(new CustomEvent(SESSION_EVENT, { detail: { signedIn: userId !== null, userId } }));
}

function claimsOf(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split('.')[1] ?? '';
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * A session source driven by a bare `FapiClient`: boots from `GET /v1/client`,
 * refreshes with `POST /v1/client/sessions/:sid/tokens`. Used by the embed
 * bundle and by `@atlasauth/js` clients with no framework provider.
 */
export function createClientSessionSource(client: FapiClient): SessionSource & { reload(): Promise<void> } {
  const cache = new TokenCache();
  let user: SessionGlobalUser | null = null;
  let sessionId: string | null = null;
  let externalId: string | null = null;
  let inflight: Promise<void> | null = null;

  const adopt = (jwt: string, sid: string) => {
    const claims = claimsOf(jwt);
    const exp = typeof claims?.exp === 'number' ? claims.exp * 1000 : Date.now() + 30_000;
    const token: CachedToken = { jwt, expiresAt: exp, sessionId: sid };
    cache.set(token);
    sessionId = sid;
    externalId = typeof claims?.external_id === 'string' ? claims.external_id : null;
  };

  const boot = async () => {
    const res = await client.get<{ session: { id: string } | null; user: SessionGlobalUser | null; jwt?: string }>('/v1/client');
    if (!res.ok || !res.data?.session || !res.data.user) {
      user = null;
      sessionId = null;
      externalId = null;
      cache.clear();
    } else {
      user = res.data.user;
      sessionId = res.data.session.id;
      if (res.data.jwt) adopt(res.data.jwt, sessionId);
    }
    announceSessionChange(user?.id ?? null);
  };
  const single = (fn: () => Promise<void>) => {
    inflight ??= fn().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  return {
    reload: () => single(boot),
    user: () => user,
    externalId: () => externalId,
    async getToken(options) {
      if (options?.template || options?.for) {
        if (!sessionId) await single(boot);
        if (!sessionId) return null;
        if (options.for) {
          return (await getIntegrationToken(client, sessionId, options.for, options))?.jwt ?? null;
        }
        return (await getTemplateToken(client, sessionId, options.template!))?.jwt ?? null;
      }
      const usable = cache.get(5_000);
      if (usable) return usable.jwt;
      if (sessionId) {
        const res = await client.post<{ jwt: string; session_id: string }>(`/v1/client/sessions/${encodeURIComponent(sessionId)}/tokens`);
        if (res.ok && res.data?.jwt) {
          adopt(res.data.jwt, res.data.session_id ?? sessionId);
          return res.data.jwt;
        }
      }
      await single(boot);
      return cache.get(5_000)?.jwt ?? null;
    },
  };
}

/**
 * Make `client` the page's session owner unless another SDK already is
 * (what a `FapiClient` does on construction in a browser; `user` and
 * `isSignedIn` fill in once the first `getToken()` has booted the session).
 */
export function registerClientSession(client: FapiClient): void {
  if (owner !== null) return;
  const source = createClientSessionSource(client);
  // Lazy: nothing is fetched until a script asks for a token (then `user` fills in).
  installSessionGlobal(source);
}

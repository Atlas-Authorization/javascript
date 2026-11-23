import { deviceProof, type DeviceKey } from './native-device-key';
import type { NativeSession } from './native-session';

const DOCS_URL = 'https://atlasauth.net/docs/native-device-bound-sessions';
const EXCHANGE_PATHS = new Set(['/v1/client/tickets/exchange', '/v1/client/sign_ins/oauth/token']);
const REFRESH = /^\/v1\/client\/sessions\/([^/]+)\/tokens$/;
const REVOKE = /^\/v1\/client\/sessions\/([^/]+)\/revoke$/;

/** Why the server did not return a refresh token (`refresh_token_withheld` on the exchange). */
export interface RefreshTokenWithheld {
  reason: 'unregistered_native_client' | 'device_key_required' | 'browser_client' | 'mfa_required' | (string & {});
  message?: string;
  docs_url?: string;
}

/** One secret slot (the shape of a secure-store adapter). */
export interface SecretSlot {
  getToken(): string | null | undefined | Promise<string | null | undefined>;
  setToken(value: string): void | Promise<void>;
  clearToken(): void | Promise<void>;
}

const isDev = (): boolean => {
  const g = globalThis as { __DEV__?: boolean; process?: { env?: Record<string, string | undefined> } };
  return typeof g.__DEV__ === 'boolean' ? g.__DEV__ : g.process?.env?.NODE_ENV !== 'production';
};

const warned = new Set<string>();

/** Development only: say why no refresh token came back, once per reason. Never throws. */
export function warnRefreshTokenWithheld(w: RefreshTokenWithheld): void {
  if (!isDev() || warned.has(w.reason)) return;
  warned.add(w.reason);
  console.warn(`[atlas] The server did not return a refresh token (${w.reason}), so this app cannot stay signed in once the session token expires. ${w.message ?? ''} ${w.docs_url ?? DOCS_URL}`.replace(/ {2,}/g, ' '));
}

interface Held {
  refreshToken: string;
  sessionId?: string;
  binding?: 'device_key';
}

const sidOf = (jwt: unknown): string | undefined => {
  try {
    const part = String(jwt).split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const sid = (JSON.parse(atob(part)) as { sid?: unknown }).sid;
    return typeof sid === 'string' ? sid : undefined;
  } catch {
    return undefined;
  }
};

const json = async (res: Response): Promise<Record<string, unknown> | null> => {
  try {
    const b = (await res.clone().json()) as unknown;
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * Wrap a fetch so a native app signs in with a device-bound refresh token and stays signed in, with no other code:
 *  - the ticket exchange / PKCE redeem carries `return_refresh_token` and the device's public key; the refresh
 *    token that comes back (with its binding) is kept in `slot`, and a withheld one warns in development;
 *  - `POST /v1/client/sessions/:id/tokens` presents that token with a DPoP proof, answers the server's nonce
 *    challenge once, and keeps the rotated token;
 *  - a revoked session forgets it.
 * Anything that cannot be handled (no key, an unreadable store, a body that is not JSON) goes through untouched.
 */
export function withDeviceBoundSession(inner: typeof fetch, opts: { deviceKey: DeviceKey; slot: SecretSlot }): typeof fetch {
  const { deviceKey: key, slot } = opts;
  let nonce: string | undefined;

  const load = async (): Promise<Held | null> => {
    try {
      const v = JSON.parse((await slot.getToken()) ?? 'null') as Held | null;
      return v && typeof v.refreshToken === 'string' ? v : null;
    } catch {
      return null;
    }
  };
  const save = async (r: Held): Promise<void> => {
    try {
      await slot.setToken(JSON.stringify(r));
    } catch {
      // The session still works until the app restarts.
    }
  };
  const forget = async (): Promise<void> => {
    try {
      await slot.clearToken();
    } catch {
      // nothing to forget
    }
  };
  const seeNonce = (res: Response): string | null => {
    const n = res.headers.get('DPoP-Nonce');
    if (n) nonce = n;
    return n;
  };

  return async (input, init) => {
    const isReq = typeof Request !== 'undefined' && input instanceof Request;
    const method = (init?.method ?? (isReq ? (input as Request).method : 'GET')).toUpperCase();
    const url = isReq ? (input as Request).url : String(input);
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      return inner(input, init);
    }
    if (method !== 'POST') return inner(input, init);

    if (EXCHANGE_PATHS.has(path) && typeof init?.body === 'string') {
      let body: Record<string, unknown>;
      let jwk;
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
        jwk = await key.publicJwk();
      } catch {
        return inner(input, init);
      }
      const res = await inner(input, { ...init, body: JSON.stringify({ ...body, return_refresh_token: true, device_key: jwk }) });
      seeNonce(res);
      if (res.ok) {
        const b = await json(res);
        if (typeof b?.refresh_token === 'string' && b.refresh_token) {
          const sessionId = sidOf(b.jwt) ?? (typeof b.session_id === 'string' ? b.session_id : undefined);
          await save({ refreshToken: b.refresh_token, ...(sessionId ? { sessionId } : {}), ...(b.binding === 'device_key' ? { binding: 'device_key' as const } : {}) });
        } else if (b?.refresh_token_withheld && typeof b.refresh_token_withheld === 'object') {
          await forget();
          warnRefreshTokenWithheld(b.refresh_token_withheld as RefreshTokenWithheld);
        }
      }
      return res;
    }

    const refreshId = REFRESH.exec(path)?.[1];
    if (refreshId) {
      const rec = await load();
      const id = decodeURIComponent(refreshId);
      if (!rec || (rec.sessionId && rec.sessionId !== id)) return inner(input, init);
      const send = async (): Promise<Response> => {
        const headers = new Headers(init?.headers);
        headers.set('content-type', 'application/json');
        if (rec.binding === 'device_key') headers.set('DPoP', await deviceProof(key, 'POST', url, { refreshToken: rec.refreshToken, nonce }));
        return inner(input, { ...init, headers, body: JSON.stringify({ refresh_token: rec.refreshToken }) });
      };
      let res: Response;
      try {
        const before = nonce;
        res = await send();
        const fresh = seeNonce(res);
        // RFC 9449 section 8: a server that wants (a newer) nonce answers 401 with DPoP-Nonce; retry once with it.
        if (res.status === 401 && fresh && fresh !== before) res = await send();
        seeNonce(res);
      } catch {
        return inner(input, init);
      }
      if (res.ok) {
        const b = await json(res);
        if (typeof b?.refresh_token === 'string' && b.refresh_token) await save({ ...rec, refreshToken: b.refresh_token, sessionId: id });
      }
      return res;
    }

    if (REVOKE.test(path)) {
      const res = await inner(input, init);
      if (res.ok || res.status === 404) await forget();
      return res;
    }
    return inner(input, init);
  };
}

/**
 * Exchange a sign-in ticket for a {@link NativeSession} with a device-bound refresh token. Null on any failure; a
 * withheld refresh token still yields the session (with an empty `refreshToken`) and warns in development.
 */
export async function exchangeTicketForNativeSession(opts: {
  baseUrl: string;
  publishableKey: string;
  attemptId: string;
  ticket: string;
  deviceKey: DeviceKey;
  appId?: string;
  fetchImpl?: typeof fetch;
}): Promise<NativeSession | null> {
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl}/v1/client/tickets/exchange`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-publishable-key': opts.publishableKey,
        ...(opts.appId ? { 'x-atlas-app-id': opts.appId } : {}),
      },
      body: JSON.stringify({ attempt_id: opts.attemptId, ticket: opts.ticket, return_refresh_token: true, device_key: await opts.deviceKey.publicJwk() }),
    });
    if (!res.ok) return null;
    const b = (await res.json()) as Record<string, unknown>;
    if (typeof b.jwt !== 'string') return null;
    const sessionId = sidOf(b.jwt) ?? (typeof b.session_id === 'string' ? b.session_id : undefined);
    if (!sessionId) return null;
    const refreshToken = typeof b.refresh_token === 'string' ? b.refresh_token : '';
    if (!refreshToken && b.refresh_token_withheld && typeof b.refresh_token_withheld === 'object') warnRefreshTokenWithheld(b.refresh_token_withheld as RefreshTokenWithheld);
    return {
      sessionToken: b.jwt,
      refreshToken,
      sessionId,
      expiresInSeconds: typeof b.expires_in === 'number' ? b.expires_in : 0,
      ...(refreshToken && b.binding === 'device_key' ? { binding: 'device_key' as const, deviceKeyId: await opts.deviceKey.thumbprint() } : {}),
    };
  } catch {
    return null;
  }
}

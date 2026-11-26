/**
 * `createSessionExchange`: the route handler behind `<SignIn exchange="/api/auth/atlas/session">`.
 *
 * The browser POSTs the Atlas session token once the sign-in completes; this verifies it with Atlas
 * and calls `onExchange` to create YOUR session. It is idempotent per session id: a repeat or
 * concurrent POST for the same `sid` runs `onExchange` once and gets the first answer back, so one
 * Atlas session never becomes two app sessions.
 */
import { AtlasBackend, parseIssuerList, type SessionClaims } from '@atlasauth/backend';

type Env = Record<string, string | undefined>;

/** What `onExchange` returns: the JSON body for the browser and any `Set-Cookie` lines to send with it. */
export interface SessionExchangeResult {
  body?: unknown;
  setCookie?: string | string[];
}

/** Remembers the answer per `sid`, so a repeat returns the existing app session. Plug in a shared store (SQL, Redis) for more than one server process. */
export interface SessionExchangeStore {
  get(sid: string): Promise<SessionExchangeResult | undefined> | SessionExchangeResult | undefined;
  set(sid: string, result: SessionExchangeResult): Promise<void> | void;
}

export interface CreateSessionExchangeOptions {
  /** `online` (default) asks Atlas whether the session is still live (needs `ATLAS_SECRET_KEY`); `local` checks the signature only. */
  verify?: 'online' | 'local';
  /** Create your app session from the verified claims. Throw to refuse (the browser sees a 500 and stays on the panel). */
  onExchange: (claims: SessionClaims, request: Request) => Promise<SessionExchangeResult | void> | SessionExchangeResult | void;
  /** Default: an in-process map that keeps answers for 10 minutes (up to 5000). */
  store?: SessionExchangeStore;
  /** Verifier override (tests, multi-instance). Default: built from `ATLAS_JWKS_URL`, `ATLAS_ISSUER`, `ATLAS_SECRET_KEY`. */
  backend?: Pick<AtlasBackend, 'verify' | 'verifyOnline'>;
  /** Accept a guest (anonymous) session. Default false. */
  allowGuests?: boolean;
}

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 5000;

// shortcut: per-process memory; give `store` a shared table once more than one server instance runs.
function memoryStore(): SessionExchangeStore {
  const m = new Map<string, { at: number; result: SessionExchangeResult }>();
  return {
    get(sid) {
      const hit = m.get(sid);
      if (!hit) return undefined;
      if (Date.now() - hit.at > TTL_MS) {
        m.delete(sid);
        return undefined;
      }
      return hit.result;
    },
    set(sid, result) {
      if (m.size >= MAX_ENTRIES) m.delete(m.keys().next().value as string);
      m.set(sid, { at: Date.now(), result });
    },
  };
}

function env(): Env {
  return (globalThis as { process?: { env?: Env } }).process?.env ?? {};
}
function pick(e: Env, ...names: string[]): string | undefined {
  for (const n of names) if (e[n]) return e[n];
  return undefined;
}

const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

function toResponse(r: SessionExchangeResult): Response {
  const res = reply(200, r.body ?? { ok: true });
  for (const c of Array.isArray(r.setCookie) ? r.setCookie : r.setCookie ? [r.setCookie] : []) res.headers.append('set-cookie', c);
  return res;
}

/** A cross-site POST would sign the visitor into someone else's account: refuse a foreign Origin. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return request.headers.get('sec-fetch-site') !== 'cross-site';
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? new URL(request.url).host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function createSessionExchange(options: CreateSessionExchangeOptions): { POST: (request: Request) => Promise<Response> } {
  const store = options.store ?? memoryStore();
  const inflight = new Map<string, Promise<SessionExchangeResult>>();
  let built: Pick<AtlasBackend, 'verify' | 'verifyOnline'> | undefined = options.backend;
  const backend = () => {
    if (built) return built;
    const e = env();
    const jwksUrl = pick(e, 'ATLAS_JWKS_URL', 'NEXT_PUBLIC_ATLAS_JWKS_URL');
    const issuer = pick(e, 'ATLAS_ISSUER', 'NEXT_PUBLIC_ATLAS_ISSUER');
    if (!jwksUrl || !issuer) throw new Error('@atlasauth/nextjs/server: createSessionExchange needs ATLAS_JWKS_URL and ATLAS_ISSUER.');
    built = new AtlasBackend({
      jwksUrl,
      issuer,
      previousIssuers: parseIssuerList(pick(e, 'ATLAS_PREVIOUS_ISSUERS', 'NEXT_PUBLIC_ATLAS_PREVIOUS_ISSUERS')),
      secretKey: pick(e, 'ATLAS_SECRET_KEY'),
      bapiBaseUrl: pick(e, 'ATLAS_API_BASE', 'ATLAS_API_URL', 'NEXT_PUBLIC_ATLAS_API_URL'),
    });
    return built;
  };

  async function POST(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return reply(403, { error: 'cross_origin' });
    let token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) {
      try {
        const b = (await request.json()) as { token?: unknown };
        if (typeof b.token === 'string') token = b.token;
      } catch {
        // no usable body
      }
    }
    if (!token) return reply(400, { error: 'token_required' });

    let claims: SessionClaims;
    try {
      const v = (options.verify ?? 'online') === 'local' ? await backend().verify(token) : await backend().verifyOnline(token);
      if (!v.ok) return reply(401, { error: 'invalid_token' });
      claims = v.claims;
    } catch {
      return reply(500, { error: 'exchange_not_configured' });
    }
    if (!claims.sid) return reply(401, { error: 'invalid_token' });
    if ((claims as { anon?: unknown }).anon === true && !options.allowGuests) return reply(401, { error: 'invalid_token' });

    const sid = claims.sid;
    const stored = await store.get(sid);
    if (stored) return toResponse(stored);
    // Concurrent POSTs for one sid share one onExchange call.
    let pending = inflight.get(sid);
    if (!pending) {
      pending = (async () => {
        const out = (await options.onExchange(claims, request)) ?? {};
        await store.set(sid, out);
        return out;
      })().finally(() => inflight.delete(sid));
      inflight.set(sid, pending);
    }
    try {
      return toResponse(await pending);
    } catch {
      return reply(500, { error: 'exchange_failed' });
    }
  }

  return { POST };
}

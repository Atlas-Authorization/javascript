import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { list, str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { resolveAuth } from './shared';

/** Who a request was verified as; becomes the `x-atlas-*` headers the upstream receives. */
export interface ProxyIdentity {
  method: 'session' | 'api_key';
  userId?: string;
  sessionId?: string;
  organizationId?: string | null;
  organizationRole?: string | null;
  keyId?: string;
  subjectType?: string;
  subjectId?: string;
  scopes?: string[];
  /** Epoch ms after which a cached answer must be asked again (the key's own expiry). */
  expiresAt?: number | null;
}

/** Ask Atlas who a credential is: an identity, `null` for "not valid", and a throw when Atlas could not answer. */
export type ProxyVerifier = (credential: { kind: 'session' | 'api_key'; token: string }) => Promise<ProxyIdentity | null>;

export interface AuthProxyOptions {
  /** The app being protected, e.g. http://localhost:3000. */
  target: string;
  verify: ProxyVerifier;
  port?: number;
  bind?: string;
  /** Paths (and everything under them) that need no credential. */
  publicPaths?: string[];
  /** Accept `ak_` API keys as bearer credentials as well as session tokens. */
  allowApiKeys?: boolean;
  /** Seconds a positive answer is remembered. 0 turns the cache off. A revoked credential lives this long. */
  cacheSeconds?: number;
  /** Remove Authorization and the session cookie before the request reaches the app. */
  stripCredentials?: boolean;
  /**
   * The session revocation feed (`GET /v1/sessions/revocations`). When set, the proxy polls it and drops a cached
   * session the moment the feed lists it, so a revoked session stops at the next poll instead of when the cache entry
   * expires. The cache TTL stays as the ceiling: if the feed cannot be reached the proxy behaves as without it.
   */
  revocations?: RevocationFeed;
  /** Milliseconds between feed polls. Default 5000. */
  revocationIntervalMs?: number;
  now?: () => number;
}

/** One page of the revocation feed, from `cursor` (epoch ms or a previous `next_after`; undefined = the feed's default window). */
export type RevocationFeed = (cursor: string | undefined) => Promise<{ data: Array<{ sid: string }>; has_more: boolean; next_after: string | null }>;

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
const SESSION_COOKIE = '__session';
const SESSION_COOKIE_RE = /^__session(?:_[a-z0-9]{8})?=/;
const CACHE_MAX = 2000;

/** The credential a request carries: a bearer token first, then the session cookie. Never a query string. */
export function readCredential(headers: IncomingHttpHeaders, allowApiKeys: boolean): { kind: 'session' | 'api_key'; token: string } | undefined {
  const auth = headers.authorization;
  const bearer = typeof auth === 'string' ? /^Bearer\s+(\S+)$/i.exec(auth)?.[1] : undefined;
  if (bearer) return allowApiKeys && bearer.startsWith('ak_') ? { kind: 'api_key', token: bearer } : { kind: 'session', token: bearer };
  // `__session`, or `__session_<8 characters>` when the instance isolates its cookies.
  const cookie = typeof headers.cookie === 'string' ? headers.cookie.split(';').map((p) => p.trim()).find((p) => SESSION_COOKIE_RE.test(p)) : undefined;
  const value = cookie?.slice(cookie.indexOf('=') + 1);
  return value ? { kind: 'session', token: decodeURIComponent(value) } : undefined;
}

/** Is `path` equal to, or under, one of the public prefixes (on a segment boundary: /health is not /healthz). */
export function isPublicPath(path: string, publicPaths: string[]): boolean {
  return publicPaths.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`));
}

/** The headers the app is given, built ONLY from a verified identity. */
export function identityHeaders(id: ProxyIdentity): Record<string, string> {
  const out: Record<string, string> = { 'x-atlas-auth-method': id.method };
  if (id.userId) out['x-atlas-user-id'] = id.userId;
  if (id.sessionId) out['x-atlas-session-id'] = id.sessionId;
  if (id.organizationId) out['x-atlas-org-id'] = id.organizationId;
  if (id.organizationRole) out['x-atlas-org-role'] = id.organizationRole;
  if (id.keyId) out['x-atlas-key-id'] = id.keyId;
  if (id.subjectType) out['x-atlas-subject-type'] = id.subjectType;
  if (id.subjectId) out['x-atlas-subject-id'] = id.subjectId;
  if (id.scopes?.length) out['x-atlas-scopes'] = id.scopes.join(' ');
  // A value with a control character could split a header: refuse rather than forward it.
  for (const v of Object.values(out)) if (/[\u0000-\u001f\u007f]/.test(v)) throw new Error('unsafe identity value');
  return out;
}

function deny(res: ServerResponse, status: 401 | 503, error: string): void {
  const body = JSON.stringify({ error, message: status === 401 ? 'Sign in to continue.' : 'Could not check your credentials. Try again.' });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}) });
  res.end(body);
}

/**
 * An authenticating reverse proxy: every request must carry a valid Atlas session token (or, when allowed, an API
 * key) or it is refused 401 and never reaches the app. A valid one is forwarded with `x-atlas-*` identity headers.
 * Any `x-atlas-*` header the client sent is removed first, so the app can trust those headers. When Atlas cannot be
 * reached the request is refused (503): the proxy fails closed.
 */
export async function startAuthProxy(opts: AuthProxyOptions): Promise<{ url: string; server: Server; close(): Promise<void>; pollRevocations(): Promise<boolean> }> {
  const target = new URL(opts.target);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new CliError('--target must be an http(s) URL.');
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const now = opts.now ?? Date.now;
  const ttl = Math.max(0, (opts.cacheSeconds ?? 10) * 1000);
  const publicPaths = (opts.publicPaths ?? []).map((p) => (p.startsWith('/') ? p : `/${p}`));
  const cache = new Map<string, { identity: ProxyIdentity; until: number }>();
  // Session ids the feed listed, with when they were listed (kept a day: the longest the feed reaches back).
  const revoked = new Map<string, number>();
  let cursor: string | undefined;

  /** Read the feed from where it was last read; false when it could not be read (the cache TTL is then the only bound). */
  const pollRevocations = (): Promise<boolean> => {
    if (!opts.revocations) return Promise.resolve(true);
    const feed = opts.revocations;
    return (async () => {
      try {
        for (let pages = 0; pages < 50; pages++) {
          const page = await feed(cursor);
          const at = now();
          for (const e of page.data) if (typeof e.sid === 'string') revoked.set(e.sid, at);
          if (page.next_after) cursor = page.next_after;
          if (!page.has_more) break;
        }
        for (const [sid, at] of revoked) if (now() - at > 86_400_000) revoked.delete(sid);
        if (revoked.size > 100_000) revoked.delete(revoked.keys().next().value as string);
        for (const [key, hit] of cache) if (hit.identity.sessionId && revoked.has(hit.identity.sessionId)) cache.delete(key);
        return true;
      } catch {
        return false;
      }
    })();
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  if (opts.revocations && ttl > 0) {
    await pollRevocations();
    timer = setInterval(() => void pollRevocations(), Math.max(1000, opts.revocationIntervalMs ?? 5000));
    timer.unref();
  }

  const identify = async (credential: { kind: 'session' | 'api_key'; token: string }): Promise<ProxyIdentity | null> => {
    const key = createHash('sha256').update(`${credential.kind}:${credential.token}`).digest('hex');
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.identity.sessionId && revoked.has(hit.identity.sessionId) ? null : hit.identity;
    cache.delete(key);
    const identity = await opts.verify(credential);
    if (identity?.sessionId && revoked.has(identity.sessionId)) return null;
    if (identity && ttl > 0) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(key, { identity, until: Math.min(now() + ttl, identity.expiresAt ?? Infinity) });
    }
    return identity;
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const pub = isPublicPath(path, publicPaths);
    let identity: ProxyIdentity | null = null;
    if (!pub) {
      const credential = readCredential(req.headers, opts.allowApiKeys === true);
      if (!credential) return deny(res, 401, 'unauthenticated');
      try {
        identity = await identify(credential);
      } catch {
        return deny(res, 503, 'verification_unavailable');
      }
      if (!identity) return deny(res, 401, 'unauthenticated');
    }

    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (value === undefined || HOP_BY_HOP.has(lower) || lower.startsWith('x-atlas-')) continue;
      if (opts.stripCredentials && lower === 'authorization') continue;
      if (opts.stripCredentials && lower === 'cookie') {
        const rest = (Array.isArray(value) ? value.join('; ') : value).split(';').map((p) => p.trim()).filter((p) => p && !SESSION_COOKIE_RE.test(p));
        if (rest.length) headers.cookie = rest.join('; ');
        continue;
      }
      headers[lower] = value;
    }
    headers.host = target.host;
    headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ');
    headers['x-forwarded-host'] = req.headers.host ?? '';
    try {
      Object.assign(headers, identity ? identityHeaders(identity) : {});
    } catch {
      return deny(res, 401, 'unauthenticated');
    }

    const upstream = send(
      { protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method: req.method, path: req.url, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream_unreachable' }));
      } else res.destroy();
    });
    req.pipe(upstream);
  });
  // A WebSocket upgrade would skip the check above; refuse it rather than tunnel it unauthenticated.
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 501 Not Implemented\r\nconnection: close\r\n\r\n');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.bind ?? '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${opts.bind && opts.bind !== '0.0.0.0' ? opts.bind : '127.0.0.1'}:${port}`,
    server,
    close: () => new Promise<void>((resolve) => { if (timer) clearInterval(timer); server.close(() => resolve()); server.closeAllConnections?.(); }),
    pollRevocations,
  };
}

/** The revocation feed backed by the Backend API: GET /v1/sessions/revocations (sessions:read). */
export function atlasRevocationFeed(base: string, secretKey: string, doFetch: typeof fetch): RevocationFeed {
  return async (cursor) => {
    const url = `${base}/v1/sessions/revocations?limit=1000${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
    const res = await doFetch(url, { headers: { authorization: `Bearer ${secretKey}`, accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { data: Array<{ sid: string }>; has_more: boolean; next_after: string | null };
  };
}

/** The verifier backed by the Backend API: POST /v1/tokens/verify (sessions:read) and /v1/api_keys/verify (api_keys:read). */
export function atlasVerifier(base: string, secretKey: string, doFetch: typeof fetch): ProxyVerifier {
  const call = async (path: string, body: unknown) => {
    const res = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) throw new CliError(`Atlas refused the secret key for ${path} (HTTP ${res.status}). It needs the ${path.includes('api_keys') ? 'api_keys:read' : 'sessions:read'} scope.`);
    // Rate limits and outages are "could not check", never "valid".
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as Record<string, any>;
  };
  return async ({ kind, token }) => {
    if (kind === 'api_key') {
      const r = await call('/v1/api_keys/verify', { secret: token });
      if (r.valid !== true) return null;
      return {
        method: 'api_key',
        keyId: r.id,
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        ...(r.subject_type === 'user' ? { userId: r.subject_id } : {}),
        organizationId: r.organization?.id ?? (r.subject_type === 'organization' ? r.subject_id : null),
        scopes: r.effective_scopes ?? r.scopes ?? [],
        expiresAt: typeof r.expires_at === 'number' ? r.expires_at : null,
      };
    }
    const r = await call('/v1/tokens/verify', { token });
    if (r.verified !== true) return null;
    return { method: 'session', userId: r.user_id, sessionId: r.session_id, organizationId: r.organization_id ?? null, organizationRole: r.organization_role ?? null };
  };
}

/**
 * `atlas proxy --target <url> [--port 4500] [--public /health,/static] [--allow-api-keys] [--cache <seconds>]
 * [--strip-credentials] [--bind <address>] [--revocation-interval <seconds>]`: put sign-in in front of any app, in any language. Requests carrying a
 * valid Atlas session (a bearer token or the __session cookie) reach your app with x-atlas-user-id and friends;
 * everything else is refused 401.
 */
export async function proxy(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const v = args.values;
  const target = str(v, 'target');
  if (!target) throw new CliError('proxy needs --target <url> (for example http://localhost:3000).');
  const port = str(v, 'port') ? Number(str(v, 'port')) : 4500;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliError('--port must be 0-65535.');
  const cache = str(v, 'cache') ? Number(str(v, 'cache')) : 10;
  if (!Number.isFinite(cache) || cache < 0 || cache > 300) throw new CliError('--cache must be 0-300 seconds.');
  const revocationSeconds = str(v, 'revocation-interval') ? Number(str(v, 'revocation-interval')) : 5;
  if (!Number.isFinite(revocationSeconds) || revocationSeconds < 0 || revocationSeconds > 300) throw new CliError('--revocation-interval must be 0-300 seconds (0 turns the revocation feed off).');
  const auth = resolveAuth(ctx, v);
  const handle = await startAuthProxy({
    target,
    port,
    bind: str(v, 'bind'),
    publicPaths: list(v, 'public'),
    allowApiKeys: v['allow-api-keys'] === true,
    cacheSeconds: cache,
    stripCredentials: v['strip-credentials'] === true,
    verify: atlasVerifier(auth.apiUrl.replace(/\/+$/, ''), auth.secretKey, ctx.fetch ?? globalThis.fetch),
    ...(revocationSeconds > 0 ? { revocations: atlasRevocationFeed(auth.apiUrl.replace(/\/+$/, ''), auth.secretKey, ctx.fetch ?? globalThis.fetch), revocationIntervalMs: revocationSeconds * 1000 } : {}),
  });
  ctx.io.out(
    `Protecting ${target} on ${handle.url}. Requests without a valid Atlas session get 401${
      cache ? (revocationSeconds > 0 ? `; a revoked session is dropped within ${revocationSeconds}s (answers are cached up to ${cache}s at most)` : `; answers are cached ${cache}s, so a revoked session works that long`) : ''
    }. Ctrl-C to stop.`,
  );
  await new Promise<void>((done) => {
    if (ctx.signal) return void (ctx.signal.aborted ? done() : ctx.signal.addEventListener('abort', () => done()));
    process.once('SIGINT', () => done());
    process.once('SIGTERM', () => done());
  });
  await handle.close();
  return 0;
}

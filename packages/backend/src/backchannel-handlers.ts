import { LogoutTokenVerifier, type LogoutTokenClaims, type LogoutTokenVerifierOptions } from './logout-token';

/**
 * Ready-made receivers for OIDC Back-Channel Logout: Atlas POSTs a signed
 * `logout_token` (form-encoded) to your client's `backchannel_logout_uri` when
 * a session ends (signed out elsewhere, revoked, the user banned or deleted).
 * Each handler verifies the token, calls your `onLogout` with whose session to
 * end, and answers the way the spec and Atlas's retries expect:
 *
 *   200  verified and handled (also for a replayed token you already handled)
 *   400  the token is bad: Atlas does not retry
 *   503  your side could not check it right now (keys unreachable, or
 *        `onLogout` threw): `Retry-After` is set and Atlas retries
 *
 * Every response carries `Cache-Control: no-store`. Framework-agnostic core:
 * {@link handleBackchannelLogout}; adapters for Express, Fastify and Next.js
 * (App Router route handlers, or any Fetch-API runtime) below.
 */

export interface BackchannelLogoutOptions extends LogoutTokenVerifierOptions {
  /**
   * End the matching session(s) in your app. `sid` names one session (the
   * `sid` of the id_token you got at sign-in), `sub` the user (end all of
   * them when there is no `sid`). Throwing answers 503, so Atlas retries.
   */
  onLogout(claims: LogoutTokenClaims): void | Promise<void>;
  /** Reuse a verifier you already have (keeps its key cache). Built from the options otherwise. */
  verifier?: LogoutTokenVerifier;
  /** Seconds in Retry-After on a 503. Default 30. */
  retryAfterSeconds?: number;
}

export interface BackchannelLogoutResponse {
  status: 200 | 400 | 503;
  headers: Record<string, string>;
  body: string;
}

/** Pull `logout_token` out of whatever body the framework handed over. */
export function readLogoutToken(body: unknown): string | undefined {
  if (typeof body === 'string') return new URLSearchParams(body).get('logout_token') ?? undefined;
  if (body instanceof URLSearchParams) return body.get('logout_token') ?? undefined;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) return readLogoutToken(body.toString('utf8'));
  if (body && typeof body === 'object') {
    const v = (body as Record<string, unknown>).logout_token;
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  }
  return undefined;
}

const verifiers = new WeakMap<BackchannelLogoutOptions, LogoutTokenVerifier>();

function verifierFor(options: BackchannelLogoutOptions): LogoutTokenVerifier {
  if (options.verifier) return options.verifier;
  let v = verifiers.get(options);
  if (!v) {
    v = new LogoutTokenVerifier(options);
    verifiers.set(options, v);
  }
  return v;
}

const json = (status: BackchannelLogoutResponse['status'], payload: Record<string, unknown>, extra: Record<string, string> = {}): BackchannelLogoutResponse => ({
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  body: JSON.stringify(payload),
});

/** Verify one back-channel logout request body and run `onLogout`. Never throws. */
export async function handleBackchannelLogout(body: unknown, options: BackchannelLogoutOptions): Promise<BackchannelLogoutResponse> {
  const token = readLogoutToken(body);
  if (!token) return json(400, { error: 'invalid_request', error_description: 'logout_token is missing.' });
  const result = await verifierFor(options).verify(token);
  const retryAfter = String(options.retryAfterSeconds ?? 30);
  if (!result.ok) {
    // A replay of a token already handled is not an error for the sender.
    if (result.reason === 'replayed') return json(200, { ok: true, replayed: true });
    if (result.retryable) {
      return json(503, { error: 'temporarily_unavailable', error_description: result.detail ?? result.reason }, { 'retry-after': retryAfter });
    }
    return json(400, { error: 'invalid_request', error_description: result.detail ?? result.reason });
  }
  try {
    await options.onLogout(result.claims);
  } catch {
    return json(503, { error: 'temporarily_unavailable', error_description: 'The session could not be ended.' }, { 'retry-after': retryAfter });
  }
  return json(200, { ok: true });
}

// ---------------------------------------------------------------------------
// Express (or any connect-style server)

interface ExpressLikeRequest {
  body?: unknown;
  on?(event: string, cb: (chunk?: unknown) => void): unknown;
}
interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse;
  set?(headers: Record<string, string>): unknown;
  setHeader?(name: string, value: string): unknown;
  send(body: string): unknown;
}

function readStream(req: ExpressLikeRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!req.on) return resolve('');
    let data = '';
    req.on('data', (chunk) => {
      data += String(chunk);
      if (data.length > 64 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', (err) => reject(err));
  });
}

/**
 * Express route handler: `app.post('/auth/backchannel-logout', expressBackchannelLogout({...}))`.
 * Works with or without `express.urlencoded()` in front of it.
 */
export function expressBackchannelLogout(options: BackchannelLogoutOptions) {
  return async (req: ExpressLikeRequest, res: ExpressLikeResponse): Promise<void> => {
    let body = req.body;
    if (body === undefined || (body && typeof body === 'object' && Object.keys(body as object).length === 0 && req.on)) {
      body = await readStream(req).catch(() => '');
    }
    const out = await handleBackchannelLogout(body, options);
    res.status(out.status);
    for (const [k, v] of Object.entries(out.headers)) {
      if (res.setHeader) res.setHeader(k, v);
      else res.set?.({ [k]: v });
    }
    res.send(out.body);
  };
}

// ---------------------------------------------------------------------------
// Fastify

interface FastifyLikeReply {
  code(status: number): FastifyLikeReply;
  headers(values: Record<string, string>): FastifyLikeReply;
  send(body: string): unknown;
}
interface FastifyLikeInstance {
  addContentTypeParser(
    type: string,
    opts: { parseAs: 'string' },
    parser: (req: unknown, body: string, done: (err: Error | null, body?: unknown) => void) => void,
  ): void;
  hasContentTypeParser?(type: string): boolean;
  post(path: string, handler: (request: { body?: unknown }, reply: FastifyLikeReply) => unknown): unknown;
}

/** Fastify route handler, for a route whose body is already parsed (or a raw string). */
export function fastifyBackchannelLogout(options: BackchannelLogoutOptions) {
  return async (request: { body?: unknown }, reply: FastifyLikeReply): Promise<unknown> => {
    const out = await handleBackchannelLogout(request.body, options);
    return reply.code(out.status).headers(out.headers).send(out.body);
  };
}

/**
 * Fastify plugin: registers `POST <path>` (default `/auth/backchannel-logout`)
 * with a form-body parser in its own scope, so nothing else in your app changes:
 * `app.register(fastifyBackchannelLogoutPlugin, { issuer, clientId, onLogout })`.
 */
export function fastifyBackchannelLogoutPlugin(
  app: FastifyLikeInstance,
  options: BackchannelLogoutOptions & { path?: string },
  done?: (err?: Error) => void,
): void {
  if (!app.hasContentTypeParser?.('application/x-www-form-urlencoded')) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, cb) => cb(null, body));
  }
  app.post(options.path ?? '/auth/backchannel-logout', fastifyBackchannelLogout(options));
  done?.();
}

// ---------------------------------------------------------------------------
// Next.js App Router (and any Fetch-API runtime: Remix, Hono, Workers, Bun, Deno)

/**
 * A Fetch-API handler: in `app/api/auth/backchannel-logout/route.ts`,
 * `export const POST = nextBackchannelLogout({ issuer, clientId, onLogout })`.
 */
export function nextBackchannelLogout(options: BackchannelLogoutOptions) {
  return async (request: Request): Promise<Response> => {
    const text = await request.text().catch(() => '');
    const out = await handleBackchannelLogout(text, options);
    return new Response(out.body, { status: out.status, headers: out.headers });
  };
}

/** Alias of {@link nextBackchannelLogout} for other Fetch-API frameworks. */
export const fetchBackchannelLogout = nextBackchannelLogout;

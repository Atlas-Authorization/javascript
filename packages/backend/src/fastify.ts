import { AtlasBackend, type AtlasBackendOptions, type AuthorizedSession } from './verify';
import { createWebhookHandler, type WebhookHandlerOptions } from './fetch-handlers';
import type { AuthStatus } from './auth-status';

/**
 * `@atlasauth/backend/fastify`: one plugin for an API that sits behind Fastify (a frontend on one host, this API
 * on another). It decorates the app with:
 *
 * - `app.atlasBackend`: the verifier (`verify(token)` for a websocket upgrade or any token you read yourself).
 * - `app.authenticate`: a `preHandler` that accepts the `__session` cookie or an `Authorization: Bearer` token and
 *   sets `request.atlasAuth`; it answers 401 otherwise.
 * - optional routes: a webhook (raw body, signature, dedupe by delivery id) and a sign-in exchange.
 *
 * Fastify itself is a peer you already have: nothing here imports it, so the plugin works with v4 and v5.
 */

/** The slice of a Fastify request the plugin touches. */
export interface FastifyLikeRequest {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  url: string;
  body?: unknown;
  atlasAuth?: AuthorizedSession | null;
}

export interface FastifyLikeReply {
  code(status: number): FastifyLikeReply;
  header(name: string, value: string | string[]): FastifyLikeReply;
  send(payload?: unknown): FastifyLikeReply;
}

type Handler = (request: FastifyLikeRequest, reply: FastifyLikeReply) => unknown;

/** The slice of a Fastify instance the plugin touches. */
export interface FastifyLikeInstance {
  decorate(name: string, value: unknown): unknown;
  decorateRequest(name: string, value: unknown): unknown;
  register(plugin: (instance: FastifyLikeInstance, opts: unknown, done: (err?: Error) => void) => void): unknown;
  addContentTypeParser(
    contentType: string,
    opts: { parseAs: 'buffer' },
    parser: (request: unknown, body: Buffer, done: (err: Error | null, body?: unknown) => void) => void,
  ): unknown;
  post(url: string, handler: Handler): unknown;
}

export interface AtlasFastifyExchangeOptions {
  /** Route path (POST). Default `/atlas/exchange`. */
  path?: string;
  /**
   * Runs once the token passed `verifyOnline` (signature, expiry AND not revoked at Atlas). Create your own session
   * here (`syncLocalUser`, set your cookie) and return the response body. Throw to answer 500.
   */
  onExchange(session: AuthorizedSession, ctx: { request: FastifyLikeRequest; reply: FastifyLikeReply }): unknown | Promise<unknown>;
}

export interface AtlasFastifyOptions {
  /** A backend you built, or its options (`issuer` is required; `secretKey` / `bapiBaseUrl` default from `ATLAS_SECRET_KEY` / `ATLAS_API_URL`). */
  backend: AtlasBackend | AtlasBackendOptions;
  /** Name of the preHandler decorator. Default `authenticate`. */
  decorator?: string;
  /** Mount a webhook route (POST) at `path`: raw body, signature check, dedupe by delivery id (`store`: `sqlDedupeStore`, `redisDedupeStore`, ...). */
  webhook?: WebhookHandlerOptions & { path: string };
  /** Mount the sign-in exchange route (POST): the frontend sends its Atlas token as a Bearer header or `{ "token": "..." }`. */
  exchange?: AtlasFastifyExchangeOptions;
}

/** What `authenticate` answers on failure, so a client can tell "renew" from "sign in". */
function unauthorized(reply: FastifyLikeReply, reason: string, status?: AuthStatus): FastifyLikeReply {
  return reply.code(401).send({ error: 'unauthorized', reason, ...(status ? { status } : {}) });
}

/** The incoming request as a Fetch `Request` over the buffered raw body, for the shared webhook handler. */
function toFetchRequest(request: FastifyLikeRequest): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(request.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const host = headers.get('host') ?? 'localhost';
  const raw = request.body instanceof Uint8Array ? request.body : new Uint8Array();
  return new Request(`http://${host}${request.url}`, { method: request.method, headers, body: raw });
}

function bearerOf(request: FastifyLikeRequest): string | undefined {
  const h = request.headers.authorization;
  const v = Array.isArray(h) ? h[0] : h;
  return v?.startsWith('Bearer ') ? v.slice(7) : undefined;
}

// `any`: a real FastifyInstance is far wider than the slice above, and a narrower parameter type would refuse it in `register`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function atlasFastify(instance: any, options: AtlasFastifyOptions, done: (err?: Error) => void): void {
  const app = instance as FastifyLikeInstance;
  let backend: AtlasBackend;
  try {
    backend = options.backend instanceof AtlasBackend ? options.backend : new AtlasBackend(options.backend);
  } catch (e) {
    return done(e as Error);
  }
  app.decorate('atlasBackend', backend);
  app.decorateRequest('atlasAuth', null);
  app.decorate(options.decorator ?? 'authenticate', async (request: FastifyLikeRequest, reply: FastifyLikeReply) => {
    const result = await backend.authenticateRequest({ headers: request.headers as Record<string, string | undefined> });
    if (!result.ok) return unauthorized(reply, result.reason, result.status);
    request.atlasAuth = result;
    return undefined;
  });

  // Own scope per route family: a raw-body parser for the webhook must not change how the rest of the app parses JSON.
  const { webhook, exchange } = options;
  if (webhook) {
    const handle = createWebhookHandler(webhook);
    app.register((scope, _o, next) => {
      scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_r, body, cb) => cb(null, body));
      scope.post(webhook.path, async (request, reply) => {
        const res = await handle(toFetchRequest(request));
        reply.code(res.status).header('content-type', res.headers.get('content-type') ?? 'application/json');
        return reply.send(await res.text());
      });
      next();
    });
  }
  if (exchange) {
    app.post(exchange.path ?? '/atlas/exchange', async (request, reply) => {
      const body = request.body as { token?: unknown } | null | undefined;
      const token = bearerOf(request) ?? (typeof body?.token === 'string' ? body.token : undefined);
      if (!token) return unauthorized(reply, 'malformed');
      // verifyOnline: a sign-in exchange is where "revoked a second ago" must not pass. It throws a typed
      // AtlasConfigError when no secret key is configured, which Fastify answers as 500.
      const result = await backend.verifyOnline(token);
      if (!result.ok) return unauthorized(reply, result.reason);
      return exchange.onExchange(result, { request, reply });
    });
  }
  done();
}

// Same effect as fastify-plugin: decorators land on the app that registered us, not on a private child.
(atlasFastify as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;
(atlasFastify as unknown as Record<symbol, string>)[Symbol.for('fastify.display-name')] = 'atlas-backend';

export default atlasFastify;

import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import {
  createBeforeUserCreateHandler,
  createMountHandler,
  createVerifyHandler,
  createWebhookHandler,
  type AtlasMountOptions,
  type BeforeUserCreateHandlerOptions,
  type WebhookHandlerOptions,
} from '@atlasauth/backend';
import { ATLAS_FASTIFY_VERSION } from './version';

/** Options for {@link atlasMountPlugin}: the mount options of `@atlasauth/backend`, plus the optional webhook and hook routes. */
export interface AtlasMountPluginOptions extends AtlasMountOptions {
  /** Serve `GET /.well-known/atlas-verify/<token>` (token = `verifyToken` / `ATLAS_VERIFY_TOKEN`). Default true. */
  verify?: boolean;
  /** Mount a webhook route (POST) at `path`. */
  webhook?: WebhookHandlerOptions & { path: string };
  /** Mount a `before_user_create` hook route (POST) at `path`. */
  beforeUserCreate?: BeforeUserCreateHandlerOptions & { path: string };
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;

/** The incoming Fastify request as a Fetch `Request`: original URL, raw headers, the unparsed body stream. */
function toFetchRequest(request: FastifyRequest): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(request.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const url = `${request.protocol}://${request.headers.host ?? 'localhost'}${request.raw.url ?? '/'}`;
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(url, {
    method: request.method,
    headers,
    body: hasBody ? (Readable.toWeb(request.raw) as unknown as ReadableStream) : undefined,
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit);
}

async function send(reply: FastifyReply, res: Response): Promise<FastifyReply> {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  res.headers.forEach((value, key) => {
    if (key !== 'set-cookie') reply.header(key, value);
  });
  const cookies = h.getSetCookie?.() ?? [];
  if (cookies.length) reply.header('set-cookie', cookies);
  reply.code(res.status);
  return reply.send(res.body ? Readable.fromWeb(res.body as never) : undefined);
}

/**
 * Mount Atlas under a path of your Fastify app with one `register` call: the Frontend API proxy at
 * `basePath` (default `/atlas`), the domain-verification file, and optional webhook / `before_user_create`
 * routes. Same behaviour as `createMountHandler` in `@atlasauth/nextjs` (allow-listed headers and cookies,
 * `clientIp` / `trustedProxyHops`, 503 without `ATLAS_UPSTREAM` / `ATLAS_PROXY_SECRET`).
 *
 * The plugin is encapsulated and hands bodies through unparsed (the proxy streams them and webhook
 * signatures cover the exact bytes), so it does not change body parsing for the rest of your app.
 *
 * ```ts
 * app.register(atlasMountPlugin({ basePath: '/atlas', webhook: { path: '/hooks/atlas', secret, onEvent } }));
 * ```
 */
export function atlasMountPlugin(options: AtlasMountPluginOptions = {}): FastifyPluginCallback {
  const mount = createMountHandler({ sdk: { name: '@atlasauth/fastify', version: ATLAS_FASTIFY_VERSION }, ...options });
  const base = `/${(options.basePath ?? '/atlas').trim().replace(/^\/+|\/+$/g, '')}`;
  const verify = createVerifyHandler(options);
  const route = (instance: FastifyInstance, method: 'GET' | 'POST', url: string, handler: (r: Request) => Promise<Response>) =>
    instance.route({ method, url, handler: async (req, reply) => send(reply, await handler(toFetchRequest(req))) });

  return function plugin(instance, _opts, done) {
    instance.removeAllContentTypeParsers();
    instance.addContentTypeParser('*', (_req, _payload, next) => next(null));
    instance.route({
      method: [...METHODS],
      url: base,
      exposeHeadRoute: false,
      handler: async (req, reply) => send(reply, await mount.GET(toFetchRequest(req))),
    });
    instance.route({
      method: [...METHODS],
      url: `${base}/*`,
      exposeHeadRoute: false,
      handler: async (req, reply) => send(reply, await mount.GET(toFetchRequest(req))),
    });
    if (options.verify !== false) route(instance, 'GET', '/.well-known/atlas-verify/:token', (r) => verify.GET(r));
    if (options.webhook) route(instance, 'POST', options.webhook.path, createWebhookHandler(options.webhook));
    if (options.beforeUserCreate) route(instance, 'POST', options.beforeUserCreate.path, createBeforeUserCreateHandler(options.beforeUserCreate));
    done();
  };
}

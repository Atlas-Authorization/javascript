/**
 * Serve the Atlas Frontend API under a path of your Next.js app (a path mount),
 * with no reverse proxy of your own: a catch-all App Router route forwards
 * `/<base>/…` to your instance's Frontend API host with the headers Atlas needs.
 *
 * ```ts
 * // app/atlas/[[...path]]/route.ts
 * import { createMountHandler } from '@atlasauth/nextjs';
 * export const { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } = createMountHandler({ basePath: '/atlas' });
 *
 * // app/.well-known/atlas-verify/[token]/route.ts
 * import { createVerifyHandler } from '@atlasauth/nextjs';
 * export const { GET } = createVerifyHandler();
 * ```
 *
 * Use a base path without a leading underscore (`/atlas`, not `/__atlas`): the
 * App Router treats `_folder` as private and never routes it.
 *
 * Web-standard only (`fetch`, `Headers`, `Response`), so it runs on the Node.js
 * and Edge runtimes.
 */

type Env = Record<string, string | undefined>;

function readEnv(): Env {
  return (globalThis as { process?: { env?: Env } }).process?.env ?? {};
}

export interface AtlasMountOptions {
  /** Your instance's Frontend API host (`instructions.upstream` of the domain). Default `ATLAS_UPSTREAM`. */
  upstream?: string;
  /** The instance proxy secret. Default `ATLAS_PROXY_SECRET`. */
  proxySecret?: string;
  /** The domain verification token (for {@link createVerifyHandler}). Default `ATLAS_VERIFY_TOKEN`. */
  verifyToken?: string;
  /** The mount's `base_path`, as registered with Atlas. Default `/atlas`. */
  basePath?: string;
  fetchImpl?: typeof fetch;
}

type Handler = (request: Request) => Promise<Response>;

export interface AtlasMountHandlers {
  GET: Handler;
  POST: Handler;
  PUT: Handler;
  PATCH: Handler;
  DELETE: Handler;
  OPTIONS: Handler;
  HEAD: Handler;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'content-length']);
const dropRequestHeader = (name: string) =>
  HOP_BY_HOP.has(name) || name.startsWith('proxy-') || name.startsWith('x-atlas-') || name.startsWith('x-forwarded-') || name === 'forwarded' || name === 'x-real-ip';
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'content-encoding', 'content-length', 'set-cookie']);
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

function setCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function clientIp(headers: Headers): string | undefined {
  const xff = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return xff || headers.get('x-real-ip')?.trim() || undefined;
}

/** `/atlas`, normalised: one leading slash, no trailing slash. */
function normaliseBase(raw: string): string {
  const base = `/${raw.trim().replace(/^\/+|\/+$/g, '')}`;
  if (base === '/') throw new Error('@atlasauth/nextjs createMountHandler: basePath must not be "/"');
  return base;
}

/**
 * App Router handlers that forward the mount to Atlas: method, path (base
 * included: Atlas reads the prefix from it), query and streamed body unchanged;
 * hop-by-hop headers dropped; `X-Atlas-Forwarded-Host`, `X-Atlas-Proxy-Secret`,
 * `X-Atlas-Client-IP`, `X-Forwarded-For` and `X-Forwarded-Proto` set from the
 * request (never passed on from the browser). The response keeps its status,
 * headers and EVERY `Set-Cookie`; redirects are returned, not followed.
 */
export function createMountHandler(options: AtlasMountOptions = {}): AtlasMountHandlers {
  const handle: Handler = async (request) => {
    const env = readEnv();
    const upstream = options.upstream ?? env.ATLAS_UPSTREAM;
    const proxySecret = options.proxySecret ?? env.ATLAS_PROXY_SECRET;
    if (!upstream) throw new Error('@atlasauth/nextjs createMountHandler: set ATLAS_UPSTREAM (your Frontend API host).');
    if (!proxySecret) throw new Error('@atlasauth/nextjs createMountHandler: set ATLAS_PROXY_SECRET (POST /v1/instance/proxy_secret).');
    const base = normaliseBase(options.basePath ?? '/atlas');

    const url = new URL(request.url);
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) {
      return new Response('Not found', { status: 404 });
    }
    const origin = new URL(/^https?:\/\//i.test(upstream) ? upstream : `https://${upstream}`).origin;
    const target = `${origin}${url.pathname}${url.search}`;

    const headers = new Headers();
    request.headers.forEach((value, key) => {
      if (!dropRequestHeader(key.toLowerCase())) headers.set(key, value);
    });
    headers.set('x-atlas-forwarded-host', request.headers.get('host') ?? url.host);
    headers.set('x-atlas-proxy-secret', proxySecret);
    const ip = clientIp(request.headers);
    if (ip) {
      headers.set('x-atlas-client-ip', ip);
      headers.set('x-forwarded-for', ip);
    }
    headers.set('x-forwarded-proto', request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', ''));

    const method = request.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD' && request.body !== null;
    const res = await (options.fetchImpl ?? fetch)(target, {
      method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
      // Required by fetch to stream a request body.
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit);

    const out = new Headers();
    res.headers.forEach((value, key) => {
      if (!DROP_RESPONSE.has(key.toLowerCase())) out.append(key, value);
    });
    for (const cookie of setCookies(res.headers)) out.append('set-cookie', cookie);
    const body = method === 'HEAD' || NULL_BODY_STATUS.has(res.status) ? null : res.body;
    return new Response(body, { status: res.status, statusText: res.statusText, headers: out });
  };
  return { GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle, OPTIONS: handle, HEAD: handle };
}

type VerifyContext = { params: { token?: string | string[] } | Promise<{ token?: string | string[] }> };

/**
 * The domain-verification file for `app/.well-known/atlas-verify/[token]/route.ts`:
 * 200 `text/plain` with the token when it equals `ATLAS_VERIFY_TOKEN`
 * (or `verifyToken`), else 404.
 */
export function createVerifyHandler(options: Pick<AtlasMountOptions, 'verifyToken'> = {}): {
  GET: (request: Request, context?: VerifyContext) => Promise<Response>;
} {
  return {
    async GET(request, context) {
      const expected = options.verifyToken ?? readEnv().ATLAS_VERIFY_TOKEN;
      const fromParams = context ? (await context.params).token : undefined;
      const token =
        (Array.isArray(fromParams) ? fromParams[0] : fromParams) ??
        decodeURIComponent(new URL(request.url).pathname.split('/').filter(Boolean).pop() ?? '');
      if (!expected || token !== expected) return new Response('Not found', { status: 404 });
      return new Response(token, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    },
  };
}

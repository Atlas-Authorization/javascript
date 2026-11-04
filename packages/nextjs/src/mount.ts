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
  /**
   * Derive the client IP forwarded to Atlas as `X-Atlas-Client-IP` yourself
   * (for example from your platform's verified request IP). Takes precedence
   * over `trustedProxyHops`. A value that is not an IP address is dropped.
   */
  clientIp?: (request: Request) => string | undefined;
  /**
   * How many proxies in front of this app append to `X-Forwarded-For`. The
   * client IP is the entry that many places from the right (default 1: the
   * rightmost, appended by the nearest proxy). Entries further left are
   * browser-controlled and never used. `0` forwards no client IP.
   */
  trustedProxyHops?: number;
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

/** An IPv4/IPv6 address with any port or brackets stripped, or undefined when `raw` is not one. */
function normaliseIp(raw: string | undefined): string | undefined {
  let v = raw?.trim() ?? '';
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracketed) v = bracketed[1]!;
  else if (/^[\d.]+:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(':'));
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return v.split('.').every((o) => Number(o) <= 255) ? v : undefined;
  if (!v.includes(':') || !/^[0-9a-fA-F:.]+$/.test(v)) return undefined;
  try {
    new URL(`http://[${v}]/`); // the WHATWG URL parser validates IPv6 on every runtime
    return v;
  } catch {
    return undefined;
  }
}

/**
 * The client IP: `options.clientIp(request)` when given, else the
 * `X-Forwarded-For` entry `trustedProxyHops` from the right. The browser can
 * set any `X-Forwarded-For` / `X-Real-IP`, so leftmost entries are never trusted.
 */
function clientIp(request: Request, options: AtlasMountOptions): string | undefined {
  if (options.clientIp) return normaliseIp(options.clientIp(request));
  const hops = options.trustedProxyHops ?? 1;
  if (hops <= 0) return undefined;
  const entries = request.headers.get('x-forwarded-for')?.split(',') ?? [];
  return entries.length < hops ? undefined : normaliseIp(entries[entries.length - hops]);
}

let loggedMisconfig = false;

/** `/atlas`, normalised: one leading slash, no trailing slash. */
function normaliseBase(raw: string): string {
  const base = `/${raw.trim().replace(/^\/+|\/+$/g, '')}`;
  if (base === '/') throw new Error('@atlasauth/nextjs createMountHandler: basePath must not be "/"');
  return base;
}

/**
 * App Router handlers that forward the mount to Atlas: method, path (base
 * included: Atlas reads the prefix from it), query and streamed body unchanged;
 * hop-by-hop headers dropped. Every incoming `X-Atlas-*`, `X-Forwarded-*`,
 * `Forwarded` and `X-Real-IP` header is dropped, then set as: `X-Atlas-Forwarded-Host`
 * from `Host`; `X-Atlas-Proxy-Secret` from config; `X-Atlas-Client-IP` and
 * `X-Forwarded-For` from `options.clientIp`, else the incoming `X-Forwarded-For`
 * entry `trustedProxyHops` (default 1) from the right, omitted when absent or not
 * an IP; `X-Forwarded-Proto` from the last incoming `X-Forwarded-Proto` entry (http or https only),
 * else the request URL's scheme. The response keeps its status, headers and EVERY
 * `Set-Cookie`; redirects are returned, not followed. Without an upstream or
 * proxy secret it answers 503 (logged once).
 */
export function createMountHandler(options: AtlasMountOptions = {}): AtlasMountHandlers {
  const handle: Handler = async (request) => {
    const env = readEnv();
    const upstream = options.upstream ?? env.ATLAS_UPSTREAM;
    const proxySecret = options.proxySecret ?? env.ATLAS_PROXY_SECRET;
    if (!upstream || !proxySecret) {
      if (!loggedMisconfig) {
        loggedMisconfig = true;
        console.error(
          !upstream
            ? '@atlasauth/nextjs createMountHandler: set ATLAS_UPSTREAM (your Frontend API host).'
            : '@atlasauth/nextjs createMountHandler: set ATLAS_PROXY_SECRET (POST /v1/instance/proxy_secret).',
        );
      }
      return new Response('Atlas is not configured', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
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
    const ip = clientIp(request, options);
    if (ip) {
      headers.set('x-atlas-client-ip', ip);
      headers.set('x-forwarded-for', ip);
    }
    // Rightmost entry (the nearest proxy's), http or https only: a browser-sent value cannot downgrade the scheme.
    const proto = request.headers.get('x-forwarded-proto')?.split(',').pop()?.trim().toLowerCase();
    headers.set('x-forwarded-proto', proto === 'http' || proto === 'https' ? proto : url.protocol.replace(':', ''));

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

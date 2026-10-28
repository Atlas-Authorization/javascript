/**
 * A fake vendor API for exporter tests: routes are `METHOD path?query` (the
 * query as the exporter sends it) → a JSON body, a status + body, or a
 * function of the request. Unrouted calls answer 404, so an exporter that
 * calls something unexpected degrades the way it would against a vendor that
 * lacks the endpoint. Every call is recorded (with its headers) for assertions.
 */
export type Route = unknown | { status: number; body?: unknown; headers?: Record<string, string> } | ((req: { url: URL; body: unknown; headers: Headers }) => unknown);

export interface FakeVendor {
  fetchImpl: typeof fetch;
  calls: Array<{ method: string; url: string; headers: Headers; body: unknown }>;
}

const isStatus = (v: unknown): v is { status: number; body?: unknown; headers?: Record<string, string> } =>
  typeof v === 'object' && v !== null && 'status' in v && typeof (v as { status: unknown }).status === 'number' && Object.keys(v).every((k) => ['status', 'body', 'headers'].includes(k));

export function fakeVendor(origin: string, routes: Record<string, Route>): FakeVendor {
  const calls: FakeVendor['calls'] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    let body: unknown = init.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        // form-encoded or plain text: kept as the string
      }
    }
    calls.push({ method, url: url.toString(), headers, body });
    const key = url.origin === origin ? `${method} ${url.pathname}${url.search}` : `${method} ${url.toString()}`;
    let route = routes[key];
    if (route === undefined) route = routes[`${method} ${url.pathname}`];
    if (route === undefined) return new Response(JSON.stringify({ message: `no route for ${key}` }), { status: 404 });
    const value = typeof route === 'function' ? (route as (r: { url: URL; body: unknown; headers: Headers }) => unknown)({ url, body, headers }) : route;
    if (value instanceof Uint8Array) return new Response(value, { status: 200 });
    const resolved = isStatus(value) ? value : { status: 200, body: value };
    return new Response(resolved.body === undefined ? '' : JSON.stringify(resolved.body), {
      status: resolved.status,
      headers: { 'content-type': 'application/json', ...(resolved.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export const noSleep = async () => undefined;

/**
 * The emulator: `@atlasauth/msw`'s in-memory FAPI/BAPI behind a real HTTP
 * listener, plus OIDC discovery, a mail/SMS catcher and an optional one-origin
 * proxy to your app (`app`), so cookies and CORS behave like production.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { getResponse } from 'msw';
import { atlasHandlers, createAtlasMock, type AtlasMock, type AtlasMockSeed } from '@atlasauth/msw';

export interface CaughtMessage {
  id: number;
  at: string;
  channel: 'email' | 'sms';
  to: string;
  strategy: string;
  code: string;
}

export interface EmulatorOptions {
  port?: number;
  host?: string;
  seed?: AtlasMockSeed;
  /** Proxy every path the emulator does not own to this app URL (one origin). */
  app?: string;
}

export interface Emulator {
  url: string;
  mock: AtlasMock;
  mail: CaughtMessage[];
  close(): Promise<void>;
}

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const method = req.method ?? 'GET';
  return new Request(new URL(req.url ?? '/', origin), { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body });
}

async function send(res: ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => {
    if (!HOP.has(k) && k !== 'set-cookie') headers[k] = v;
  });
  const cookies = r.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
}

/** shortcut: no WebSocket upgrade proxying (framework HMR sockets), add when a dev server needs it. */
async function proxy(app: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, app);
  const headers = new Headers(request.headers);
  headers.set('x-forwarded-host', url.host);
  headers.delete('host');
  try {
    return await fetch(target, { method: request.method, headers, body: request.body, redirect: 'manual', duplex: 'half' } as RequestInit);
  } catch (err) {
    return new Response(`Atlas emulator could not reach ${app}: ${(err as Error).message}`, { status: 502 });
  }
}

export async function startEmulator(options: EmulatorOptions = {}): Promise<Emulator> {
  const host = options.host ?? '127.0.0.1';
  const mail: CaughtMessage[] = [];
  const seen = new Set<string>();
  let origin = '';
  // eslint-disable-next-line prefer-const -- assigned once below, but `harvest` closes over it before that point
  let mock!: AtlasMock;
  let handlers: ReturnType<typeof atlasHandlers> = [];

  // The handlers mount on absolute URLs, so they are built once the port is known.
  const harvest = () => {
    for (const a of mock.attempts) {
      if (!a.pendingCode || !a.identifier) continue;
      const key = `${a.id}:${a.strategy}:${a.pendingCode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sms = a.strategy === 'phone_code';
      mail.push({ id: mail.length + 1, at: new Date().toISOString(), channel: sms ? 'sms' : 'email', to: a.identifier, strategy: a.strategy ?? 'verification', code: a.pendingCode });
    }
  };

  const own = async (request: Request): Promise<Response | null> => {
    const { pathname } = new URL(request.url);
    if (pathname === '/.well-known/openid-configuration') {
      return Response.json({
        issuer: origin,
        jwks_uri: `${origin}/.well-known/jwks.json`,
        authorization_endpoint: `${origin}/oauth2/authorize`,
        token_endpoint: `${origin}/oauth2/token`,
        userinfo_endpoint: `${origin}/oauth2/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
    }
    if (pathname === '/__emulator/mail.json') return Response.json({ data: mail });
    if (pathname === '/__emulator/mail') {
      const rows = [...mail].reverse().map((m) => `<tr><td>${esc(m.at)}</td><td>${m.channel}</td><td>${esc(m.to)}</td><td>${esc(m.strategy)}</td><td><code>${esc(m.code)}</code></td></tr>`).join('');
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>Atlas emulator mail</title><h1>Caught messages</h1><table border="1" cellpadding="6"><tr><th>time</th><th>channel</th><th>to</th><th>strategy</th><th>code</th></tr>${rows || '<tr><td colspan="5">Nothing yet.</td></tr>'}</table>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    }
    if (pathname === '/__emulator/reset' && request.method === 'POST') {
      mock.reset();
      mail.length = 0;
      seen.clear();
      return Response.json({ ok: true });
    }
    const res = await getResponse(handlers, request);
    if (res) harvest();
    return res ?? null;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const request = await toRequest(req, origin);
      const r = (await own(request)) ?? (options.app ? await proxy(options.app, request) : Response.json({ error: { code: 'NOT_FOUND', message: 'Not served by the emulator.' } }, { status: 404 }));
      await send(res, r);
    })().catch((err) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'EMULATOR_ERROR', message: String((err as Error).message) } }));
    });
  });
  await new Promise<void>((ok) => server.listen(options.port ?? 0, host, ok));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (options.port ?? 0);
  origin = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
  const seed = options.seed ?? {};
  mock = createAtlasMock({ ...seed, instance: { ...seed.instance, fapiBaseUrl: origin, bapiBaseUrl: origin } });
  handlers = atlasHandlers(mock);
  return { url: origin, mock, mail, close: () => new Promise((ok) => (server.closeAllConnections(), server.close(() => ok()))) };
}

export interface ProxyOptions {
  port?: number;
  host?: string;
  /** Your app (e.g. http://localhost:3000). */
  app: string;
  /** The Atlas Frontend API to forward `/v1/*` and `/.well-known/*` to. */
  api: string;
}

/** `atlas dev proxy`: one origin for the app and FAPI, so session cookies are first-party. */
export async function startProxy(options: ProxyOptions): Promise<{ url: string; close(): Promise<void> }> {
  const host = options.host ?? '127.0.0.1';
  const server = createServer((req, res) => {
    void (async () => {
      const request = await toRequest(req, `http://${host}`);
      const p = new URL(request.url).pathname;
      const toApi = p.startsWith('/v1/') || p.startsWith('/.well-known/') || p.startsWith('/oauth2/');
      await send(res, await proxy(toApi ? options.api : options.app, request));
    })().catch(() => {
      res.writeHead(502);
      res.end('proxy error');
    });
  });
  await new Promise<void>((ok) => server.listen(options.port ?? 0, host, ok));
  const addr = server.address();
  return { url: `http://${host}:${typeof addr === 'object' && addr ? addr.port : 0}`, close: () => new Promise((ok) => (server.closeAllConnections(), server.close(() => ok()))) };
}

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Engine, createEmulatorEngine, type EmulatorOptions } from './engine';
import type { Obj } from './openapi';

/** Read an OpenAPI document from a file path, an http(s) URL, or pass an already parsed one through. */
export async function loadOpenApi(source: string | Obj): Promise<Obj> {
  if (typeof source !== 'string') return source;
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Could not load the OpenAPI document from ${source}: HTTP ${res.status}`);
    return (await res.json()) as Obj;
  }
  return JSON.parse(readFileSync(source, 'utf8')) as Obj;
}

export interface EmulatorServerOptions extends Omit<EmulatorOptions, 'openapi'> {
  /** The OpenAPI document, or a path / URL to it. */
  openapi: string | Obj;
  port?: number;
  host?: string;
}

export interface EmulatorServer {
  url: string;
  engine: Engine;
  close(): Promise<void>;
}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const method = req.method ?? 'GET';
  return new Request(new URL(req.url ?? '/', origin), { method, headers, body: method === 'GET' || method === 'HEAD' || !chunks.length ? undefined : Buffer.concat(chunks) });
}

async function send(res: ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    if (k !== 'content-length' && k !== 'transfer-encoding') headers[k] = v;
  });
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
}

/** The engine behind a real HTTP listener, with CORS open so a browser app can call it. */
export async function startEmulatorServer(options: EmulatorServerOptions): Promise<EmulatorServer> {
  const host = options.host ?? '127.0.0.1';
  const engine = createEmulatorEngine({ ...options, openapi: await loadOpenApi(options.openapi) });
  let origin = '';
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' });
        return void res.end();
      }
      const r = await engine.handle(await toRequest(req, origin));
      r.headers.set('access-control-allow-origin', '*');
      await send(res, r);
    })().catch((err) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ code: 'EMULATOR_ERROR', message: String((err as Error).message) }] }));
    });
  });
  await new Promise<void>((ok) => server.listen(options.port ?? 0, host, ok));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (options.port ?? 0);
  origin = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
  if (!options.issuer) engine.tokens.setIssuer(origin);
  return {
    url: origin,
    engine,
    close: async () => {
      await engine.close();
      await new Promise<void>((ok) => (server.closeAllConnections(), server.close(() => ok())));
    },
  };
}

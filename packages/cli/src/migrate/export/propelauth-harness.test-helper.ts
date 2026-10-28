import type { MigrationBundleWriter, RecordIssue } from '@atlasauth/migrate';
import type { ParsedArgs } from '../../args';
import type { RunContext } from '../../context';
import { CliError } from '../../errors';
import type { CredentialSpec, ExportCursor, PluginContext } from '../framework/plugin';

/**
 * Test harness for the PropelAuth and Userfront tracks: a fake vendor API
 * (routes are `METHOD path?query` as the exporter sends it; unrouted calls
 * answer 404, so an exporter that calls something unexpected degrades the way
 * it would against a vendor that lacks the endpoint), a hand-built
 * PluginContext and a bundle writer that records every call.
 */
export type Route = unknown | { status: number; body?: unknown } | ((req: { url: URL; body: unknown; headers: Headers }) => unknown);

export interface FakeVendor {
  fetchImpl: typeof fetch;
  calls: Array<{ method: string; url: string; headers: Headers; body: unknown }>;
}

const isStatus = (v: unknown): v is { status: number; body?: unknown } =>
  typeof v === 'object' && v !== null && 'status' in v && typeof (v as { status: unknown }).status === 'number' && Object.keys(v).every((k) => ['status', 'body'].includes(k));

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
        // plain text: kept as the string
      }
    }
    calls.push({ method, url: url.toString(), headers, body });
    const key = url.origin === origin ? `${method} ${url.pathname}${url.search}` : `${method} ${url.toString()}`;
    let route = routes[key];
    if (route === undefined) route = routes[`${method} ${url.pathname}`];
    if (route === undefined) return new Response(JSON.stringify({ message: `no route for ${key}` }), { status: 404 });
    const value = typeof route === 'function' ? (route as (r: { url: URL; body: unknown; headers: Headers }) => unknown)({ url, body, headers }) : route;
    const resolved = isStatus(value) ? value : { status: 200, body: value };
    return new Response(resolved.body === undefined ? '' : JSON.stringify(resolved.body), { status: resolved.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export const noSleep = async () => undefined;

export interface Harness {
  p: PluginContext;
  said: string[];
}

export function context(opts: { values?: Record<string, unknown>; env?: Record<string, string>; files?: Record<string, string>; fetch?: typeof fetch } = {}): Harness {
  const values = opts.values ?? {};
  const env = opts.env ?? {};
  const files = opts.files ?? {};
  const said: string[] = [];
  const p: PluginContext = {
    ctx: {
      env,
      readFile: (path: string) => {
        const text = files[path];
        if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
        return text;
      },
    } as unknown as RunContext,
    args: { positionals: [], values } as unknown as ParsedArgs,
    project: '/project',
    credential(spec: CredentialSpec) {
      const name = spec.flag.replace(/^--/, '');
      const raw = values[name];
      const value = (typeof raw === 'string' && raw.trim() ? raw.trim() : undefined) ?? env[spec.env]?.trim();
      if (value) return value;
      if (spec.required) throw new CliError(`${spec.label} is needed. Pass --set ${name}=<value> or set ${spec.env}.`);
      return undefined;
    },
    fetch:
      opts.fetch ??
      ((async () => {
        throw new Error('no vendor API in this test');
      }) as typeof fetch),
    say: (line) => void said.push(line),
    dryRun: false,
  };
  return { p, said };
}

export class FakeWriter {
  described: unknown[] = [];
  warnings: string[] = [];
  omits: Array<[string, string, number]> = [];
  adds: Array<{ model: string; data: Record<string, unknown> }> = [];
  issues: Record<string, RecordIssue[]> = {};

  describe(fields: unknown): void {
    this.described.push(fields);
  }
  warn(message: string): void {
    this.warnings.push(message);
  }
  omit(model: string, reason: string, count = 1): void {
    this.omits.push([model, reason, count]);
  }
  async add(model: string, data: unknown): Promise<RecordIssue[]> {
    this.adds.push({ model, data: data as Record<string, unknown> });
    return this.issues[model] ?? [];
  }

  get writer(): MigrationBundleWriter {
    return this as unknown as MigrationBundleWriter;
  }
  ids(model: string): unknown[] {
    return this.adds.filter((a) => a.model === model).map((a) => a.data.id);
  }
  models(): string[] {
    return this.adds.map((a) => a.model);
  }
}

export function resumeFrom(cursor: ExportCursor | null = null) {
  const checkpoints: ExportCursor[] = [];
  return { checkpoints, resume: { cursor, checkpoint: (c: ExportCursor) => void checkpoints.push(c) } };
}

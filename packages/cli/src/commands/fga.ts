import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import { httpFor } from '../project';
import { FGA_STORE, resourceCommand } from './resources';
import { envApiUrl, resolveAuth, wantsJson } from './shared';

/**
 * `atlas fga test | validate | transform`: author and test authorization models offline of any store.
 *
 *   test <suite.fga.yaml> [--store <id>]   run an OpenFGA-style test file (model_file / model, tuples / tuple_file, tests)
 *   validate <model.fga|model.json>        check a model compiles
 *   transform <model> --to dsl|json        convert between the DSL and the JSON model
 *
 * Models are checked and tests run on the Atlas server's engine (the same one that answers live checks), in memory:
 * no store tuples are read or written.
 */

interface Report {
  passed: boolean;
  total: number;
  failed: number;
  coverage: { relations: number; covered: number; uncovered: string[] };
  results: Array<{ name: string; passed: boolean; checks: number; failures: Array<{ kind: string; query: string; expected: unknown; actual: unknown; error?: string }> }>;
}

const parseDoc = (path: string, text: string): unknown => {
  try {
    return /\.json$/i.test(path) ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new CliError(`${path} could not be parsed: ${(e as Error).message}`);
  }
};

function http(ctx: RunContext, args: ParsedArgs) {
  const auth = resolveAuth(ctx, args.values);
  return httpFor(ctx, { secretKey: auth.secretKey, apiUrl: envApiUrl(ctx.env) ?? auth.apiUrl });
}

/** Resolve a suite file (`model_file`, `tuple_file` are relative to the suite) into a request body. */
export function loadSuite(ctx: RunContext, path: string): { dsl?: string; model?: unknown; tuples: unknown[]; tests: unknown[] } {
  const doc = parseDoc(path, ctx.readFile(path)) as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object') throw new CliError(`${path} is not a test file.`);
  const rel = (p: string) => resolve(dirname(path), p);
  let dsl: string | undefined;
  let model: unknown;
  if (typeof doc.model === 'string') dsl = doc.model;
  else if (doc.model && typeof doc.model === 'object') model = doc.model;
  else if (typeof doc.model_file === 'string') {
    const mf = rel(doc.model_file);
    const text = ctx.readFile(mf);
    if (/\.json$/i.test(mf)) model = JSON.parse(text);
    else dsl = text;
  } else throw new CliError(`${path} needs a model or model_file.`);
  let tuples = Array.isArray(doc.tuples) ? doc.tuples : [];
  if (typeof doc.tuple_file === 'string') {
    const more = parseDoc(doc.tuple_file, ctx.readFile(rel(doc.tuple_file)));
    if (!Array.isArray(more)) throw new CliError(`${doc.tuple_file} must hold a list of tuples.`);
    tuples = [...tuples, ...more];
  }
  const tests = Array.isArray(doc.tests) ? doc.tests : [];
  if (tests.length === 0) throw new CliError(`${path} has no tests.`);
  return { ...(dsl !== undefined ? { dsl } : {}), ...(model !== undefined ? { model } : {}), tuples, tests };
}

export async function fga(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const [, sub, file] = args.positionals;
  const v = args.values;
  if (sub && sub in FGA_STORE) return resourceCommand('fga', FGA_STORE)(ctx, args);
  if (sub === 'watch') return watch(ctx, args);
  if (!sub || !['test', 'validate', 'transform'].includes(sub)) throw new CliError("Usage: atlas fga test|validate|transform <file> | export|import|watch|materializations|materialize|rebuild|unmaterialize <store> (see 'atlas fga --help').");
  if (!file) throw new CliError(`atlas fga ${sub} needs a file.`);

  if (sub === 'test') {
    const suite = loadSuite(ctx, file);
    // A model given as JSON goes through the transform endpoint so the test route only ever receives DSL.
    const h = http(ctx, args);
    let dsl = suite.dsl;
    if (!dsl) dsl = (await h.post<{ dsl: string }>('/v1/fga/models/transform', { model: suite.model })).dsl;
    const store = str(v, 'store');
    const body = { dsl, tuples: suite.tuples, tests: suite.tests };
    const report = await h.post<Report>(store ? `/v1/fga/stores/${encodeURIComponent(store)}/tests` : '/v1/fga/tests', body);
    if (wantsJson(v)) {
      printJson(ctx.io, report);
      return report.passed ? 0 : 1;
    }
    for (const r of report.results) {
      ctx.io.out(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name}  (${r.checks} assertion${r.checks === 1 ? '' : 's'})`);
      for (const f of r.failures) ctx.io.out(`        ${f.kind} ${f.query}: expected ${JSON.stringify(f.expected)}, got ${f.error ? `error: ${f.error}` : JSON.stringify(f.actual)}`);
    }
    ctx.io.out(`\n${report.total - report.failed}/${report.total} tests passed. Relations covered: ${report.coverage.covered}/${report.coverage.relations}.`);
    if (report.coverage.uncovered.length) ctx.io.out(`Not covered: ${report.coverage.uncovered.join(', ')}`);
    return report.passed ? 0 : 1;
  }

  const text = ctx.readFile(file);
  const isJson = /\.json$/i.test(file);
  const out = await http(ctx, args).post<{ dsl: string; model: unknown }>('/v1/fga/models/transform', isJson ? { model: JSON.parse(text) } : { dsl: text });
  if (sub === 'validate') {
    if (wantsJson(v)) printJson(ctx.io, { valid: true });
    else ctx.io.out(`${file}: valid`);
    return 0;
  }
  const to = str(v, 'to') ?? (isJson ? 'dsl' : 'json');
  if (to !== 'dsl' && to !== 'json') throw new CliError("--to must be 'dsl' or 'json'.");
  ctx.io.out(to === 'dsl' ? out.dsl : JSON.stringify(out.model, null, 2));
  return 0;
}

/** `atlas fga watch <store> [--since <revision>]`: stream tuple changes (server-sent events) until interrupted. */
async function watch(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const store = args.positionals[2];
  if (!store) throw new CliError('atlas fga watch needs a store id.');
  const auth = resolveAuth(ctx, args.values);
  const since = str(args.values, 'since');
  if (since !== undefined && !/^\d+$/.test(since)) throw new CliError('--since must be a store revision (a non-negative integer).');
  const base = (envApiUrl(ctx.env) ?? auth.apiUrl).replace(/\/+$/, '');
  const res = await (ctx.fetch ?? fetch)(`${base}/v1/fga/stores/${encodeURIComponent(store)}/watch${since ? `?since=${since}` : ''}`, {
    headers: { authorization: `Bearer ${auth.secretKey}`, accept: 'text/event-stream' },
    signal: ctx.signal,
  });
  if (!res.ok || !res.body) throw new CliError(`Could not open the watch stream (HTTP ${res.status}).`);
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        buf = buf.slice(i + 2);
        if (data) ctx.io.out(data);
      }
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') throw e;
  }
  return 0;
}

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { deserialize } from '../serialize';

interface Step {
  name: string;
  cwd?: string;
  plan?: string;
  apply?: string;
  depends_on: string[];
  env: Record<string, string>;
}

/** Runs one shell command: the seam tests replace so no real process starts. */
export type SuiteExec = (command: string, opts: { cwd: string; env: NodeJS.ProcessEnv }) => { code: number; output: string };

const realExec: SuiteExec = (command, { cwd, env }) => {
  const r = spawnSync(command, { shell: true, cwd, env, encoding: 'utf8' });
  return { code: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `${r.error.message}\n` : ''}` };
};

/** Parse and check a suite file: names unique, depends_on known, no cycles. Returns steps in dependency order. */
export function loadSuite(text: string, label: string): Step[] {
  let doc: unknown;
  try {
    doc = deserialize(text, text.trimStart().startsWith('{') ? 'json' : 'yaml');
  } catch (err) {
    throw new CliError(`${label}: ${(err as Error).message}`);
  }
  const raw = (doc as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(raw) || raw.length === 0) throw new CliError(`${label} needs a non-empty "steps" list.`);
  const steps: Step[] = raw.map((r, i) => {
    const s = (r ?? {}) as Record<string, unknown>;
    if (typeof s.name !== 'string' || !s.name) throw new CliError(`${label}: step ${i + 1} needs a name.`);
    const deps = s.depends_on ?? [];
    if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string')) throw new CliError(`${label}: step "${s.name}" depends_on must be a list of step names.`);
    for (const k of ['plan', 'apply', 'cwd'] as const) if (s[k] !== undefined && typeof s[k] !== 'string') throw new CliError(`${label}: step "${s.name}" ${k} must be a string.`);
    const env = (s.env ?? {}) as Record<string, unknown>;
    return {
      name: s.name,
      cwd: s.cwd as string | undefined,
      plan: s.plan as string | undefined,
      apply: s.apply as string | undefined,
      depends_on: deps as string[],
      env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])),
    };
  });
  const byName = new Map<string, Step>();
  for (const s of steps) {
    if (byName.has(s.name)) throw new CliError(`${label}: duplicate step name "${s.name}".`);
    byName.set(s.name, s);
  }
  for (const s of steps) {
    for (const d of s.depends_on) if (!byName.has(d)) throw new CliError(`${label}: step "${s.name}" depends_on unknown step "${d}".`);
  }
  const order: Step[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (s: Step, trail: string[]) => {
    if (state.get(s.name) === 'done') return;
    if (state.get(s.name) === 'visiting') throw new CliError(`${label}: dependency cycle: ${[...trail, s.name].join(' -> ')}.`);
    state.set(s.name, 'visiting');
    for (const d of s.depends_on) visit(byName.get(d)!, [...trail, s.name]);
    state.set(s.name, 'done');
    order.push(s);
  };
  for (const s of steps) visit(s, []);
  return order;
}

/** `atlas suite plan|apply <suite.yaml>`: run several config-as-code tools in dependency order. */
export async function runSuite(ctx: RunContext, args: ParsedArgs, exec: SuiteExec = realExec): Promise<number> {
  const mode = args.positionals[1];
  const file = args.positionals[2];
  if ((mode !== 'plan' && mode !== 'apply') || !file) throw new CliError('Usage: atlas suite plan|apply <suite.yaml> [--only <step>] [--json]');
  let steps = loadSuite(ctx.readFile(file), file);
  const only = str(args.values, 'only');
  if (only) {
    const byName = new Map(steps.map((s) => [s.name, s]));
    if (!byName.has(only)) throw new CliError(`--only ${only}: no such step. Steps: ${steps.map((s) => s.name).join(', ')}.`);
    const keep = new Set<string>();
    const add = (n: string) => {
      if (keep.has(n)) return;
      keep.add(n);
      byName.get(n)!.depends_on.forEach(add);
    };
    add(only);
    steps = steps.filter((s) => keep.has(s.name));
  }
  const base = dirname(resolve(file));
  const results: Array<{ name: string; status: 'ok' | 'drift' | 'failed' | 'skipped'; exit_code: number | null }> = [];
  let halted = false;
  for (const step of steps) {
    const command = step[mode];
    if (halted) {
      results.push({ name: step.name, status: 'skipped', exit_code: null });
      continue;
    }
    if (!command) {
      results.push({ name: step.name, status: 'ok', exit_code: null });
      continue;
    }
    const { code, output } = exec(command, { cwd: resolve(base, step.cwd ?? '.'), env: { ...ctx.env, ...step.env } });
    if (args.values.json !== true) {
      ctx.io.out(`== ${step.name} (${mode}: ${command}) ==`);
      if (output.trim()) ctx.io.out(output.trimEnd());
    }
    const status = code === 0 ? 'ok' : mode === 'plan' && code === 2 ? 'drift' : 'failed';
    results.push({ name: step.name, status, exit_code: code });
    if (mode === 'apply' && status === 'failed') halted = true;
  }
  const exit = results.some((r) => r.status === 'failed') ? 1 : results.some((r) => r.status === 'drift') ? 2 : 0;
  if (args.values.json === true) ctx.io.out(JSON.stringify({ mode, exit_code: exit, steps: results }, null, 2));
  else {
    ctx.io.out(`Suite ${mode}: ${results.map((r) => `${r.name} ${r.status}`).join(', ')}.`);
  }
  return exit;
}

export const suite = (ctx: RunContext, args: ParsedArgs): Promise<number> => runSuite(ctx, args);

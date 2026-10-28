import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { analyzeBetterAuth, formatMigration, runMigration } from '@atlasauth/upgrade';
import { list, str, type ParsedArgs } from '../../args';
import type { ConfigHttp } from '../../config-http';
import type { RunContext } from '../../context';
import { CliError } from '../../errors';
import { printJson } from '../../output';
import { httpFor } from '../../project';
import { readEnvFile } from '../../secrets';
import { deserialize, serialize, type Format, type Json } from '../../serialize';
import { getVersion } from '../../version';
import { interpolate, planConfigImport, printPlan, resolveFormat } from '../../commands/config';
import { resolveAuth, wantsJson } from '../../commands/shared';
import {
  RESTING_STATUSES,
  applyImport,
  enableSessionBridge,
  exporterCommand,
  finalizeImport,
  getImport,
  getImportPublicKey,
  uploadBundle,
  type ImportJob,
} from './integration';
import { REPORT_MD, summaryLines, writeTranslation } from './output';
import { translateBetterAuth, type Translation } from './translate';

/**
 * `atlas migrate better-auth [path]` — the whole Better Auth → Atlas program as
 * one resumable run:
 *
 *   preflight → translate → apply (review the diff, confirm, config push) →
 *   export (the exporter runs in the app) → import (dry run, confirm, apply) →
 *   bridge (no forced logout) → code (the codemod) → verify (checklist).
 *
 * Each finished step is checkpointed in the state file, so `--resume` carries
 * on where a run stopped (a confirmation declined, an env var missing, the
 * export not run yet). `--dry-run` walks every step without changing the
 * instance or the code; `--yes` answers every confirmation.
 */

export const STEPS = ['preflight', 'translate', 'apply', 'export', 'import', 'bridge', 'code', 'verify'] as const;
export type StepId = (typeof STEPS)[number];

type StepStatus = 'done' | 'skipped' | 'planned' | 'action_needed' | 'awaiting_confirmation' | 'blocked';

interface StepRecord {
  status: StepStatus;
  at?: number;
  detail?: Record<string, unknown>;
  message?: string;
}

export interface MigrationState {
  version: 1;
  project: string;
  instance_id: string | null;
  environment: string | null;
  started_at: number;
  steps: Partial<Record<StepId, StepRecord>>;
}

interface StepResult {
  status: StepStatus;
  detail?: Record<string, unknown>;
  message?: string;
  /** Stop the run after this step (a gate or a missing prerequisite). */
  stop?: boolean;
  exitCode?: number;
}

const DAY_MS = 86_400_000;

class Migration {
  readonly project: string;
  readonly dir: string;
  readonly format: Format;
  readonly statePath: string;
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly entry?: string;
  readonly skip: Set<string>;
  state: MigrationState;
  private http?: ConfigHttp;
  private translation?: Translation;
  readonly env: NodeJS.ProcessEnv;
  readonly log: string[] = [];

  constructor(
    readonly ctx: RunContext,
    readonly args: ParsedArgs,
    projectArg: string | undefined,
  ) {
    const v = args.values;
    this.project = resolve(projectArg ?? process.cwd());
    this.dir = resolve(this.project, str(v, 'dir') ?? 'atlas-migrate/config');
    this.format = resolveFormat(v);
    this.statePath = resolve(this.project, str(v, 'state-file') ?? 'atlas-migrate/state.json');
    this.yes = v.yes === true;
    this.dryRun = v['dry-run'] === true;
    this.json = wantsJson(v);
    this.entry = str(v, 'entry');
    this.skip = new Set(list(v, 'skip'));
    for (const s of this.skip) {
      if (!(STEPS as readonly string[]).includes(s)) throw new CliError(`--skip: unknown step '${s}'. Steps: ${STEPS.join(', ')}.`);
    }
    // Placeholder values: the app's own dotenv files, then the real environment (which wins).
    this.env = { ...readDotenvs(this.project), ...ctx.env };
    this.state = { version: 1, project: this.project, instance_id: null, environment: null, started_at: Date.now(), steps: {} };
  }

  say(line: string): void {
    this.log.push(line);
    if (this.json) this.ctx.io.err(line);
    else this.ctx.io.out(line);
  }

  api(): ConfigHttp {
    if (!this.http) {
      const auth = resolveAuth(this.ctx, this.args.values);
      this.http = httpFor(this.ctx, { secretKey: auth.secretKey, apiUrl: auth.apiUrl });
    }
    return this.http;
  }

  async confirm(question: string): Promise<boolean> {
    if (this.yes) return true;
    if (this.json) return false;
    const answer = await this.ctx.prompt.text(`${question} [y/N]`);
    return /^y(es)?$/i.test(answer.trim());
  }

  loadState(): void {
    const resume = this.args.values.resume === true;
    const force = this.args.values.force === true;
    if (!existsSync(this.statePath)) {
      if (resume) throw new CliError(`Nothing to resume: ${this.statePath} does not exist. Run without --resume to start.`);
      return;
    }
    if (force && !resume) return; // start over; the file is replaced on the first checkpoint
    if (!resume && !this.dryRun) {
      throw new CliError(`A migration is in progress (${this.statePath}). Pass --resume to continue it, or --force to start over.`);
    }
    try {
      this.state = JSON.parse(readFileSync(this.statePath, 'utf8')) as MigrationState;
    } catch {
      throw new CliError(`${this.statePath} is not a valid state file. Delete it or pass --force.`);
    }
  }

  saveState(): void {
    if (this.dryRun) return;
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2) + '\n');
  }

  /** The translation, from this run or (on resume) re-read from the report. */
  getTranslation(): Translation {
    if (this.translation) return this.translation;
    const analysis = analyzeBetterAuth(this.project, this.entry ? { entry: this.entry } : {});
    this.translation = translateBetterAuth(analysis);
    return this.translation;
  }

  async run(): Promise<number> {
    this.loadState();
    let exitCode = 0;
    for (const step of STEPS) {
      const prev = this.state.steps[step];
      if (prev && (prev.status === 'done' || prev.status === 'skipped') && step !== 'verify') {
        this.say(`[${step}] already ${prev.status}${prev.message ? `: ${prev.message}` : ''}`);
        continue;
      }
      if (this.skip.has(step)) {
        this.record(step, { status: 'skipped', message: 'skipped with --skip' });
        this.say(`[${step}] skipped (--skip)`);
        continue;
      }
      this.say(`[${step}]`);
      const result = await HANDLERS[step](this);
      this.record(step, result);
      if (result.message) this.say(`[${step}] ${result.status}: ${result.message}`);
      if (result.exitCode && result.exitCode > exitCode) exitCode = result.exitCode;
      if (result.stop) break;
    }
    if (this.json) {
      printJson(this.ctx.io, {
        object: 'better_auth_migration',
        dry_run: this.dryRun,
        project: this.project,
        config_dir: this.dir,
        state_file: this.dryRun ? null : this.statePath,
        instance_id: this.state.instance_id,
        steps: STEPS.map((id) => ({ id, ...(this.state.steps[id] ?? { status: 'pending' }) })),
      });
    }
    return exitCode;
  }

  record(step: StepId, result: StepResult): void {
    this.state.steps[step] = {
      status: result.status,
      at: Date.now(),
      ...(result.detail ? { detail: result.detail } : {}),
      ...(result.message ? { message: result.message } : {}),
    };
    this.saveState();
  }
}

// ───────────────────────────── steps ─────────────────────────────

const HANDLERS: Record<StepId, (m: Migration) => Promise<StepResult>> = {
  async preflight(m) {
    const http = m.api();
    const inst = await http.get<{ id?: string; environment?: string; frontend_api_host?: string | null }>('/v1/instance');
    if (m.state.instance_id && inst.id && m.state.instance_id !== inst.id && m.args.values.force !== true) {
      throw new CliError(`This migration was started on instance ${m.state.instance_id}, but the key belongs to ${inst.id}. Use the same key, or --force to start over.`);
    }
    m.state.instance_id = inst.id ?? null;
    m.state.environment = inst.environment ?? null;
    const analysis = analyzeBetterAuth(m.project, m.entry ? { entry: m.entry } : {});
    const baVersion = analysis.dependencies['better-auth'] ?? null;
    let pre = { errors: 0, warnings: 0 };
    try {
      const report = await http.get<{ findings?: Array<{ severity: string }> }>('/v1/instance/preflight');
      const findings = report.findings ?? [];
      pre = { errors: findings.filter((f) => f.severity === 'error').length, warnings: findings.filter((f) => f.severity === 'warning').length };
    } catch {
      /* preflight is advisory here; verify runs it again */
    }
    m.say(`  instance ${inst.id ?? '?'} (${inst.environment ?? 'unknown'}), CLI ${getVersion()}, better-auth ${baVersion ?? 'not in package.json'}`);
    if (inst.environment === 'production') m.say('  note: this is a production instance. Run the whole program on a development instance first.');
    if (!analysis.instances.length) {
      return { status: 'blocked', stop: true, exitCode: 1, message: `No betterAuth({...}) call found under ${m.project}. Pass the app folder, or --entry <file>.` };
    }
    return {
      status: 'done',
      detail: { instance_id: inst.id, environment: inst.environment, frontend_api_host: inst.frontend_api_host ?? null, cli_version: getVersion(), better_auth: baVersion, preflight: pre },
      message: `instance ${inst.id}; preflight ${pre.errors} error(s), ${pre.warnings} warning(s)`,
    };
  },

  async translate(m) {
    const t = m.getTranslation();
    const written = writeTranslation(t, m.dir, m.format);
    for (const line of summaryLines(t, m.dir, written)) m.say(`  ${line}`);
    return {
      status: 'done',
      detail: { files: written, mappings: t.mappings, bridge: t.bridge, env: t.env.map((e) => e.name), secrets: t.secrets },
      message: `${written.length - 2} config file(s) in ${m.dir}; report ${join(m.dir, REPORT_MD)}`,
    };
  },

  async apply(m) {
    const http = m.api();
    const ext = m.format === 'json' ? 'json' : 'yaml';
    const instanceFile = join(m.dir, `instance.${ext}`);
    if (!existsSync(instanceFile)) return { status: 'blocked', stop: true, exitCode: 1, message: `${instanceFile} is missing; re-run with --force to translate again.` };

    // Keep the origins already allowed on the instance: the translation only adds.
    const live = await http.get<{ allowed_origins?: string[]; auth_config?: Json; auth_config_resolved?: Json }>('/v1/instance');
    const desired = deserialize(readFileSync(instanceFile, 'utf8'), m.format) as Record<string, Json>;
    const liveOrigins = Array.isArray(live.allowed_origins) ? live.allowed_origins : [];
    const desiredOrigins = Array.isArray(desired.allowed_origins) ? (desired.allowed_origins as string[]) : [];
    // Compare resolved values (an origin is usually a ${BETTER_AUTH_URL} placeholder);
    // the file keeps the placeholder, the review shows what will be sent.
    const resolvedOrigin = (o: string) => interpolate(o, m.env) as string;
    const addedRaw = desiredOrigins.filter((o, i) => {
      const r = resolvedOrigin(o);
      return !liveOrigins.includes(r) && desiredOrigins.findIndex((p) => resolvedOrigin(p) === r) === i;
    });
    const added = addedRaw.map(resolvedOrigin);
    if (desired.allowed_origins !== undefined) {
      desired.allowed_origins = [...liveOrigins, ...addedRaw];
      if (!m.dryRun) writeFileSync(instanceFile, serialize(desired, m.format));
    }

    const missing = missingPlaceholders(m.dir, m.env);
    const translateDetail = m.state.steps.translate?.detail as { secrets?: Translation['secrets'] } | undefined;
    const secrets = translateDetail?.secrets ?? m.getTranslation().secrets;
    for (const s of secrets) if (!m.env[s.env]) missing.add(s.env);
    if (missing.size && !m.dryRun) {
      return {
        status: 'blocked',
        stop: true,
        exitCode: 1,
        message: `Set ${[...missing].sort().join(', ')} (from your app's environment or a .env file in the project), then run again with --resume. Values are only sent to Atlas, never written to disk.`,
      };
    }

    // The review: a leaf diff of auth_config plus the resource plan.
    const liveConfig = (live.auth_config_resolved ?? live.auth_config ?? {}) as Json;
    // Diff on resolved values, but print the placeholder where the file has one
    // so a resolved secret never reaches the terminal.
    const rawConfig = (desired.auth_config ?? {}) as Json;
    const diff = leafDiff(interpolate(rawConfig, m.env), liveConfig);
    const rawLeaves = new Map(leafDiff(rawConfig, null).map((d) => [d.path, d.to]));
    m.say('  Review:');
    for (const o of added) m.say(`    + allowed_origins ${o}`);
    for (const d of diff) m.say(`    ~ auth_config.${d.path}: ${short(d.from)} -> ${short(rawLeaves.get(d.path) ?? d.to)}`);
    const plan = await planConfigImport(http, { dir: m.dir, format: m.format, env: m.env, prune: false });
    if (!diff.length && !added.length) plan.changes = plan.changes.filter((c) => c.type !== 'instance');
    if (m.json) {
      for (const c of plan.changes) m.say(`    ${c.action} ${c.type}${c.key ? ` ${c.key}` : ''}`);
    } else {
      printPlan(m.ctx, plan.changes, plan.unchanged, plan.skippedDeletes, { dryRun: m.dryRun, prune: false });
    }
    if (missing.size) m.say(`  (dry run) still to set before applying: ${[...missing].sort().join(', ')}`);
    const detail = { changes: plan.changes.map(({ type, action, key }) => ({ type, action, key })), auth_config_changes: diff.length, origins_added: added };
    if (m.dryRun) return { status: 'planned', detail, message: `${plan.changes.length} change(s) would be applied` };
    if (!plan.changes.length && !secrets.length) return { status: 'done', detail, message: 'the instance already matches' };
    if (!(await m.confirm(`Apply ${plan.changes.length} change(s) to instance ${m.state.instance_id ?? ''}?`))) {
      return { status: 'awaiting_confirmation', stop: true, detail, message: 'not applied. Re-run with --resume (and --yes to skip the question).' };
    }
    for (const s of secrets) {
      await http.put('/v1/instance/captcha_secret', { provider: s.provider, secret: m.env[s.env] });
    }
    for (const c of plan.changes) await c.apply();
    return { status: 'done', detail, message: `applied ${plan.changes.length} change(s)` };
  },

  async export(m) {
    const bundle = resolve(m.project, str(m.args.values, 'bundle') ?? join('atlas-migrate', 'better-auth.bundle'));
    if (existsSync(bundle)) return { status: 'done', detail: { bundle }, message: `bundle ${bundle}` };
    const key = m.dryRun ? '<import public key>' : await getImportPublicKey(m.api());
    const cmd = exporterCommand({ out: bundle, publicKey: key });
    if (m.dryRun) return { status: 'planned', detail: { bundle, command: cmd.display }, message: `would run in the app: ${cmd.display}` };
    if (m.args.values['run-export'] === true) {
      m.say(`  running in ${m.project}: ${cmd.display}`);
      const code = await (m.ctx.exec ?? execInherit)(cmd.cmd, cmd.args, { cwd: m.project });
      if (code === 0 && existsSync(bundle)) return { status: 'done', detail: { bundle }, message: `bundle ${bundle}` };
      return { status: 'action_needed', stop: true, exitCode: 1, detail: { bundle, command: cmd.display }, message: `the exporter exited ${code}. Fix it and run: ${cmd.display}; then --resume.` };
    }
    m.say('  Export your Better Auth data. In the app (where its database is reachable), run:');
    m.say(`    ${cmd.display}`);
    m.say('  The bundle is sealed to this instance: only Atlas can open it. Then run this command again with --resume (or pass --run-export to let the CLI run it).');
    return { status: 'action_needed', stop: true, detail: { bundle, command: cmd.display }, message: 'waiting for the export bundle' };
  },

  async import(m) {
    const bundlePath = (m.state.steps.export?.detail?.bundle as string | undefined) ?? resolve(m.project, str(m.args.values, 'bundle') ?? join('atlas-migrate', 'better-auth.bundle'));
    if (!existsSync(bundlePath)) {
      if (m.dryRun) return { status: 'planned', message: 'would upload the export bundle, show its dry run, then import it' };
      return { status: 'blocked', stop: true, exitCode: 1, message: `No bundle at ${bundlePath}; run the export step first.` };
    }
    if (m.dryRun) return { status: 'planned', detail: { bundle: bundlePath }, message: 'would upload the export bundle, show its dry run, then import it' };
    const http = m.api();
    // A resumed run reuses the import it already uploaded (an apply resumes from its cursor).
    const savedId = m.state.steps.import?.detail?.import_id as string | undefined;
    let imp: ImportJob | undefined;
    if (savedId) {
      try {
        imp = await getImport(http, savedId);
        if (imp.status === 'uploading') imp = await finalizeImport(http, imp.id);
      } catch {
        imp = undefined;
      }
    }
    if (!imp || imp.status === 'invalid') {
      const bundle = readFileSync(bundlePath, 'utf8');
      imp = await uploadBundle(http, { bundle, onPart: (n, of) => { if (of > 1) m.say(`  uploaded part ${n}/${of}`); } });
    }
    imp = await waitFor(m, imp);
    const detail = (): Record<string, unknown> => ({ import_id: imp!.id, status: imp!.status, total: imp!.total, succeeded: imp!.progress?.succeeded, failed: imp!.progress?.failed });
    if (imp.status === 'invalid') {
      return { status: 'blocked', stop: true, exitCode: 1, detail: detail(), message: `Atlas could not read the bundle: ${imp.error?.message ?? 'invalid'} (${imp.error?.code ?? 'invalid'}). Export again and re-run with --resume.` };
    }
    if (imp.status === 'completed') return { status: 'done', detail: detail(), message: describeJob(imp) };
    if (imp.status === 'ready') {
      m.say(`  Dry run (import ${imp.id}):`);
      for (const row of imp.report?.models ?? []) m.say(`    ${row.label}: ${row.found} found, ${row.will_create} new, ${row.will_update} existing, ${row.will_skip} skipped`);
      for (const a of imp.report?.action_items ?? []) m.say(`    ${a.severity === 'required' ? 'REQUIRED' : a.severity === 'recommended' ? 'todo' : 'note'}: ${a.message} (${a.count})`);
    }
    const conflicts = imp.report?.conflicts_total ?? 0;
    if (conflicts > 0) {
      m.say(`    conflicts with existing Atlas data: ${conflicts}`);
      for (const c of imp.report?.conflicts.slice(0, 10) ?? []) m.say(`      [${c.resolution}] ${c.model} ${c.row_id ?? ''}: ${c.message}`);
      if (m.args.values['confirm-conflicts'] !== true) {
        return { status: 'action_needed', stop: true, detail: detail(), message: `the dry run found ${conflicts} conflict(s). Review them, then re-run with --resume --confirm-conflicts.` };
      }
    }
    const resuming = imp.status === 'failed';
    if (!(await m.confirm(resuming ? `Resume import ${imp.id} into instance ${m.state.instance_id ?? ''}?` : `Import into instance ${m.state.instance_id ?? ''}?`))) {
      return { status: 'awaiting_confirmation', stop: true, detail: detail(), message: 'not imported. Re-run with --resume (and --yes).' };
    }
    imp = await waitFor(m, await applyImport(http, imp.id, { confirmConflicts: conflicts > 0 }));
    if (imp.status !== 'completed') {
      return { status: 'blocked', stop: true, exitCode: 1, detail: detail(), message: `the import stopped (${imp.error?.message ?? imp.status}). Re-run with --resume to continue where it stopped.` };
    }
    const failed = imp.progress?.failed ?? 0;
    return { status: 'done', detail: detail(), message: describeJob(imp), exitCode: failed ? 2 : 0 };
  },

  async bridge(m) {
    const bridge = ((m.state.steps.translate?.detail?.bridge as Translation['bridge'] | undefined) ?? m.getTranslation().bridge);
    const days = Number(str(m.args.values, 'bridge-days') ?? 30);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new CliError('--bridge-days must be a whole number from 1 to 365.');
    const secretEnv = bridge.secretEnv ?? 'BETTER_AUTH_SECRET';
    const secret = m.env[secretEnv] ?? m.env.AUTH_SECRET;
    if (m.dryRun) return { status: 'planned', message: `would accept Better Auth sessions (${bridge.sessionCookie}) for ${days} day(s)` };
    if (!secret) {
      return { status: 'action_needed', message: `set ${secretEnv} (your Better Auth secret) and run again with --resume to turn the session bridge on; until then users sign in once after the cutover.` };
    }
    if (secret.length < 16) throw new CliError(`${secretEnv} is shorter than 16 characters; the session bridge needs the Better Auth secret your app signs cookies with.`);
    await enableSessionBridge(m.api(), { cookiePrefix: bridge.cookiePrefix, endsAt: Date.now() + days * DAY_MS }, secret);
    return { status: 'done', detail: { cookie: bridge.sessionCookie, days }, message: `Better Auth sessions become Atlas sessions for ${days} day(s)` };
  },

  async code(m) {
    const preview = runMigration(m.project, { from: 'better-auth', write: false });
    for (const line of formatMigration(preview, { written: false })) m.say(`  ${line}`);
    const detail = { files_changed: preview.filesChanged, manual: preview.manual.length, packages: preview.packages };
    if (m.dryRun) return { status: 'planned', detail, message: `${preview.filesChanged} file(s) would be rewritten` };
    if (!preview.filesChanged) return { status: 'done', detail, message: 'no code left to rewrite' };
    if (!(await m.confirm(`Rewrite ${preview.filesChanged} file(s) in ${m.project}? (commit your work first)`))) {
      return { status: 'awaiting_confirmation', stop: true, detail, message: 'code not rewritten. Re-run with --resume (and --yes), or run atlas migrate code --from better-auth yourself.' };
    }
    const result = runMigration(m.project, { from: 'better-auth', write: true });
    return { status: 'done', detail: { ...detail, files_changed: result.filesChanged }, message: `rewrote ${result.filesChanged} file(s); ${result.manual.length} item(s) need a manual look` };
  },

  async verify(m) {
    if (m.dryRun) return { status: 'planned', message: 'would check counts, preflight and print the sign-in checklist' };
    const http = m.api();
    const lines: string[] = [];
    const users = await countOf(http, '/v1/users?limit=1&include_total_count=true');
    const orgs = await countOf(http, '/v1/organizations?limit=1&include_total_count=true');
    const imported = m.state.steps.import?.detail as { succeeded?: number; total?: number } | undefined;
    lines.push(`users on the instance: ${users ?? 'unknown'}${imported?.total !== undefined ? ` (import: ${imported.succeeded ?? 0} of ${imported.total} rows landed)` : ''}`);
    lines.push(`organizations: ${orgs ?? 'unknown'}`);
    let errors = 0;
    try {
      const pre = await http.get<{ findings?: Array<{ severity: string; code: string }> }>('/v1/instance/preflight');
      const findings = pre.findings ?? [];
      errors = findings.filter((f) => f.severity === 'error').length;
      lines.push(`preflight: ${errors} error(s), ${findings.filter((f) => f.severity === 'warning').length} warning(s)${errors ? ` (${findings.filter((f) => f.severity === 'error').map((f) => f.code).join(', ')}; run atlas preflight)` : ''}`);
    } catch {
      lines.push('preflight: could not run (atlas preflight)');
    }
    const host = (m.state.steps.preflight?.detail?.frontend_api_host as string | null | undefined) ?? null;
    const signIn = host ? `https://${host}/hosted/sign-in` : '(your Atlas sign-in page)';
    const providers = Object.values(((m.state.steps.translate?.detail?.mappings as Translation['mappings'] | undefined)?.providers) ?? {});
    lines.push('checklist:');
    lines.push(`  [ ] sign in as an imported password user at ${signIn}`);
    for (const p of [...new Set(providers)]) lines.push(`  [ ] sign in with ${p} at ${signIn} and check it lands on the imported user`);
    lines.push('  [ ] open the app with an old Better Auth session cookie: it should become an Atlas session (bridge)');
    lines.push('  [ ] check organizations, roles and metadata of a few imported users in the dashboard');
    lines.push(`  [ ] work through the manual items in ${join(m.dir, REPORT_MD)}`);
    lines.push('  [ ] after the cutover window: re-run the export/import for late sign-ups, then turn Better Auth off');
    for (const l of lines) m.say(`  ${l}`);
    return { status: 'done', detail: { users, organizations: orgs, preflight_errors: errors, sign_in_url: signIn }, message: errors ? 'preflight reports errors' : 'checks passed', exitCode: errors ? 1 : 0 };
  },
};

// ───────────────────────────── helpers ─────────────────────────────

async function waitFor(m: Migration, job: ImportJob): Promise<ImportJob> {
  let current = job;
  const sleep = m.ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  while (!RESTING_STATUSES.includes(current.status)) {
    await sleep(2000);
    current = await getImport(m.api(), current.id);
  }
  return current;
}

function describeJob(job: ImportJob): string {
  const p = job.progress;
  return `import ${job.id} ${job.status}: ${p?.succeeded ?? 0} of ${p?.total ?? job.total ?? 0} record(s) ok, ${p?.failed ?? 0} issue(s)`;
}

async function countOf(http: ConfigHttp, path: string): Promise<number | null> {
  try {
    const res = await http.get<{ total_count?: number }>(path);
    return typeof res.total_count === 'number' ? res.total_count : null;
  } catch {
    return null;
  }
}

function execInherit(cmd: string, args: string[], opts: { cwd: string }): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', () => resolveExit(127));
    child.on('exit', (code) => resolveExit(code ?? 1));
  });
}

/** The project's .env files, lowest precedence first (values are only ever sent to Atlas). */
function readDotenvs(project: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['.env', '.env.development', '.env.local', '.env.development.local']) {
    Object.assign(out, readEnvFile(join(project, name)) ?? {});
  }
  return out;
}

/** `${NAME}` placeholders in the config files that the environment does not set. */
export function missingPlaceholders(dir: string, env: NodeJS.ProcessEnv): Set<string> {
  const missing = new Set<string>();
  if (!existsSync(dir)) return missing;
  for (const f of readdirSync(dir)) {
    if (!/\.(json|yaml)$/.test(f) || f.startsWith('better-auth-report')) continue;
    const text = readFileSync(join(dir, f), 'utf8');
    for (const match of text.matchAll(/\$\{([A-Z0-9_]+)\}/g)) if (!env[match[1]!]) missing.add(match[1]!);
  }
  return missing;
}

/** Leaves of `desired` that differ from `live` (arrays compare as a whole). */
export function leafDiff(desired: Json, live: Json, prefix = ''): Array<{ path: string; from: Json | undefined; to: Json }> {
  const out: Array<{ path: string; from: Json | undefined; to: Json }> = [];
  if (desired && typeof desired === 'object' && !Array.isArray(desired)) {
    const liveObj = live && typeof live === 'object' && !Array.isArray(live) ? (live as Record<string, Json>) : {};
    for (const [k, v] of Object.entries(desired)) out.push(...leafDiff(v, liveObj[k] as Json, prefix ? `${prefix}.${k}` : k));
    return out;
  }
  if (JSON.stringify(desired) !== JSON.stringify(live)) out.push({ path: prefix, from: live, to: desired });
  return out;
}

function short(v: Json | undefined): string {
  if (v === undefined) return '(unset)';
  const s = JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

export async function migrateBetterAuth(ctx: RunContext, args: ParsedArgs, projectArg: string | undefined): Promise<number> {
  return new Migration(ctx, args, projectArg).run();
}

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { splitBundleParts, type MigrationImport, type MigrationImportKey } from '@atlasauth/backend';
import { MigrationBundleWriter, type MigrationSource } from '@atlasauth/migrate';
import { formatMigration, resolveVendor, runMigration } from '@atlasauth/upgrade';
import { list, str, type ParsedArgs } from '../../args';
import type { ConfigHttp } from '../../config-http';
import type { RunContext } from '../../context';
import { CliError } from '../../errors';
import { printJson } from '../../output';
import { httpFor } from '../../project';
import type { Format, Json } from '../../serialize';
import { getVersion } from '../../version';
import { resolveFormat } from '../../commands/config';
import { resolveAuth, wantsJson } from '../../commands/shared';
import type { CredentialSpec, ExportCursor, MigrationPlugin, PluginContext, TranslationResult } from './plugin';
import { readPluginTranslation, reportMd, translationSummary, writePluginTranslation } from './report';

/**
 * `atlas migrate <vendor> [path]` — the program for any vendor with a
 * {@link MigrationPlugin}, as one resumable run:
 *
 *   preflight → config → export → import → bridge → lazy → code → verify
 *
 * Each finished step is checkpointed in atlas-migrate/<vendor>/state.json, so
 * `--resume` carries on where a run stopped (a confirmation declined, a vendor
 * credential missing, an export interrupted). `--dry-run` walks every step
 * without touching the instance, the vendor or the code; `--yes` answers every
 * confirmation. A single step runs on its own with `atlas migrate <vendor> <step>`.
 *
 * EXPORT RESUME. A sealed bundle cannot be appended to, so an export is written
 * as one or more SEGMENTS (bundle.1.atlas, bundle.2.atlas, …), each a complete
 * bundle. The exporter calls `checkpoint(cursor)` as it goes; when it stops on
 * an error the current segment is sealed with what it holds and the last
 * checkpoint is kept, so the next run starts a new segment from there. Records
 * written after the checkpoint appear in both segments, which is harmless:
 * every import is an idempotent upsert. A hard crash leaves an unsealed
 * segment that is simply rewritten. The import step imports the segments in
 * order (each one's references resolve through the ones applied before it).
 */

export const VENDOR_STEPS = ['preflight', 'config', 'export', 'import', 'bridge', 'lazy', 'code', 'verify'] as const;
export type VendorStepId = (typeof VENDOR_STEPS)[number];

type StepStatus = 'done' | 'skipped' | 'planned' | 'action_needed' | 'awaiting_confirmation' | 'blocked';

interface StepRecord {
  status: StepStatus;
  at?: number;
  detail?: Record<string, unknown>;
  message?: string;
}

export interface VendorMigrationState {
  version: 1;
  vendor: string;
  source: MigrationSource;
  project: string;
  instance_id: string | null;
  environment: string | null;
  started_at: number;
  steps: Partial<Record<VendorStepId, StepRecord>>;
  export: {
    /** Sealed segment files, in order (relative to the state directory). */
    segments: string[];
    /** The exporter's last checkpoint, handed back on resume. */
    cursor: Json | null;
    /** The exporter ran to the end. */
    complete: boolean;
    counts: Record<string, number>;
  };
  import: {
    /** Segments fully imported. */
    done: string[];
    /** The segment being imported and its import id. */
    current: { segment: string; id: string } | null;
    ids: string[];
  };
}

interface StepResult {
  status: StepStatus;
  detail?: Record<string, unknown>;
  message?: string;
  stop?: boolean;
  exitCode?: number;
}

const DAY_MS = 86_400_000;
/** Statuses an import rests in; anything else is still being worked on. */
const RESTING: readonly string[] = ['uploading', 'ready', 'invalid', 'completed', 'failed'];

export class VendorMigration {
  readonly project: string;
  readonly dir: string;
  readonly statePath: string;
  readonly configDir: string;
  readonly format: Format;
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly skip: Set<string>;
  readonly sets: Record<string, string>;
  state: VendorMigrationState;
  private http?: ConfigHttp;
  private translation?: TranslationResult;

  constructor(
    readonly ctx: RunContext,
    readonly args: ParsedArgs,
    readonly plugin: MigrationPlugin,
    projectArg: string | undefined,
  ) {
    const v = args.values;
    this.project = resolve(projectArg ?? process.cwd());
    this.statePath = resolve(this.project, str(v, 'state-file') ?? join('atlas-migrate', plugin.vendor, 'state.json'));
    this.dir = dirname(this.statePath);
    this.configDir = resolve(this.project, str(v, 'dir') ?? join('atlas-migrate', plugin.vendor, 'config'));
    this.format = resolveFormat(v);
    this.yes = v.yes === true;
    this.dryRun = v['dry-run'] === true;
    this.json = wantsJson(v);
    this.skip = new Set(list(v, 'skip'));
    for (const s of this.skip) {
      if (!(VENDOR_STEPS as readonly string[]).includes(s)) throw new CliError(`--skip: unknown step '${s}'. Steps: ${VENDOR_STEPS.join(', ')}.`);
    }
    this.sets = parseSets(Array.isArray(v.set) ? v.set : []);
    this.state = freshState(plugin, this.project);
  }

  say(line: string): void {
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

  sleep(ms: number): Promise<void> {
    return (this.ctx.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);
  }

  /** What a plugin step gets. */
  pluginContext(): PluginContext {
    return {
      ctx: this.ctx,
      args: this.args,
      project: this.project,
      credential: (spec: CredentialSpec) => {
        const name = spec.flag.replace(/^--/, '');
        // --set name=value, then a dedicated flag (--auth0-domain) when the CLI defines one, then the env var.
        const flag = (this.args.values as Record<string, unknown>)[name];
        const value = this.sets[name] ?? (typeof flag === 'string' && flag.trim() ? flag.trim() : undefined) ?? this.ctx.env[spec.env]?.trim();
        if (value) return value;
        if (spec.required) throw new CliError(`${this.plugin.label}: ${spec.label} is needed. Pass --set ${name}=<value> or set ${spec.env}.`);
        return undefined;
      },
      fetch: this.ctx.fetch ?? globalThis.fetch,
      say: (line) => this.say(line),
      dryRun: this.dryRun,
    };
  }

  /** The translation from this run, or the one a previous run wrote. */
  getTranslation(): TranslationResult | undefined {
    this.translation ??= readPluginTranslation(this.plugin, this.configDir);
    return this.translation;
  }

  setTranslation(t: TranslationResult): void {
    this.translation = t;
  }

  loadState(opts: { single: boolean }): void {
    const resume = this.args.values.resume === true;
    const force = this.args.values.force === true;
    if (!existsSync(this.statePath)) {
      if (resume) throw new CliError(`Nothing to resume: ${this.statePath} does not exist. Run without --resume to start.`);
      return;
    }
    if (force && !resume) return;
    // A single step reads the state as it is (export then import, run apart);
    // the whole program refuses to silently continue an earlier run.
    if (!resume && !this.dryRun && !opts.single) {
      throw new CliError(`A migration from ${this.plugin.label} is in progress (${this.statePath}). Pass --resume to continue it, or --force to start over.`);
    }
    try {
      this.state = { ...freshState(this.plugin, this.project), ...(JSON.parse(readFileSync(this.statePath, 'utf8')) as VendorMigrationState) };
    } catch {
      throw new CliError(`${this.statePath} is not a valid state file. Delete it or pass --force.`);
    }
  }

  saveState(): void {
    if (this.dryRun) return;
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2) + '\n');
  }

  record(step: VendorStepId, result: StepResult): void {
    this.state.steps[step] = { status: result.status, at: Date.now(), ...(result.detail ? { detail: result.detail } : {}), ...(result.message ? { message: result.message } : {}) };
    this.saveState();
  }

  /** Run every step (or just `only`). Returns the exit code. */
  async run(only?: VendorStepId): Promise<number> {
    this.loadState({ single: only !== undefined });
    let exitCode = 0;
    for (const step of only ? [only] : VENDOR_STEPS) {
      const prev = this.state.steps[step];
      if (!only && prev && (prev.status === 'done' || prev.status === 'skipped') && step !== 'verify') {
        this.say(`[${step}] already ${prev.status}${prev.message ? `: ${prev.message}` : ''}`);
        continue;
      }
      if (!only && this.skip.has(step)) {
        this.record(step, { status: 'skipped', message: 'skipped with --skip' });
        this.say(`[${step}] skipped (--skip)`);
        continue;
      }
      this.say(`[${step}]`);
      const result = await VENDOR_HANDLERS[step](this);
      this.record(step, result);
      if (result.message) this.say(`[${step}] ${result.status}: ${result.message}`);
      if (result.exitCode && result.exitCode > exitCode) exitCode = result.exitCode;
      if (result.stop) break;
    }
    if (this.json) {
      printJson(this.ctx.io, {
        object: 'vendor_migration',
        vendor: this.plugin.vendor,
        source: this.plugin.source,
        dry_run: this.dryRun,
        project: this.project,
        state_file: this.dryRun ? null : this.statePath,
        instance_id: this.state.instance_id,
        steps: (only ? [only] : VENDOR_STEPS).map((id) => ({ id, ...(this.state.steps[id] ?? { status: 'pending' }) })),
        export: this.state.export,
        import: this.state.import,
      });
    }
    return exitCode;
  }
}

function freshState(plugin: MigrationPlugin, project: string): VendorMigrationState {
  return {
    version: 1,
    vendor: plugin.vendor,
    source: plugin.source,
    project,
    instance_id: null,
    environment: null,
    started_at: Date.now(),
    steps: {},
    export: { segments: [], cursor: null, complete: false, counts: {} },
    import: { done: [], current: null, ids: [] },
  };
}

/** `--set a=b --set c=d,e=f` → { a: 'b', c: 'd', e: 'f' }. A value may contain `=`. */
export function parseSets(raw: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of raw) {
    const i = item.indexOf('=');
    if (i <= 0) throw new CliError(`--set takes name=value, got '${item}'.`);
    out[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  return out;
}

const importsBase = (source: string) => `/v1/migrations/${encodeURIComponent(source)}/imports`;

// ───────────────────────────── steps ─────────────────────────────

export const VENDOR_HANDLERS: Record<VendorStepId, (m: VendorMigration) => Promise<StepResult>> = {
  async preflight(m) {
    const inst = await m.api().get<{ id?: string; environment?: string; frontend_api_host?: string | null }>('/v1/instance');
    if (m.state.instance_id && inst.id && m.state.instance_id !== inst.id && m.args.values.force !== true) {
      throw new CliError(`This migration was started on instance ${m.state.instance_id}, but the key belongs to ${inst.id}. Use the same key, or --force to start over.`);
    }
    m.state.instance_id = inst.id ?? null;
    m.state.environment = inst.environment ?? null;
    m.say(`  instance ${inst.id ?? '?'} (${inst.environment ?? 'unknown'}), CLI ${getVersion()}, from ${m.plugin.label}`);
    if (inst.environment === 'production') m.say('  note: this is a production instance. Run the whole program on a development instance first.');
    const steps = [m.plugin.config && 'config', m.plugin.export && 'export', m.plugin.bridge && 'bridge', m.plugin.lazy && 'lazy', m.plugin.codemod && 'code'].filter(Boolean);
    m.say(`  ${m.plugin.label} supports: ${steps.join(', ') || 'nothing yet'}`);
    for (const limit of m.plugin.export?.limits ?? []) m.say(`  limit: ${limit}`);
    return { status: 'done', detail: { instance_id: inst.id ?? null, environment: inst.environment ?? null, frontend_api_host: inst.frontend_api_host ?? null } };
  },

  async config(m) {
    const config = m.plugin.config;
    if (!config) return { status: 'skipped', message: `${m.plugin.label} has no configuration translator` };
    if (m.dryRun) return { status: 'planned', message: `would read ${config.reads} and write the config files to ${m.configDir}` };
    const t = await config.translate(m.pluginContext());
    m.setTranslation(t);
    const written = writePluginTranslation(m.plugin, t, m.configDir, m.format);
    for (const line of translationSummary(m.plugin, t, m.configDir, written)) m.say(`  ${line}`);
    m.say(`  Review the files, then apply them with: atlas config import --dir ${m.configDir} --dry-run`);
    const manual = t.report.filter((e) => e.status === 'manual').length;
    return { status: 'done', detail: { config_dir: m.configDir, files: written, manual, mappings: t.mappings }, message: `${written.length - 2} config file(s), ${manual} manual item(s) in ${reportMd(m.plugin)}` };
  },

  async export(m) {
    const exporter = m.plugin.export;
    if (!exporter) return { status: 'skipped', message: `${m.plugin.label} has no exporter` };
    if (m.state.export.complete && m.args.values.force !== true) {
      return { status: 'done', detail: { segments: m.state.export.segments, counts: m.state.export.counts }, message: `already exported (${m.state.export.segments.join(', ')})` };
    }
    if (m.dryRun) return { status: 'planned', message: `would read ${exporter.reads} and write a sealed bundle under ${m.dir}` };
    const p = m.pluginContext();
    // Check every required credential before touching the vendor.
    for (const spec of exporter.credentials) p.credential(spec);
    exporter.check?.(p);
    const key = await m.api().get<MigrationImportKey>(`${importsBase(m.plugin.source)}/public_key`);
    if (!key?.kid || !key.public_key) throw new CliError('The instance did not return an import key.');
    m.say(`  sealing to import key ${key.kid} (fingerprint ${key.fingerprint ?? '?'})`);

    const segment = `bundle.${m.state.export.segments.length + 1}.atlas`;
    mkdirSync(m.dir, { recursive: true });
    const fd = openSync(join(m.dir, segment), 'w', 0o600);
    const writer = new MigrationBundleWriter({
      source: m.plugin.source,
      exporter: { name: '@atlasauth/cli', version: getVersion() },
      recipient: { kid: key.kid, publicKey: key.public_key },
      write: (line) => {
        writeSync(fd, `${line}\n`);
      },
    });
    let checkpoint: ExportCursor | null = m.state.export.cursor;
    let failure: unknown = null;
    try {
      await exporter.run(p, writer, {
        cursor: m.state.export.cursor,
        checkpoint: (cursor) => {
          checkpoint = cursor;
        },
      });
    } catch (err) {
      failure = err;
    }
    const summary = await writer.finish().finally(() => closeSync(fd));
    m.state.export.segments.push(segment);
    for (const [model, n] of Object.entries(summary.counts)) m.state.export.counts[model] = (m.state.export.counts[model] ?? 0) + n;
    for (const w of summary.warnings) m.say(`  warning: ${w}`);
    for (const [model, o] of Object.entries(summary.omitted)) m.say(`  left out ${o.count} ${model} row(s): ${o.reason}`);
    const counts = Object.entries(summary.counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'no records';
    if (failure) {
      m.state.export.cursor = checkpoint;
      const message = failure instanceof Error ? failure.message : String(failure);
      return {
        status: 'action_needed',
        stop: true,
        exitCode: 1,
        detail: { segments: m.state.export.segments, cursor: checkpoint },
        message: `the export stopped (${message}); ${segment} holds what was read (${counts}). Fix the cause and run again with --resume to continue from the last checkpoint.`,
      };
    }
    m.state.export.cursor = null;
    m.state.export.complete = true;
    return { status: 'done', detail: { segments: m.state.export.segments, counts: m.state.export.counts }, message: `wrote ${segment} (${counts})` };
  },

  async import(m) {
    const segments = m.state.export.segments.filter((s) => !m.state.import.done.includes(s));
    if (!m.plugin.export) return { status: 'skipped', message: `${m.plugin.label} has no exporter` };
    // A dry run exports nothing, so there are no segments yet: plan, don't stop.
    if (m.dryRun && !m.state.export.complete) return { status: 'planned', message: 'would upload, dry-run and import the exported bundle' };
    if (!m.state.export.segments.length) {
      return { status: 'action_needed', stop: true, exitCode: 1, message: 'nothing exported yet: run the export step first' };
    }
    if (!segments.length) return { status: 'done', detail: { ids: m.state.import.ids }, message: 'every exported segment is imported' };
    if (m.dryRun) return { status: 'planned', message: `would upload, dry-run and import ${segments.join(', ')}` };
    const http = m.api();
    const base = importsBase(m.plugin.source);
    const confirmConflicts = m.args.values['confirm-conflicts'] === true;
    let last: MigrationImport | null = null;
    for (const segment of segments) {
      let job: MigrationImport;
      if (m.state.import.current?.segment === segment) {
        job = await http.get<MigrationImport>(`${base}/${encodeURIComponent(m.state.import.current.id)}`);
        if (job.status === 'uploading') job = await http.post<MigrationImport>(`${base}/${encodeURIComponent(job.id)}/finalize`, {});
      } else {
        const text = readFileSync(join(m.dir, segment), 'utf8');
        const parts = splitBundleParts(text);
        if (!parts.length) throw new CliError(`${segment} is empty. Run the export again with --force.`);
        job = await http.post<MigrationImport>(base, {});
        m.state.import.current = { segment, id: job.id };
        m.state.import.ids.push(job.id);
        m.saveState();
        for (let i = 0; i < parts.length; i++) await http.put(`${base}/${encodeURIComponent(job.id)}/parts/${i + 1}`, { data: parts[i] });
        job = await http.post<MigrationImport>(`${base}/${encodeURIComponent(job.id)}/finalize`, {});
      }
      job = await waitFor(m, job);
      if (job.status === 'invalid') {
        return { status: 'blocked', stop: true, exitCode: 1, detail: { id: job.id }, message: `${segment} was refused: ${job.error?.message ?? 'invalid bundle'}. Export again with --force.` };
      }
      if (job.status === 'ready' || job.status === 'failed') {
        printReport(m, job);
        const conflicts = job.report?.conflicts_total ?? 0;
        if (conflicts > 0 && !confirmConflicts) {
          return { status: 'awaiting_confirmation', stop: true, exitCode: 1, detail: { id: job.id, conflicts }, message: `the dry run found ${conflicts} conflict(s) with existing Atlas users. Review them, then re-run with --resume --confirm-conflicts.` };
        }
        const resuming = job.status === 'failed';
        if (!(await m.confirm(`${resuming ? 'Resume' : 'Apply'} import ${job.id} (${segment}) into instance ${m.state.instance_id ?? ''}?`))) {
          return { status: 'awaiting_confirmation', stop: true, detail: { id: job.id }, message: 'not imported yet. Re-run with --resume (and --yes) to apply.' };
        }
        job = await http.post<MigrationImport>(`${base}/${encodeURIComponent(job.id)}/apply`, conflicts > 0 ? { confirm_conflicts: true } : {});
        job = await waitFor(m, job);
      }
      if (job.status !== 'completed') {
        return { status: 'action_needed', stop: true, exitCode: 1, detail: { id: job.id }, message: `import ${job.id} is ${job.status}${job.error ? ` (${job.error.message})` : ''}. Re-run with --resume to continue it.` };
      }
      m.say(`  ${describeJob(job)}`);
      m.state.import.done.push(segment);
      m.state.import.current = null;
      m.saveState();
      last = job;
    }
    return { status: 'done', detail: { ids: m.state.import.ids, total: last?.total ?? 0, succeeded: last?.progress?.succeeded ?? 0 }, message: `imported ${segments.length} segment(s)` };
  },

  async bridge(m) {
    const bridge = m.plugin.bridge;
    if (!bridge) return { status: 'skipped', message: `${m.plugin.label} has no session bridge` };
    const vars = bridge.vars(m.pluginContext(), m.getTranslation());
    const preset = bridge.presetFor?.(m.pluginContext(), m.getTranslation()) ?? bridge.preset;
    const days = Number(str(m.args.values, 'bridge-days') ?? 30);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new CliError('--bridge-days must be a whole number of days from 1 to 365.');
    const body: Record<string, unknown> = { enabled: true, ends_at: Date.now() + days * DAY_MS, preset, preset_vars: vars };
    if (m.dryRun) return { status: 'planned', detail: { preset, vars }, message: `would accept ${m.plugin.label} sessions for ${days} day(s)` };
    if (!(await m.confirm(`Accept ${m.plugin.label} sessions (preset ${preset}) for ${days} day(s)?`))) {
      return { status: 'awaiting_confirmation', stop: true, message: 'bridge not turned on. Re-run with --resume (and --yes).' };
    }
    const sharedSecret = bridge.sharedSecret?.(m.pluginContext(), preset);
    if (sharedSecret) body.shared_secret = sharedSecret;
    await m.api().put(`/v1/migrations/${encodeURIComponent(m.plugin.source)}/bridge`, body);
    const presetOption = preset === m.plugin.source ? '' : `preset: '${preset}', `;
    m.say(`  add the middleware: migrationBridge({ source: '${m.plugin.source}', ${presetOption}presetVars: ${JSON.stringify(vars)} })`);
    return { status: 'done', detail: { preset, vars, days }, message: `${m.plugin.label} sessions become Atlas sessions for ${days} day(s)` };
  },

  async lazy(m) {
    const lazy = m.plugin.lazy;
    if (!lazy) return { status: 'skipped', message: `${m.plugin.label} has no lazy-migration preset` };
    const p = m.pluginContext();
    const config = lazy.config(p, m.getTranslation());
    if (lazy.optional && !m.getTranslation()?.lazy && !Object.keys(config).length) {
      return { status: 'skipped', message: `not needed: every password ${m.plugin.label} stored is exported (set it up later with atlas migrate ${m.plugin.vendor} lazy if some cannot be verified)` };
    }
    if (lazy.optional && !Object.keys(config).length) {
      return { status: 'action_needed', message: `some passwords may need checking against ${m.plugin.label}: run atlas migrate ${m.plugin.vendor} lazy --set base-url=<your app URL> (see the report for why)` };
    }
    if (m.dryRun) return { status: 'planned', detail: { preset: lazy.preset, config }, message: `would verify passwords against ${m.plugin.label} on first sign-in` };
    const secret = lazy.secret ? p.credential(lazy.secret) : undefined;
    if (!(await m.confirm(`Verify passwords against ${m.plugin.label} on each user's first sign-in (preset ${lazy.preset})?`))) {
      return { status: 'awaiting_confirmation', stop: true, message: 'lazy migration not turned on. Re-run with --resume (and --yes).' };
    }
    await m.api().put('/v1/legacy_auth_connection', { enabled: true, strategy: 'preset', preset: lazy.preset, preset_config: config, ...(secret ? { secret } : {}) });
    return { status: 'done', detail: { preset: lazy.preset, config }, message: `passwords move from ${m.plugin.label} as users sign in` };
  },

  async code(m) {
    const from = m.plugin.codemod ? resolveVendor(m.plugin.codemod) : undefined;
    if (!from) return { status: 'skipped', message: `no codemod for ${m.plugin.label}` };
    const preview = runMigration(m.project, { from, write: false });
    for (const line of formatMigration(preview, { written: false })) m.say(`  ${line}`);
    const detail = { files_changed: preview.filesChanged, manual: preview.manual.length };
    if (m.dryRun) return { status: 'planned', detail, message: `${preview.filesChanged} file(s) would be rewritten` };
    if (!preview.filesChanged) return { status: 'done', detail, message: 'no code left to rewrite' };
    if (!(await m.confirm(`Rewrite ${preview.filesChanged} file(s) in ${m.project}? (commit your work first)`))) {
      return { status: 'awaiting_confirmation', stop: true, detail, message: `code not rewritten. Re-run with --resume (and --yes), or run atlas migrate code --from ${from} yourself.` };
    }
    const result = runMigration(m.project, { from, write: true });
    return { status: 'done', detail: { ...detail, files_changed: result.filesChanged }, message: `rewrote ${result.filesChanged} file(s); ${result.manual.length} item(s) need a manual look` };
  },

  async verify(m) {
    if (m.dryRun) return { status: 'planned', message: 'would check the imports and print the checklist' };
    const lines: string[] = [];
    let failed = 0;
    for (const id of m.state.import.ids) {
      try {
        const job = await m.api().get<MigrationImport>(`${importsBase(m.plugin.source)}/${encodeURIComponent(id)}`);
        if (job.status !== 'completed') failed += 1;
        lines.push(describeJob(job));
      } catch {
        lines.push(`import ${id}: could not be read`);
        failed += 1;
      }
    }
    const host = (m.state.steps.preflight?.detail?.frontend_api_host as string | null | undefined) ?? null;
    const signIn = host ? `https://${host}/hosted/sign-in` : '(your Atlas sign-in page)';
    lines.push('checklist:');
    lines.push(`  [ ] sign in as an imported user at ${signIn}`);
    for (const p of [...new Set(Object.values(m.getTranslation()?.mappings.providers ?? {}))]) lines.push(`  [ ] sign in with ${p} and check it lands on the imported user`);
    if (m.plugin.bridge) lines.push(`  [ ] open the app with an old ${m.plugin.label} session: it should become an Atlas session (bridge)`);
    if (m.plugin.lazy) lines.push(`  [ ] sign in with a password that was never exported: it is checked against ${m.plugin.label} once, then moves`);
    if (m.plugin.config) lines.push(`  [ ] work through the manual items in ${join(m.configDir, reportMd(m.plugin))}`);
    lines.push(`  [ ] after the cutover window: export/import again for late sign-ups, then turn ${m.plugin.label} off`);
    for (const l of lines) m.say(`  ${l}`);
    return { status: 'done', detail: { imports: m.state.import.ids.length, failed, sign_in_url: signIn }, message: failed ? `${failed} import(s) did not complete` : 'checks passed', exitCode: failed ? 1 : 0 };
  },
};

// ───────────────────────────── helpers ─────────────────────────────

async function waitFor(m: VendorMigration, job: MigrationImport): Promise<MigrationImport> {
  let current = job;
  const base = importsBase(m.plugin.source);
  while (!RESTING.includes(current.status)) {
    await m.sleep(2000);
    current = await m.api().get<MigrationImport>(`${base}/${encodeURIComponent(current.id)}`);
  }
  return current;
}

function describeJob(job: MigrationImport): string {
  const p = job.progress;
  return `import ${job.id} ${job.status}: ${p?.succeeded ?? 0} of ${p?.total ?? job.total ?? 0} record(s) ok, ${p?.failed ?? 0} issue(s)`;
}

function printReport(m: VendorMigration, job: MigrationImport): void {
  const r = job.report;
  if (!r) return;
  m.say('  dry run (nothing imported yet):');
  for (const row of r.models ?? []) {
    m.say(`    ${row.label.padEnd(36)} ${String(row.found).padStart(6)} found ${String(row.will_create).padStart(6)} new ${String(row.will_update).padStart(6)} existing ${String(row.will_skip).padStart(6)} skipped`);
  }
  for (const [alg, n] of Object.entries(r.password_algorithms ?? {})) m.say(`    passwords ${alg}: ${n}`);
  for (const a of r.action_items ?? []) m.say(`    ${a.severity === 'required' ? 'REQUIRED' : a.severity === 'recommended' ? 'todo' : 'note'}: ${a.message} (${a.count})`);
  for (const w of r.warnings ?? []) m.say(`    warning: ${w}`);
}

export async function migrateVendor(ctx: RunContext, args: ParsedArgs, plugin: MigrationPlugin, projectArg: string | undefined, only?: VendorStepId): Promise<number> {
  return new VendorMigration(ctx, args, plugin, projectArg).run(only);
}

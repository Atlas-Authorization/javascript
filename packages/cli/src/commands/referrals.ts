import { randomBytes } from 'node:crypto';
import { AtlasApiError } from '@atlasauth/backend';
import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson, renderTable, type Column } from '../output';
import { httpFor } from '../project';
import { deliverSecret } from '../secrets';
import { instanceCredential } from './project-commands';
import { wantsJson } from './shared';

/**
 * `atlas referrals connect | backfill | status`: referral attribution from the
 * terminal.
 *
 * `connect --provider referally` is bring-your-own-key: the Referally merchant
 * key is used for one call (it creates the Atlas connection on Referally) and
 * is never stored or printed. The connection id and secret Referally returns
 * go straight onto the instance; the secret is never printed either.
 */

/** The Referally API version pinned on every call. */
export const REFERALLY_VERSION = '2026-10-21';

const PROVIDERS = ['referally', 'webhook'] as const;

interface ReferralSettingsRead {
  enabled: boolean;
  provider: string;
  endpoint_url: string | null;
  program_id: string | null;
  connection_id: string | null;
  signing_secret_set: boolean;
  tracking_token?: string | null;
  auto_enroll_users?: boolean;
  forward_lifecycle?: boolean;
  missing?: string[];
  connection?: {
    last_test?: { ok: boolean; at: number; http_status: number | null; error: string | null } | null;
    failed_calls_7d?: number;
    retrying_calls?: number;
    last_success_at?: number | null;
    alert?: { code: string; message?: string | null } | null;
  } | null;
}

interface PingRead {
  ok?: boolean;
  org_name?: string | null;
  program_name?: string | null;
  program_id?: string | null;
  auto_enroll_users?: boolean | null;
  server_time?: string | number | null;
  clock_skew_ms?: number | null;
}

interface TestRead {
  ok: boolean;
  http_status?: number | null;
  latency_ms?: number | null;
  error?: { code: string; message: string } | null;
  ping?: PingRead | null;
}

interface BackfillJob {
  id: string;
  status: string;
  users_scanned?: number | null;
  users_skipped?: number | null;
  calls_queued?: number | null;
  truncated?: boolean;
  next_since?: number | null;
  calls?: { pending: number; succeeded: number; failed: number; skipped: number; held: number } | null;
  error?: string | null;
}

interface PreflightFinding {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  fix: string;
}

/** Read a key from a file, or stdin with '-'. A bare key or a dotenv line. Never printed. */
function readKeyFile(ctx: RunContext, file: string, what: string): string {
  let text: string;
  try {
    text = ctx.readFile(file === '-' ? '/dev/stdin' : file);
  } catch {
    throw new CliError(`Could not read ${what} from ${file === '-' ? 'stdin' : file}.`);
  }
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '';
  const m = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(line);
  const key = (m ? m[1]! : line).trim().replace(/^"(.*)"$/, '$1');
  if (!key || /\s/.test(key)) throw new CliError(`No ${what} found in ${file === '-' ? 'stdin' : file}.`);
  return key;
}

function httpsUrl(raw: string, flag: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CliError(`${flag} must be an absolute URL, got '${raw}'.`);
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.endsWith('.localhost');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new CliError(`${flag} must use https (http only for localhost), got '${raw}'.`);
  }
  return raw.replace(/\/+$/, '');
}

/** Platform clock minus ours, in ms, from a ping. */
export function pingSkewMs(ping: PingRead, receivedAt: number, latencyMs?: number | null): number | null {
  if (typeof ping.clock_skew_ms === 'number') return ping.clock_skew_ms;
  if (ping.server_time === undefined || ping.server_time === null) return null;
  const server = typeof ping.server_time === 'number' ? ping.server_time : Date.parse(ping.server_time);
  if (!Number.isFinite(server)) return null;
  return Math.round(server - (receivedAt - (latencyMs ?? 0) / 2));
}

/** Lines describing a connection test (a ping where the provider supports it). */
export function describeTestLines(test: TestRead, receivedAt: number): string[] {
  const lines: string[] = [];
  const meta = [test.http_status ? `HTTP ${test.http_status}` : '', typeof test.latency_ms === 'number' ? `${Math.round(test.latency_ms)} ms` : '']
    .filter(Boolean)
    .join(', ');
  lines.push(test.ok ? `Connection OK${meta ? ` (${meta})` : ''}.` : `Connection test failed${meta ? ` (${meta})` : ''}: ${test.error?.message ?? 'no answer'}.`);
  const ping = test.ping;
  if (ping) {
    if (ping.org_name) lines.push(`  Organization:       ${ping.org_name}`);
    const program = ping.program_name && ping.program_id ? `${ping.program_name} (${ping.program_id})` : (ping.program_name ?? ping.program_id);
    if (program) lines.push(`  Program:            ${program}`);
    if (typeof ping.auto_enroll_users === 'boolean') lines.push(`  Auto-enroll users:  ${ping.auto_enroll_users ? 'on' : 'off'}`);
    const skew = pingSkewMs(ping, receivedAt, test.latency_ms);
    if (skew !== null) {
      lines.push(`  Clock skew:         ${(skew / 1000).toFixed(1)} s`);
      if (Math.abs(skew) > 60_000) {
        lines.push('  Warning: the clocks differ by more than 60 seconds. Signed calls fail beyond 5 minutes.');
      }
    }
  }
  return lines;
}

/** A `customerRef,code` CSV → map; throws on a bad line. A header row is skipped. */
export function parseCodeCsv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const l = line.trim();
    if (!l || l.startsWith('#')) return;
    const [ref, code] = l.split(/[;,\t]/).map((x) => x.trim().replace(/^"(.*)"$/, '$1'));
    if (i === 0 && /^(customer_?ref|user_?id|external_?id|user)$/i.test(ref ?? '')) return;
    if (!ref || !code) throw new CliError(`--map line ${i + 1}: expected customerRef,code.`);
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(code)) throw new CliError(`--map line ${i + 1}: '${code}' is not a valid code.`);
    out[ref] = code;
  });
  return out;
}

async function referallyCreateConnection(
  ctx: RunContext,
  input: { baseUrl: string; key: string; body: Record<string, unknown> },
): Promise<{ id: string; secret: string; trackingToken?: string | null } & Record<string, unknown>> {
  const fetchImpl = ctx.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${input.baseUrl}/v1/auth/connections`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.key}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'referally-version': REFERALLY_VERSION,
      },
      body: JSON.stringify(input.body),
    });
  } catch (err) {
    throw new CliError(`Could not reach Referally at ${input.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const err = (json.error ?? json.errors) as unknown;
    const msg =
      (typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : null) ??
      (Array.isArray(err) && err[0] && typeof err[0] === 'object' && 'message' in err[0] ? String(err[0].message) : null) ??
      (typeof json.message === 'string' ? json.message : null);
    const hint = res.status === 401 || res.status === 403 ? ' Check the merchant key.' : '';
    throw new CliError(`Referally refused to create the connection (HTTP ${res.status})${msg ? `: ${msg}` : ''}.${hint}`);
  }
  if (typeof json.id !== 'string' || typeof json.secret !== 'string') {
    throw new CliError('Referally answered without a connection id and secret.');
  }
  return json as { id: string; secret: string; trackingToken?: string | null };
}

async function connect(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const v = args.values;
  const json = wantsJson(v);
  const provider = str(v, 'provider') ?? 'referally';
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new CliError(`--provider must be one of ${PROVIDERS.join(', ')}, got '${provider}'.`);
  }
  const cred = instanceCredential(ctx, args);
  const http = httpFor(ctx, cred);
  const product = str(v, 'product') ?? 'atlasauth';
  const out = json ? { out: () => undefined, err: ctx.io.err } : ctx.io;

  let patch: Record<string, unknown>;
  let summary: Record<string, unknown>;

  if (provider === 'referally') {
    const program = str(v, 'program');
    if (!program) throw new CliError('referrals connect --provider referally needs --program <prg_…>.');
    const baseRaw = str(v, 'base-url') ?? ctx.env.REFERALLY_BASE_URL?.trim();
    if (!baseRaw) throw new CliError('Pass --base-url <your Referally base URL> (or set REFERALLY_BASE_URL).');
    const baseUrl = httpsUrl(baseRaw, '--base-url');
    const keyFile = str(v, 'referally-key-file');
    const key = str(v, 'referally-key') ?? (keyFile ? readKeyFile(ctx, keyFile, 'the Referally key') : ctx.env.REFERALLY_API_KEY?.trim());
    if (!key) {
      throw new CliError('Pass your Referally merchant key with --referally-key-file <path|-> (or --referally-key, or REFERALLY_API_KEY). It is used once and never stored.');
    }
    const destination = str(v, 'destination');
    if (destination) httpsUrl(destination, '--destination');

    const instance = await http.get<{ id: string; environment?: string }>('/v1/instance');
    const created = await referallyCreateConnection(ctx, {
      baseUrl,
      key,
      body: {
        provider: 'atlas',
        instanceId: instance.id,
        programId: program,
        ...(v['auto-enroll'] === true ? { autoEnrollUsers: true } : {}),
        ...(destination ? { destinationUrl: destination } : {}),
      },
    });
    const trackingToken = str(v, 'tracking-token') ?? (typeof created.trackingToken === 'string' ? created.trackingToken : null);
    patch = {
      provider: 'referally',
      endpoint_url: baseUrl,
      connection_id: created.id,
      signing_secret: created.secret,
      program_id: program,
      ...(v['auto-enroll'] === true ? { auto_enroll_users: true } : {}),
      ...(trackingToken ? { tracking_token: trackingToken } : {}),
    };
    try {
      await http.patch('/v1/instance/referrals', patch);
    } catch (err) {
      // The secret is shown once by Referally: keep it so the merchant can finish by hand.
      const saved = deliverSecret({
        io: out,
        env: ctx.env,
        product,
        fileName: `referally-connection-${created.id}.env`,
        entries: { REFERALLY_CONNECTION_ID: created.id, REFERALLY_CONNECTION_SECRET: created.secret },
        label: 'The Referally connection secret (not saved on Atlas)',
        force: v.force === true,
        comment: `Referally connection ${created.id}: saving it on the Atlas instance failed. Paste it in Users → Referrals.`,
      });
      ctx.io.err(`atlas: the connection ${created.id} was created on Referally, but saving it on the instance failed.${saved.path ? ` Its secret is in ${saved.path}.` : ''}`);
      throw err;
    }
    summary = { provider: 'referally', instance_id: instance.id, endpoint_url: baseUrl, connection_id: created.id, program_id: program, tracking_token: trackingToken };
    if (!json) out.out(`Created Referally connection ${created.id} for instance ${instance.id} and saved it (the secret was not printed).`);
  } else {
    const endpoint = str(v, 'endpoint');
    if (!endpoint) throw new CliError('referrals connect --provider webhook needs --endpoint <https-url>.');
    const endpointUrl = httpsUrl(endpoint, '--endpoint');
    const secretFile = str(v, 'secret-file');
    let secret: string;
    let generated = false;
    if (secretFile) secret = readKeyFile(ctx, secretFile, 'the signing secret');
    else {
      secret = `rfs_${randomBytes(32).toString('base64url')}`;
      generated = true;
    }
    if (secret.length < 16) throw new CliError('The signing secret must be at least 16 characters.');
    patch = {
      provider: 'webhook',
      endpoint_url: endpointUrl,
      signing_secret: secret,
      ...(str(v, 'program') ? { program_id: str(v, 'program') } : {}),
      ...(v['auto-enroll'] === true ? { auto_enroll_users: true } : {}),
    };
    await http.patch('/v1/instance/referrals', patch);
    let secretPath: string | undefined;
    if (generated) {
      secretPath = deliverSecret({
        io: out,
        env: ctx.env,
        product,
        fileName: 'referrals-signing-secret.env',
        entries: { ATLAS_REFERRALS_SIGNING_SECRET: secret },
        label: 'The signing secret (configure it on your referral platform)',
        printSecret: v['print-secret'] === true,
        force: v.force === true,
        comment: `Signing secret for Atlas referral calls to ${endpointUrl}.`,
      }).path;
    }
    summary = { provider: 'webhook', endpoint_url: endpointUrl, secret_file: secretPath ?? null };
    if (!json) out.out(`Saved the referral protocol connection to ${endpointUrl}.`);
  }

  const test = await http.post<TestRead>('/v1/instance/referrals/test', {});
  const receivedAt = Date.now();
  let enabled = false;
  if (v.enable === true) {
    if (!test.ok) {
      ctx.io.err('atlas: not turning referrals on: the connection test failed.');
    } else {
      await http.patch('/v1/instance/referrals', { enabled: true });
      enabled = true;
    }
  }
  if (json) {
    printJson(ctx.io, { ...summary, test, enabled });
  } else {
    for (const line of describeTestLines(test, receivedAt)) ctx.io.out(line);
    ctx.io.out(
      enabled
        ? 'Referral attribution is on.'
        : v.enable === true
          ? 'Referral attribution stays off until the test passes.'
          : "Turn it on with 'atlas referrals connect … --enable', or in the dashboard (Users → Referrals).",
    );
  }
  return test.ok ? 0 : 1;
}

async function backfill(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const v = args.values;
  const since = str(v, 'since');
  if (!since || !/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(since) || Number.isNaN(Date.parse(since))) {
    throw new CliError('referrals backfill needs --since <YYYY-MM-DD>.');
  }
  const mapFile = str(v, 'map');
  let codes: Record<string, string> | undefined;
  if (mapFile) {
    let text: string;
    try {
      text = ctx.readFile(mapFile === '-' ? '/dev/stdin' : mapFile);
    } catch {
      throw new CliError(`Could not read ${mapFile}.`);
    }
    codes = parseCodeCsv(text);
  }
  const metadataPath = str(v, 'metadata-path');
  if (metadataPath && !/^(public|private|unsafe)_metadata(\.[A-Za-z0-9_-]{1,64}){1,4}$/.test(metadataPath)) {
    throw new CliError(`--metadata-path must look like public_metadata.referral_code, got '${metadataPath}'.`);
  }
  const http = httpFor(ctx, instanceCredential(ctx, args));
  let job = await http.post<BackfillJob>('/v1/instance/referrals/backfill', {
    since,
    ...(codes && Object.keys(codes).length ? { codes } : {}),
    ...(metadataPath ? { code_metadata_path: metadataPath } : {}),
  });
  const running = (s: string) => s === 'queued' || s === 'running' || s === 'pending';
  if (v.wait === true) {
    const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    while (running(job.status)) {
      await sleep(2000);
      job = await http.get<BackfillJob>(`/v1/instance/referrals/backfill/${encodeURIComponent(job.id)}`);
    }
  }
  if (wantsJson(v)) printJson(ctx.io, job);
  else {
    const counts = [
      typeof job.users_scanned === 'number' ? `${job.users_scanned} users` : '',
      typeof job.calls_queued === 'number' ? `${job.calls_queued} calls queued` : '',
      typeof job.users_skipped === 'number' ? `${job.users_skipped} skipped` : '',
      job.calls ? `${job.calls.succeeded} sent, ${job.calls.failed} failed` : '',
    ].filter(Boolean);
    ctx.io.out(`Backfill ${job.id}: ${job.status}${counts.length ? ` (${counts.join(', ')})` : ''}.`);
    if (codes) ctx.io.out(`${Object.keys(codes).length} code(s) read from ${mapFile}.`);
    if (running(job.status) && v.wait !== true) ctx.io.out("Add --wait to follow it, or watch the delivery log in the dashboard.");
    if (job.truncated && job.next_since) {
      ctx.io.out(`Stopped at the cap. Run it again with --since ${new Date(job.next_since).toISOString().slice(0, 10)} for the rest.`);
    }
    if (job.error) ctx.io.err(`atlas: ${job.error}`);
  }
  return job.status === 'failed' || (job.calls?.failed ?? 0) > 0 ? 1 : 0;
}

const FINDING_COLUMNS: Column<PreflightFinding>[] = [
  { header: 'SEVERITY', get: (f) => f.severity },
  { header: 'CODE', get: (f) => f.code },
  { header: 'MESSAGE', get: (f) => f.message },
];

async function status(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const http = httpFor(ctx, instanceCredential(ctx, args));
  const settings = await http.get<ReferralSettingsRead>('/v1/instance/referrals');
  let findings: PreflightFinding[] = [];
  try {
    const report = await http.get<{ findings?: PreflightFinding[] }>('/v1/instance/preflight');
    findings = (report.findings ?? []).filter((f) => f.code.startsWith('referral'));
  } catch (err) {
    if (!(err instanceof AtlasApiError)) throw err;
  }
  if (wantsJson(args.values)) {
    printJson(ctx.io, { settings, findings });
    return findings.some((f) => f.severity === 'error') ? 1 : 0;
  }
  const c = settings.connection ?? null;
  const lines = [
    `Referral attribution: ${settings.enabled ? 'on' : 'off'}`,
    `Provider:             ${settings.provider}`,
    `Endpoint:             ${settings.endpoint_url ?? '(not set)'}`,
    `Connection ID:        ${settings.connection_id ?? '(not set)'}`,
    `Program ID:           ${settings.program_id ?? '(not set)'}`,
    `Signing secret:       ${settings.signing_secret_set ? 'set' : 'not set'}`,
  ];
  if (settings.forward_lifecycle !== undefined) lines.push(`Forward lifecycle:    ${settings.forward_lifecycle ? 'on' : 'off'}`);
  if (settings.missing?.length) lines.push(`Missing:              ${settings.missing.join(', ')}`);
  if (c?.last_test) {
    lines.push(`Last test:            ${c.last_test.ok ? 'ok' : `failed${c.last_test.error ? ` (${c.last_test.error})` : ''}`} at ${new Date(c.last_test.at).toISOString()}`);
  }
  if (c) lines.push(`Failed (7 days):      ${c.failed_calls_7d ?? 0}    Retrying: ${c.retrying_calls ?? 0}`);
  for (const l of lines) ctx.io.out(l);
  if (c?.alert) ctx.io.out(`Alert:                ${c.alert.code}${c.alert.message ? `: ${c.alert.message}` : ''}`);
  ctx.io.out('');
  if (findings.length === 0) ctx.io.out('No referral findings in preflight.');
  else {
    ctx.io.out(renderTable(FINDING_COLUMNS, findings));
    for (const f of findings.filter((x) => x.severity !== 'info')) ctx.io.out(`${f.code}: ${f.fix}`);
  }
  return findings.some((f) => f.severity === 'error') ? 1 : 0;
}

export async function referrals(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  switch (sub) {
    case 'connect':
      return connect(ctx, args);
    case 'backfill':
      return backfill(ctx, args);
    case 'status':
      return status(ctx, args);
    default:
      throw new CliError(
        sub
          ? `Unknown subcommand 'referrals ${sub}'. Try: connect, backfill, status.`
          : 'referrals needs a subcommand: connect, backfill, status.',
      );
  }
}

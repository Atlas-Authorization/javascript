import { randomBytes } from 'node:crypto';
import { formatReport, runConformance } from '@atlasauth/referral-conformance';
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
 * `connect --provider referalli` is bring-your-own-key: the Referalli merchant
 * key is used for one call (it creates the Atlas connection on Referalli) and
 * is never stored or printed. The connection id and secret Referalli returns
 * go straight onto the instance; the secret is never printed either.
 */

/** The Referalli API version pinned on every call. */
export const REFERALLI_VERSION = '2026-10-21';

const PROVIDERS = ['referalli', 'webhook'] as const;

/** The retired spelling of the Referalli provider id, flags and environment names, still accepted. */
const LEGACY = {
  provider: 'referally',
  keyFlag: 'referally-key',
  keyFileFlag: 'referally-key-file',
  baseUrlEnv: 'REFERALLY_BASE_URL',
  apiKeyEnv: 'REFERALLY_API_KEY',
} as const;

/** Print a one-line notice that an old name was used (stderr, so --json output stays clean). */
function legacyNotice(ctx: RunContext, old: string, current: string): void {
  ctx.io.err(`atlas: '${old}' is the old name of '${current}'. It still works; use '${current}'.`);
}

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
  updated_at?: number | null;
  connection?: {
    last_test?: { ok: boolean; at: number; http_status: number | null; error: string | null } | null;
    failed_calls_7d?: number;
    retrying_calls?: number;
    last_success_at?: number | null;
    alert?: { code: string; message?: string | null } | null;
  } | null;
  inbound?: {
    url: string | null;
    secret_set: boolean;
    endpoint_id: string | null;
    last_event: { at: number; type: string; outcome: string } | null;
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

/** One call to the Referalli merchant API with the merchant key. Throws a CliError naming `what` on failure. */
async function referalliRequest(
  ctx: RunContext,
  input: { baseUrl: string; key: string; method: 'GET' | 'POST' | 'PATCH'; path: string; body?: Record<string, unknown>; what: string },
): Promise<Record<string, unknown>> {
  const fetchImpl = ctx.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${input.baseUrl}${input.path}`, {
      method: input.method,
      headers: {
        authorization: `Bearer ${input.key}`,
        accept: 'application/json',
        'referalli-version': REFERALLI_VERSION,
        ...(input.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    });
  } catch (err) {
    throw new CliError(`Could not reach Referalli at ${input.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
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
    throw new CliError(`Referalli refused to ${input.what} (HTTP ${res.status})${msg ? `: ${msg}` : ''}.${hint}`);
  }
  return json;
}

async function referalliCreateConnection(
  ctx: RunContext,
  input: { baseUrl: string; key: string; body: Record<string, unknown> },
): Promise<{ id: string; secret: string; trackingToken?: string | null } & Record<string, unknown>> {
  const json = await referalliRequest(ctx, { ...input, method: 'POST', path: '/v1/auth/connections', what: 'create the connection' });
  if (typeof json.id !== 'string' || typeof json.secret !== 'string') {
    throw new CliError('Referalli answered without a connection id and secret.');
  }
  return json as { id: string; secret: string; trackingToken?: string | null };
}

/** The Referalli topics two-way sync subscribes to (changes to a referral after sign-up). */
export const REFERALLI_SYNC_TOPICS = [
  'referral.created',
  'referral.held',
  'referral.paused',
  'referral.resumed',
  'referral.approved',
  'referral.voided',
  'referral.reassigned',
] as const;

/**
 * Whether the merchant key reaches live or test data: the org's `livemode`,
 * else the key prefix (rk_test_ = test; rk_live_ and older rk_ keys = live).
 * `known` is false when Referalli reports no mode (no test mode there).
 */
export async function referalliKeyMode(
  ctx: RunContext,
  input: { baseUrl: string; key: string },
): Promise<{ live: boolean; known: boolean }> {
  try {
    const org = await referalliRequest(ctx, { ...input, method: 'GET', path: '/v1/org', what: 'read the organization' });
    if (typeof org.livemode === 'boolean') return { live: org.livemode, known: true };
  } catch {
    /* fall back to the key prefix */
  }
  if (input.key.startsWith('rk_test_')) return { live: false, known: true };
  if (input.key.startsWith('rk_live_')) return { live: true, known: true };
  return { live: true, known: false };
}

/**
 * `connect --provider referalli --oauth`: Atlas starts an OAuth install at
 * Referalli. The merchant opens the printed link, picks an organization and
 * program, and Referalli returns the connection secret to Atlas directly. The
 * command waits until the instance shows the new connection, then pings it.
 */
async function connectWithOAuth(
  ctx: RunContext,
  args: ParsedArgs,
  io: { http: ReturnType<typeof httpFor>; json: boolean; out: { out: (s: string) => void }; presetId: string },
): Promise<number> {
  const v = args.values;
  const { http, json, out, presetId } = io;
  const before = await http.get<ReferralSettingsRead>('/v1/instance/referrals');
  let started: { authorize_url: string; expires_at: number };
  try {
    started = await http.post<{ authorize_url: string; expires_at: number }>(`/v1/instance/referrals/${encodeURIComponent(presetId)}/install`, {});
  } catch (err) {
    if (err instanceof AtlasApiError && err.status === 422) {
      throw new CliError(
        `One-click connect to '${presetId}' is not available on this Atlas. Connect with a key or the signing secret instead (atlas referrals connect --provider referalli --program <prg_…> --base-url <url> --referalli-key-file <path>, or --provider webhook --endpoint <url>).`,
      );
    }
    throw err;
  }
  if (json) ctx.io.err(`atlas: open ${started.authorize_url}`);
  else {
    out.out('Open this link, choose your Referalli organization and program, and approve:');
    out.out('');
    out.out(`  ${started.authorize_url}`);
    out.out('');
    out.out('Waiting for Referalli to finish (the link is valid for 15 minutes)…');
  }
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = () => Date.now();
  let after = before;
  const changed = (s: ReferralSettingsRead) =>
    s.signing_secret_set && (s.provider !== before.provider || s.connection_id !== before.connection_id || s.endpoint_url !== before.endpoint_url || s.updated_at !== before.updated_at);
  while (!changed(after)) {
    if (now() > started.expires_at) throw new CliError('The link expired before Referalli finished. Run the command again.');
    await sleep(2000);
    after = await http.get<ReferralSettingsRead>('/v1/instance/referrals');
  }
  const test = await http.post<TestRead>('/v1/instance/referrals/test', {});
  const receivedAt = Date.now();
  let enabled = false;
  if (v.enable === true) {
    if (!test.ok) ctx.io.err('atlas: not turning referrals on: the connection test failed.');
    else {
      await http.patch('/v1/instance/referrals', { enabled: true });
      enabled = true;
    }
  }
  if (json) {
    printJson(ctx.io, { provider: after.provider, preset: presetId, connection_id: after.connection_id, program_id: after.program_id, test, enabled });
  } else {
    out.out(`Connected to ${presetId} (${after.connection_id ? `connection ${after.connection_id}` : (after.endpoint_url ?? 'endpoint set')}${after.program_id ? `, program ${after.program_id}` : ''}). No secret was shown or copied.`);
    for (const line of describeTestLines(test, receivedAt)) ctx.io.out(line);
    ctx.io.out(
      enabled
        ? 'Referral attribution is on.'
        : v.enable === true
          ? 'Referral attribution stays off until the test passes.'
          : "Turn it on with 'atlas referrals connect --provider referalli --oauth --enable', or in the dashboard (Users → Referrals).",
    );
  }
  return test.ok ? 0 : 1;
}

async function connect(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const v = args.values;
  const json = wantsJson(v);
  let provider = str(v, 'provider') ?? 'referalli';
  if (provider === LEGACY.provider) {
    legacyNotice(ctx, '--provider referally', '--provider referalli');
    provider = 'referalli';
  }
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new CliError(`--provider must be one of ${PROVIDERS.join(', ')}, got '${provider}'.`);
  }
  const cred = instanceCredential(ctx, args);
  const http = httpFor(ctx, cred);
  // One-click: the platform asks the merchant for the organization and program and hands Atlas the secret.
  // Any platform the deployment offers works (--preset <id>); Referalli is the default preset.
  if (v.oauth === true) {
    const presetId = str(v, 'preset') ?? (provider === 'webhook' ? null : 'referalli');
    if (!presetId) throw new CliError('referrals connect --provider webhook --oauth needs --preset <id> (see one_click_presets in `atlas referrals status --json`).');
    return connectWithOAuth(ctx, args, { http, json, out: json ? { out: () => undefined } : ctx.io, presetId });
  }
  const product = str(v, 'product') ?? 'atlasauth';
  const out = json ? { out: () => undefined, err: ctx.io.err } : ctx.io;

  let patch: Record<string, unknown>;
  let summary: Record<string, unknown>;

  if (provider === 'referalli') {
    const program = str(v, 'program');
    if (!program) throw new CliError('referrals connect --provider referalli needs --program <prg_…>.');
    const legacyBase = ctx.env[LEGACY.baseUrlEnv]?.trim();
    if (!ctx.env.REFERALLI_BASE_URL?.trim() && legacyBase) legacyNotice(ctx, LEGACY.baseUrlEnv, 'REFERALLI_BASE_URL');
    const baseRaw = str(v, 'base-url') ?? ctx.env.REFERALLI_BASE_URL?.trim() ?? legacyBase;
    if (!baseRaw) throw new CliError('Pass --base-url <your Referalli base URL> (or set REFERALLI_BASE_URL).');
    const baseUrl = httpsUrl(baseRaw, '--base-url');
    const oldKeyFile = str(v, LEGACY.keyFileFlag);
    const oldKey = str(v, LEGACY.keyFlag);
    if (oldKeyFile) legacyNotice(ctx, `--${LEGACY.keyFileFlag}`, '--referalli-key-file');
    if (oldKey) legacyNotice(ctx, `--${LEGACY.keyFlag}`, '--referalli-key');
    const legacyKey = ctx.env[LEGACY.apiKeyEnv]?.trim();
    if (!ctx.env.REFERALLI_API_KEY?.trim() && legacyKey) legacyNotice(ctx, LEGACY.apiKeyEnv, 'REFERALLI_API_KEY');
    const keyFile = str(v, 'referalli-key-file') ?? oldKeyFile;
    const key =
      str(v, 'referalli-key') ??
      oldKey ??
      (keyFile ? readKeyFile(ctx, keyFile, 'the Referalli key') : (ctx.env.REFERALLI_API_KEY?.trim() ?? legacyKey));
    if (!key) {
      throw new CliError('Pass your Referalli merchant key with --referalli-key-file <path|-> (or --referalli-key, or REFERALLI_API_KEY). It is used once and never stored.');
    }
    const destination = str(v, 'destination');
    if (destination) httpsUrl(destination, '--destination');

    const instance = await http.get<{ id: string; environment?: string }>('/v1/instance');
    // Test data for development instances, live data for production: a mix-up
    // would pay real partners for test sign-ups, or lose real ones.
    const instanceLive = instance.environment === 'production';
    const mode = await referalliKeyMode(ctx, { baseUrl, key });
    if (mode.known && mode.live !== instanceLive) {
      const message =
        `the Referalli key reaches ${mode.live ? 'live' : 'test'} data but instance ${instance.id} is ` +
        `${instance.environment ?? 'not production'}. Use ${instanceLive ? 'a live (rk_live_…)' : 'a test (rk_test_…)'} key` +
        ` for it, or pass --allow-mode-mismatch.`;
      if (v['allow-mode-mismatch'] !== true) throw new CliError(message.charAt(0).toUpperCase() + message.slice(1));
      ctx.io.err(`atlas: warning: ${message.replace(/, or pass --allow-mode-mismatch\.$/, '.')}`);
    } else if (!mode.known && !instanceLive) {
      ctx.io.err(`atlas: warning: Referalli did not say whether this key reaches test data; instance ${instance.id} is ${instance.environment ?? 'not production'}.`);
    }
    const created = await referalliCreateConnection(ctx, {
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
    // Atlas always signs with v2: require it from the first call, so v1 is never accepted on this connection.
    let signatureV2 = true;
    try {
      await referalliRequest(ctx, {
        baseUrl,
        key,
        method: 'PATCH',
        path: `/v1/auth/connections/${encodeURIComponent(created.id)}`,
        body: { signatureVersion: 'v2' },
        what: 'require v2 signatures on the connection',
      });
    } catch (err) {
      signatureV2 = false;
      ctx.io.err(`atlas: warning: ${err instanceof Error ? err.message : String(err)} It switches to v2 on Atlas's first call anyway.`);
    }
    const trackingToken = str(v, 'tracking-token') ?? (typeof created.trackingToken === 'string' ? created.trackingToken : null);
    patch = {
      provider: 'referalli',
      endpoint_url: baseUrl,
      connection_id: created.id,
      signing_secret: created.secret,
      program_id: program,
      ...(v['auto-enroll'] === true ? { auto_enroll_users: true } : {}),
      ...(trackingToken ? { tracking_token: trackingToken } : {}),
    };
    let saved: { inbound?: { url?: string | null } } | undefined;
    try {
      saved = await http.patch<{ inbound?: { url?: string | null } }>('/v1/instance/referrals', patch);
    } catch (err) {
      // The secret is shown once by Referalli: keep it so the merchant can finish by hand.
      const saved = deliverSecret({
        io: out,
        env: ctx.env,
        product,
        fileName: `referalli-connection-${created.id}.env`,
        entries: { REFERALLI_CONNECTION_ID: created.id, REFERALLI_CONNECTION_SECRET: created.secret },
        label: 'The Referalli connection secret (not saved on Atlas)',
        force: v.force === true,
        comment: `Referalli connection ${created.id}: saving it on the Atlas instance failed. Paste it in Users → Referrals.`,
      });
      ctx.io.err(`atlas: the connection ${created.id} was created on Referalli, but saving it on the instance failed.${saved.path ? ` Its secret is in ${saved.path}.` : ''}`);
      throw err;
    }
    // Two-way sync: Referalli's referral events go to the instance's inbound URL.
    let syncEndpoint: string | null = null;
    const inboundUrl = saved?.inbound?.url ?? null;
    if (v['no-sync'] !== true && inboundUrl) {
      try {
        const endpoint = await referalliRequest(ctx, {
          baseUrl,
          key,
          method: 'POST',
          path: '/v1/webhook-endpoints',
          body: { url: inboundUrl, topics: [...REFERALLI_SYNC_TOPICS], legacySignature: false },
          what: 'register the referral event webhook',
        });
        if (typeof endpoint.id !== 'string' || typeof endpoint.secret !== 'string') {
          throw new CliError('Referalli answered without a webhook endpoint id and secret.');
        }
        try {
          await http.patch('/v1/instance/referrals', { inbound_secret: endpoint.secret, inbound_endpoint_id: endpoint.id });
          syncEndpoint = endpoint.id;
        } catch (err) {
          const kept = deliverSecret({
            io: out,
            env: ctx.env,
            product,
            fileName: `referalli-webhook-${endpoint.id}.env`,
            entries: { REFERALLI_WEBHOOK_ENDPOINT_ID: endpoint.id, REFERALLI_WEBHOOK_SECRET: endpoint.secret },
            label: 'The Referalli webhook secret (not saved on Atlas)',
            force: v.force === true,
            comment: `Referalli webhook ${endpoint.id}: saving it on the Atlas instance failed. Paste it as the inbound secret in Users → Referrals.`,
          });
          ctx.io.err(
            `atlas: warning: the webhook ${endpoint.id} was registered on Referalli, but saving its secret failed (${err instanceof Error ? err.message : String(err)}).${kept.path ? ` It is in ${kept.path}.` : ''}`,
          );
        }
      } catch (err) {
        if (!(err instanceof CliError)) throw err;
        ctx.io.err(`atlas: warning: ${err.message} Referral changes on Referalli won't reach Atlas until it is registered (see the docs).`);
      }
    }
    summary = {
      provider: 'referalli',
      instance_id: instance.id,
      endpoint_url: baseUrl,
      connection_id: created.id,
      program_id: program,
      tracking_token: trackingToken,
      livemode: mode.known ? mode.live : null,
      signature_v2_required: signatureV2,
      sync_endpoint_id: syncEndpoint,
    };
    if (!json) {
      out.out(`Created Referalli connection ${created.id} for instance ${instance.id} and saved it (the secret was not printed).`);
      if (syncEndpoint) out.out(`Referral changes on Referalli sync back to Atlas (webhook ${syncEndpoint}).`);
    }
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
    const inboundUrl = (await http.get<{ inbound?: { url?: string | null } }>('/v1/instance/referrals')).inbound?.url ?? null;
    summary = { provider: 'webhook', endpoint_url: endpointUrl, secret_file: secretPath ?? null, inbound_url: inboundUrl };
    if (!json) {
      out.out(`Saved the referral protocol connection to ${endpointUrl}.`);
      if (inboundUrl) out.out(`For two-way sync, have the platform send referral changes to ${inboundUrl}, signed with the same secret.`);
    }
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
  const inbound = settings.inbound;
  if (inbound?.url) {
    // Referalli needs its own webhook secret; the Atlas protocol falls back to the signing secret.
    const syncing = inbound.secret_set || (settings.provider === 'webhook' && settings.signing_secret_set);
    lines.push(`Two-way sync:         ${syncing ? 'on' : 'off (no inbound secret)'}${inbound.endpoint_id ? ` (webhook ${inbound.endpoint_id})` : ''}`);
    lines.push(`Inbound URL:          ${inbound.url}`);
    if (inbound.last_event) {
      lines.push(`Last event:           ${inbound.last_event.type} → ${inbound.last_event.outcome} at ${new Date(inbound.last_event.at).toISOString()}`);
    }
  }
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

/**
 * `atlas referrals conformance`: run the referral protocol conformance suite
 * (@atlasauth/referral-conformance) against a platform, and optionally Atlas's
 * own simulated sign-up against the connected instance.
 *
 * The platform defaults to the instance's configured Referalli endpoint and
 * connection id; the connection secret is never readable from Atlas, so it
 * comes from --secret-file (or '-' for stdin).
 */
async function conformance(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const v = args.values;
  const json = wantsJson(v);
  const http = httpFor(ctx, instanceCredential(ctx, args));
  const settings = await http.get<ReferralSettingsRead>('/v1/instance/referrals');
  // Any platform: `webhook` tests the generic Atlas referral protocol, `connection` the connection-API dialect
  // (Referalli's). Default: what the instance is connected to.
  const profileFlag = str(v, 'protocol');
  if (profileFlag && profileFlag !== 'webhook' && profileFlag !== 'connection') {
    throw new CliError(`--protocol must be webhook or connection, got '${profileFlag}'.`);
  }
  const profile = (profileFlag as 'webhook' | 'connection' | undefined) ?? (settings.provider === 'webhook' ? 'webhook' : 'connection');
  const configured = settings.provider === 'webhook' || settings.provider === 'referalli';
  const baseRaw = str(v, 'base-url') ?? (configured ? settings.endpoint_url : null);
  if (!baseRaw) throw new CliError('Pass --base-url <the platform to test> (or connect a platform first).');
  const baseUrl = httpsUrl(baseRaw, '--base-url');
  const connectionId = str(v, 'connection-id') ?? (profile === 'webhook' ? 'n/a' : settings.connection_id);
  if (!connectionId) throw new CliError('Pass --connection-id <id> (the connection the suite signs its calls for).');
  const secretFile = str(v, 'secret-file');
  if (!secretFile) {
    throw new CliError('Pass --secret-file <path|-> with the connection secret. Atlas never shows it, so take it from the platform.');
  }
  const secret = readKeyFile(ctx, secretFile, 'the connection secret');
  const only = str(v, 'only')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const report = await runConformance({
    profile,
    baseUrl,
    connectionId,
    secret,
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    ...(only?.length ? { only } : {}),
  });
  let simulation: Record<string, unknown> | null = null;
  if (v.simulate === true) {
    simulation = await http.post<Record<string, unknown>>('/v1/instance/referrals/simulate', {});
  }
  if (json) printJson(ctx.io, { ...report, simulation });
  else {
    for (const line of formatReport(report)) ctx.io.out(line);
    if (simulation) {
      ctx.io.out('');
      ctx.io.out(
        simulation.ok === true
          ? `Atlas's simulated sign-up reached the platform (call ${String(simulation.call_id ?? '')}).`
          : `Atlas's simulated sign-up failed: ${String((simulation.error as { message?: string } | null)?.message ?? 'no answer')}.`,
      );
    }
  }
  return report.ok && (simulation === null || simulation.ok === true) ? 0 : 1;
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
    case 'conformance':
      return conformance(ctx, args);
    default:
      throw new CliError(
        sub
          ? `Unknown subcommand 'referrals ${sub}'. Try: connect, backfill, status, conformance.`
          : 'referrals needs a subcommand: connect, backfill, status, conformance.',
      );
  }
}

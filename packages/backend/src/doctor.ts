/**
 * `doctor`: check that this server can talk to Atlas and verify its tokens.
 * Looks at the secret key, the clock, the Backend API, the instance's JWKS,
 * the service status and the instance configuration. Never throws and never
 * prints or returns the key.
 *
 * ```ts
 * const report = await doctor({ secretKey: process.env.ATLAS_SECRET_KEY! });
 * if (!report.ok) console.error(formatDoctorReport(report));
 * ```
 */
import { ATLAS_BACKEND_VERSION } from './version';

export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  name: 'key' | 'api' | 'clock' | 'instance' | 'jwks' | 'status' | 'config';
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  /** No check failed (warnings allowed). */
  ok: boolean;
  checks: DoctorCheck[];
  /** Seconds the local clock is ahead (+) or behind (-) Atlas, when measured. */
  clockSkewSeconds?: number;
  sdk: string;
}

export interface DoctorOptions {
  secretKey: string;
  /** Backend API origin. Default `https://api.atlasauth.net`. */
  apiUrl?: string;
  fetch?: typeof fetch;
  /** Local clock, for tests. */
  now?: () => number;
  /** Skew in seconds that warns / fails. Defaults 30 / 120 (webhooks tolerate 300, session tokens far less). */
  warnSkewSeconds?: number;
  failSkewSeconds?: number;
  /** Per-request timeout in ms. Default 10000. */
  timeoutMs?: number;
}

interface InstanceLike {
  id?: string;
  environment?: string;
  frontend_api_host?: string;
  issuer?: string;
  jwks_uri?: string;
  allowed_origins?: string[];
}

export async function doctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (name: DoctorCheck['name'], status: DoctorStatus, detail: string) => void checks.push({ name, status, detail });
  const report = (extra: Partial<DoctorReport> = {}): DoctorReport => ({ ok: !checks.some((c) => c.status === 'fail'), checks, sdk: `@atlasauth/backend/${ATLAS_BACKEND_VERSION}`, ...extra });

  const key = options.secretKey ?? '';
  if (!key) add('key', 'fail', 'No secret key given.');
  else if (key.startsWith('pk_')) add('key', 'fail', 'This is a publishable key (pk_...). The Backend API needs the secret key (sk_...).');
  else if (!key.startsWith('sk_')) add('key', 'fail', 'The key does not look like a secret key (sk_...).');
  else add('key', 'pass', `Secret key present (${key.startsWith('sk_live') ? 'live' : 'non-live'} prefix).`);
  if (checks[0]!.status === 'fail') return report();

  const f = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const base = (options.apiUrl ?? 'https://api.atlasauth.net').replace(/\/+$/, '');
  const get = async (url: string, auth: boolean) => {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = ctl ? setTimeout(() => ctl.abort(), options.timeoutMs ?? 10_000) : undefined;
    try {
      return await f(url, { method: 'GET', headers: { accept: 'application/json', ...(auth ? { authorization: `Bearer ${key}` } : {}) }, signal: ctl?.signal });
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  let instance: InstanceLike | undefined;
  let skew: number | undefined;
  try {
    const sent = now();
    const res = await get(`${base}/v1/instance`, true);
    const received = now();
    if (res.status === 401 || res.status === 403) add('api', 'fail', `The Backend API refused the key (HTTP ${res.status}). Check it belongs to this instance and has not been rolled.`);
    else if (!res.ok) add('api', 'fail', `The Backend API answered HTTP ${res.status}.`);
    else {
      add('api', 'pass', `Backend API reachable (${received - sent} ms).`);
      instance = (await res.json().catch(() => undefined)) as InstanceLike | undefined;
      const date = res.headers?.get?.('date');
      const server = date ? Date.parse(date) : NaN;
      if (Number.isFinite(server)) skew = Math.round(((sent + received) / 2 - server) / 1000);
    }
  } catch (e) {
    add('api', 'fail', `The Backend API is unreachable: ${e instanceof Error ? e.message : 'request failed'}.`);
  }

  if (skew === undefined) add('clock', 'skip', 'Not measured (no server Date header).');
  else {
    const abs = Math.abs(skew);
    const warn = options.warnSkewSeconds ?? 30;
    const fail = options.failSkewSeconds ?? 120;
    const how = skew >= 0 ? 'ahead of' : 'behind';
    if (abs >= fail) add('clock', 'fail', `The local clock is ${abs}s ${how} Atlas. Tokens and webhooks will be refused as expired or not yet valid. Sync it (NTP).`);
    else if (abs >= warn) add('clock', 'warn', `The local clock is ${abs}s ${how} Atlas. Sync it (NTP) before tokens start failing.`);
    else add('clock', 'pass', `Clock within ${abs}s of Atlas.`);
  }

  if (!instance) {
    for (const n of ['instance', 'jwks', 'status', 'config'] as const) add(n, 'skip', 'Needs a working Backend API check.');
    return report({ clockSkewSeconds: skew });
  }
  add('instance', 'pass', `Instance ${instance.id ?? '(unknown id)'} (${instance.environment ?? 'unknown environment'}).`);

  if (!instance.jwks_uri) add('jwks', 'warn', 'The instance reported no JWKS URL.');
  else {
    try {
      const res = await get(instance.jwks_uri, false);
      const body = res.ok ? ((await res.json().catch(() => undefined)) as { keys?: Array<{ kid?: string }> } | undefined) : undefined;
      if (!res.ok) add('jwks', 'fail', `The JWKS answered HTTP ${res.status}: tokens cannot be verified.`);
      else if (!body?.keys?.length) add('jwks', 'fail', 'The JWKS holds no keys.');
      else add('jwks', 'pass', `JWKS reachable with ${body.keys.length} key(s).`);
    } catch (e) {
      add('jwks', 'fail', `The JWKS is unreachable: ${e instanceof Error ? e.message : 'request failed'}.`);
    }
  }

  if (!instance.frontend_api_host) add('status', 'skip', 'No frontend API host to read the status from.');
  else {
    try {
      const res = await get(`https://${instance.frontend_api_host}/v1/status`, false);
      const body = res.ok ? ((await res.json().catch(() => undefined)) as { status?: string } | undefined) : undefined;
      if (!body?.status) add('status', 'warn', `The status endpoint answered HTTP ${res.status}.`);
      else add('status', body.status === 'operational' ? 'pass' : 'warn', `Atlas reports ${body.status}.`);
    } catch (e) {
      add('status', 'warn', `The status endpoint is unreachable: ${e instanceof Error ? e.message : 'request failed'}.`);
    }
  }

  const problems: string[] = [];
  if (!instance.issuer?.startsWith('https://')) problems.push('the issuer is not an https URL');
  if (!instance.allowed_origins?.length) problems.push('no allowed origins are set');
  if (instance.environment === 'production' && instance.allowed_origins?.some((o) => o.startsWith('http://'))) problems.push('a production instance allows an http:// origin');
  add('config', problems.length ? 'warn' : 'pass', problems.length ? `Check the configuration: ${problems.join('; ')}.` : 'Issuer and allowed origins look right.');
  return report({ clockSkewSeconds: skew });
}

/** A readable, one-line-per-check version of a report. */
export function formatDoctorReport(report: DoctorReport): string {
  const mark: Record<DoctorStatus, string> = { pass: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' };
  return [`atlas doctor (${report.sdk})`, ...report.checks.map((c) => `  [${mark[c.status]}] ${c.name}: ${c.detail}`), report.ok ? 'All required checks passed.' : 'Some checks failed.'].join('\n');
}

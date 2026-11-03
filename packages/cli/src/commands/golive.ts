import { AtlasApiError } from '@atlasauth/backend';
import { str, type ParsedArgs } from '../args';
import type { ConfigHttp } from '../config-http';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import { httpFor } from '../project';
import { instanceCredential } from './project-commands';
import { wantsJson } from './shared';

/**
 * `atlas golive --origin <url>`: take an instance from "configured" to "live"
 * for one app origin. Runs the steps in order and stops at the first failure,
 * printing the fix. `--dry-run` sends every write with `?dry_run=true`, so the
 * server validates it and nothing changes.
 */

/** One result line. `ok: false` carries the fix. */
export interface CheckResult {
  id: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

interface Domain {
  id: string;
  role: string;
  host: string;
  status: string;
  method?: 'cname' | 'path';
  base_path?: string | null;
  action?: string | null;
  failure_reason?: string | null;
  verified?: boolean;
}

interface PreflightFinding {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  fix: string;
  acknowledged?: unknown;
}

/** The cookies the SDKs read: a consent manager that does not declare them may block sign-in. */
export const SDK_COOKIES = ['__session', '__atlas_uat', '__atlas_rt', '__client'] as const;

/** Parse `--origin` to a bare origin (scheme + host + port). */
export function parseOrigin(raw: string | undefined, command: string): URL {
  if (!raw) throw new CliError(`${command} needs --origin <https://your-app.example.com>.`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CliError(`--origin must be a full origin such as https://app.example.com, got '${raw}'.`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new CliError(`--origin must be http(s), got '${raw}'.`);
  return new URL(u.origin);
}

/** The custom domain serving this origin's host: an exact host match, else the Frontend API domain. */
export function domainFor(domains: Domain[], host: string): Domain | undefined {
  return domains.find((d) => d.host === host) ?? domains.find((d) => d.role === 'fapi');
}

export async function preflightCheck(api: ConfigHttp): Promise<CheckResult> {
  const report = await api.get<{ findings?: PreflightFinding[] }>('/v1/instance/preflight');
  const errors = (report.findings ?? []).filter((f) => f.severity === 'error' && !f.acknowledged);
  if (!errors.length) return { id: 'preflight', ok: true, detail: 'no error findings' };
  return {
    id: 'preflight',
    ok: false,
    detail: errors.map((f) => `${f.code}: ${f.message}`).join('; '),
    fix: errors.map((f) => `${f.code}: ${f.fix}`).join(' | '),
  };
}

export async function loginReadinessCheck(api: ConfigHttp, origin: string): Promise<CheckResult> {
  const r = await api.get<{ ready: boolean; checks?: Array<{ name: string; pass: boolean; applies?: boolean; detail: string }> }>(
    `/v1/diagnostics/login_readiness?origin=${encodeURIComponent(origin)}&live=true`,
  );
  if (r.ready) return { id: 'login_readiness', ok: true, detail: `ready for ${origin}` };
  const failing = (r.checks ?? []).filter((c) => !c.pass && c.applies !== false);
  return {
    id: 'login_readiness',
    ok: false,
    detail: `not ready for ${origin} (${failing.map((c) => c.name).join(', ') || 'unknown hop'})`,
    fix: failing.map((c) => c.detail).join(' ') || 'See GET /v1/diagnostics/login_readiness for the failing hop.',
  };
}

/** A path mount on the origin's host: verified (active) or the step still to do. */
export async function pathMountCheck(api: ConfigHttp, host: string): Promise<CheckResult> {
  const { data } = await api.get<{ data: Domain[] }>('/v1/domains');
  const mount = data.find((d) => d.method === 'path' && d.host === host);
  if (!mount) return { id: 'path_mount', ok: true, detail: `no path mount on ${host}` };
  if (mount.status === 'active') return { id: 'path_mount', ok: true, detail: `${host}${mount.base_path ?? ''} verified` };
  return {
    id: 'path_mount',
    ok: false,
    detail: `${host}${mount.base_path ?? ''} is ${mount.status}${mount.failure_reason ? `: ${mount.failure_reason}` : ''}`,
    fix: mount.action ?? `Publish the verification file, then POST /v1/domains/${mount.id}/verify.`,
  };
}

export async function declaredCookiesCheck(api: ConfigHttp): Promise<CheckResult> {
  const cc = await api.get<{ declared_cookies?: Array<{ name: string | null }> }>('/v1/instance/cookie_consent');
  const names = new Set((cc.declared_cookies ?? []).map((c) => c.name));
  const missing = SDK_COOKIES.filter((n) => !names.has(n));
  if (!missing.length) return { id: 'declared_cookies', ok: true, detail: `declares ${SDK_COOKIES.join(', ')}` };
  return {
    id: 'declared_cookies',
    ok: false,
    detail: `cookie declaration is missing ${missing.join(', ')}`,
    fix: 'Re-import the storage declaration (GET /v1/instance/storage_declaration) into your consent manager as strictly necessary.',
  };
}

class StepFailed extends Error {
  constructor(
    readonly step: string,
    readonly problem: string,
    readonly fix: string,
  ) {
    super(problem);
  }
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export async function golive(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const v = args.values;
  const origin = parseOrigin(str(v, 'origin'), 'golive');
  const dry = v['dry-run'] === true;
  const json = wantsJson(v);
  const api = httpFor(ctx, instanceCredential(ctx, args));
  const fetchImpl = ctx.fetch ?? globalThis.fetch;
  const q = (path: string) => (dry ? `${path}${path.includes('?') ? '&' : '?'}dry_run=true` : path);
  const results: CheckResult[] = [];
  let current = 'domains';

  const pass = (id: string, detail: string) => {
    results.push({ id, ok: true, detail });
    if (!json) ctx.io.out(`✓ ${id} — ${detail}`);
  };
  const fail = (problem: string, fix: string): never => {
    throw new StepFailed(current, problem, fix);
  };
  const check = (r: CheckResult) => (r.ok ? pass(r.id, r.detail) : fail(r.detail, r.fix ?? ''));
  const would = (done: string, planned: string) => (dry ? `would ${planned} (dry run)` : done);

  try {
    // (1) domains
    const listed = await api.get<{ data: Domain[]; required?: boolean }>('/v1/domains');
    let domain = domainFor(listed.data ?? [], origin.host);
    if (!domain) {
      if (listed.required) fail(`no custom domain for ${origin.host}, and this instance needs one`, 'Add one: POST /v1/domains {"host": "auth.<your-domain>"} (or a path mount on your app host), then publish its DNS record or file.');
      pass('domains', 'no custom domain (not required for this instance)');
    } else if (domain.status === 'active') {
      pass('domains', `${domain.host}${domain.base_path ?? ''} verified`);
    } else {
      const res = await api.post<Domain & { object?: string }>(q(`/v1/domains/${domain.id}/verify`), {});
      if (dry) pass('domains', would('', `verify ${domain.host}`));
      else if (!res.verified) fail(`${domain.host} is not verified yet (${res.status})`, res.action ?? res.failure_reason ?? 'Publish the DNS record or verification file, then run golive again.');
      else {
        domain = { ...domain, ...res };
        pass('domains', `${domain.host} verified`);
      }
    }

    // (2) issuer
    current = 'issuer';
    const instance = await api.get<{ issuer?: string | null }>('/v1/instance');
    const expected = instance.issuer ? trimSlash(instance.issuer) : null;
    if (!expected) fail('the instance reports no issuer', 'Check GET /v1/instance; a verified Frontend API domain sets it.');
    const base =
      domain?.method === 'path' && domain.host === origin.host
        ? `${origin.origin}${domain.base_path ?? ''}`
        : domain
          ? `https://${domain.host}${domain.base_path ?? ''}`
          : expected!;
    const discoveryUrl = `${trimSlash(base)}/.well-known/openid-configuration`;
    let served: string | undefined;
    try {
      const res = await fetchImpl(discoveryUrl, { headers: { accept: 'application/json' } });
      if (!res.ok) fail(`${discoveryUrl} answered ${res.status}`, 'Route that path to your Atlas Frontend API (see the domain instructions in GET /v1/domains).');
      served = ((await res.json()) as { issuer?: string }).issuer;
    } catch (err) {
      if (err instanceof StepFailed) throw err;
      fail(`${discoveryUrl} is unreachable (${err instanceof Error ? err.message : String(err)})`, 'Check DNS, TLS and the proxy rule for that host.');
    }
    if (!served || trimSlash(served) !== expected) {
      fail(`${discoveryUrl} serves issuer ${served ?? '(none)'}, expected ${expected}`, 'Point that host/path at this instance\'s Frontend API, or verify the domain so the instance issues tokens for it.');
    }
    pass('issuer', `${expected}`);

    // (3) Sign in with Atlas
    current = 'sign_in_with_atlas';
    const siwa = await api.get<{ enabled: boolean; connection_id: string | null; turned_off_by_you?: boolean; available?: boolean; candidates?: Array<{ id: string }> }>(
      '/v1/instance/sign_in_with_atlas',
    );
    const declared = !siwa.turned_off_by_you && (siwa.connection_id !== null || (siwa.candidates?.length ?? 0) > 0);
    if (siwa.enabled) pass('sign_in_with_atlas', 'enabled');
    else if (!declared) pass('sign_in_with_atlas', 'not declared, skipped');
    else {
      if (siwa.available === false) fail('declared, but Sign in with Atlas is not available on this Atlas', 'Remove the declaration, or contact your Atlas operator.');
      const body = { enabled: true, ...(siwa.connection_id ? {} : { connection_id: siwa.candidates![0]!.id }) };
      const after = await api.patch<{ enabled?: boolean }>(q('/v1/instance/sign_in_with_atlas'), body);
      if (!dry && !after.enabled) fail('could not turn Sign in with Atlas on', 'PATCH /v1/instance/sign_in_with_atlas {"enabled": true} and read the error.');
      pass('sign_in_with_atlas', would('turned on', 'turn it on'));
    }

    // (4) webhooks: an inactive endpoint is turned on only after its test delivery succeeds.
    current = 'webhooks';
    const endpoints = (await api.get<{ data: Array<{ id: string; url: string; active: boolean }> }>('/v1/webhook_endpoints')).data ?? [];
    const inactive = endpoints.filter((e) => !e.active);
    for (const e of inactive) {
      const t = await api.post<{ status?: string; http_status?: number | null; error?: string | null }>(q(`/v1/webhook_endpoints/${e.id}/test?wait=10s`), {});
      if (!dry && t.status !== 'success') {
        fail(`test delivery to ${e.url} failed (${t.http_status ?? t.error ?? t.status ?? 'no answer'})`, `Fix the receiver, then 'atlas webhooks test ${e.id}' and run golive again.`);
      }
      await api.patch(q(`/v1/webhook_endpoints/${e.id}`), { active: true });
      pass('webhooks', would(`${e.url} tested and activated`, `test and activate ${e.url}`));
    }
    if (!inactive.length) pass('webhooks', `${endpoints.length} endpoint(s), none inactive`);

    // (5) hooks
    current = 'hooks';
    const hookPath = '/v1/instance/hooks/before_user_create';
    const hook = await api.get<{ enabled: boolean; url: string | null; signing_secret_set: boolean }>(hookPath);
    if (hook.enabled) pass('hooks', 'before_user_create enabled');
    else if (!hook.url || !hook.signing_secret_set) pass('hooks', 'no hook configured');
    else {
      const t = await api.post<{ ok: boolean; error?: { message?: string } | null }>(q(`${hookPath}/test`), {});
      if (!dry && !t.ok) fail(`before_user_create test call failed: ${t.error?.message ?? 'no answer'}`, `Fix the endpoint (GET ${hookPath}/calls?status=failed), then run golive again.`);
      await api.patch(q(hookPath), { enabled: true });
      pass('hooks', would('before_user_create tested and enabled', 'test and enable before_user_create'));
    }

    // (6) preflight + login readiness
    current = 'preflight';
    check(await preflightCheck(api));
    current = 'login_readiness';
    check(await loginReadinessCheck(api, origin.origin));

    // (7) integrations: only those the instance declares.
    current = 'integrations';
    const referrals = await optional(() =>
      api.get<{ endpoint_url: string | null; connection_id: string | null; signing_secret_set: boolean; connection?: { last_test?: { ok: boolean } | null } | null }>(
        '/v1/instance/referrals',
      ),
    );
    if (referrals && (referrals.endpoint_url || referrals.connection_id)) {
      current = 'integrations/referrals';
      if (!referrals.signing_secret_set) fail('referral connection has no signing secret', "Run 'atlas referrals connect' to finish it.");
      if (referrals.connection?.last_test?.ok === true) pass(current, 'connected');
      else {
        const t = await api.post<{ ok: boolean; error?: { message: string } | null }>(q('/v1/instance/referrals/test'), {});
        if (!dry && !t.ok) fail(`connection test failed: ${t.error?.message ?? 'no answer'}`, "Run 'atlas referrals status' for details.");
        pass(current, would('connection tested', 'test the connection'));
      }
    }
    const privacy = await optional(() => api.get<{ preset: string | null; connected: boolean }>('/v1/instance/privacy_integrations'));
    if (privacy?.preset) {
      current = 'integrations/privacy';
      if (!privacy.connected) {
        fail(`${privacy.preset} is declared but not connected`, 'Finish it in the dashboard, or POST /v1/instance/privacy_integrations/connect with the orchestrator key and completion webhook URL.');
      }
      pass(current, `${privacy.preset} connected`);
    }
    const identity = (await optional(() => api.get<{ data: Array<{ id: string; connected: boolean; enabled: boolean }> }>('/v1/instance/integrations')))?.data ?? [];
    for (const i of identity.filter((x) => x.connected)) pass(`integrations/${i.id}`, i.enabled ? 'on' : 'off');
  } catch (err) {
    const failed =
      err instanceof StepFailed
        ? err
        : err instanceof AtlasApiError
          ? new StepFailed(current, `API error (HTTP ${err.status})${err.code ? ` [${err.code}]` : ''}: ${err.message}`, 'Check the key has the scopes this step needs, then run golive again.')
          : null;
    if (!failed) throw err;
    results.push({ id: failed.step, ok: false, detail: failed.problem, fix: failed.fix });
    if (json) printJson(ctx.io, { ok: false, dry_run: dry, origin: origin.origin, steps: results });
    else ctx.io.out(`✗ ${failed.step} — ${failed.problem}\n  fix: ${failed.fix}`);
    return 1;
  }
  if (json) printJson(ctx.io, { ok: true, dry_run: dry, origin: origin.origin, steps: results });
  else if (dry) ctx.io.out('Dry run: nothing was written.');
  return 0;
}

/** A read that is absent on this instance (404) is "not declared". */
async function optional<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof AtlasApiError && err.status === 404) return undefined;
    throw err;
  }
}

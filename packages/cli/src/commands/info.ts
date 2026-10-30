import { join, resolve } from 'node:path';
import { AtlasApiError, instanceIdFromPublishableKey } from '@atlasauth/backend';
import type { ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { printJson } from '../output';
import { httpFor } from '../project';
import { readEnvFile } from '../secrets';
import { getVersion } from '../version';
import { instanceCredential } from './project-commands';
import { envApiUrl, wantsJson } from './shared';

/**
 * `atlas info` — the environment in one copyable block, for support tickets and
 * "works on my machine" debugging:
 *
 *  - CLI, Node and OS versions;
 *  - the detected framework and every Atlas SDK package in the project, with the
 *    installed version and "update available" from the npm registry;
 *  - the configured instance — key PREFIXES only (`sk_live_`, `pk_test_`), never a
 *    key — whether the app's publishable key belongs to that instance, the API
 *    URL, reachability and latency;
 *  - the instance's preflight summary.
 *
 * Every network step is best-effort with a short timeout: `atlas info` reports a
 * failure as data instead of failing, because it is what you run when things are
 * broken. A final redaction pass masks anything shaped like a secret.
 */

const NPM_REGISTRY = 'https://registry.npmjs.org';
const TIMEOUT_MS = 5_000;

/** Frameworks, in detection priority (the first one present wins as "framework"). */
const FRAMEWORKS: ReadonlyArray<[pkg: string, label: string]> = [
  ['next', 'Next.js'],
  ['@remix-run/react', 'Remix'],
  ['@react-router/dev', 'React Router'],
  ['@tanstack/react-start', 'TanStack Start'],
  ['nuxt', 'Nuxt'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['astro', 'Astro'],
  ['gatsby', 'Gatsby'],
  ['@builder.io/qwik-city', 'Qwik City'],
  ['@angular/core', 'Angular'],
  ['expo', 'Expo'],
  ['react-native', 'React Native'],
  ['electron', 'Electron'],
  ['@nestjs/core', 'NestJS'],
  ['hono', 'Hono'],
  ['fastify', 'Fastify'],
  ['express', 'Express'],
  ['solid-js', 'Solid'],
  ['vue', 'Vue'],
  ['vite', 'Vite'],
  ['react', 'React'],
];

const PUBLISHABLE_ENV = ['ATLAS_PUBLISHABLE_KEY', 'NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY', 'VITE_ATLAS_PUBLISHABLE_KEY', 'REACT_APP_ATLAS_PUBLISHABLE_KEY', 'PUBLIC_ATLAS_PUBLISHABLE_KEY', 'EXPO_PUBLIC_ATLAS_PUBLISHABLE_KEY'];
const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];

export interface InfoPackage {
  name: string;
  wanted: string;
  installed: string | null;
  latest: string | null;
  update_available: boolean;
}

export interface InfoReport {
  object: 'atlas_info';
  generated_at: string;
  cli: { version: string; latest: string | null; update_available: boolean };
  runtime: { node: string; platform: string; arch: string };
  project: {
    path: string;
    name: string | null;
    framework: { name: string; package: string; version: string | null } | null;
    packages: InfoPackage[];
  };
  instance: {
    configured: boolean;
    api_url: string | null;
    key_source: string | null;
    secret_key_prefix: string | null;
    instance_id: string | null;
    environment: string | null;
    frontend_api_host: string | null;
    publishable_key_prefix: string | null;
    publishable_key_source: string | null;
    publishable_key_matches_instance: boolean | null;
    error: string | null;
  };
  api: {
    reachable: boolean;
    health_status: number | null;
    health_latency_ms: number | null;
    instance_latency_ms: number | null;
    error: string | null;
  };
  preflight: {
    ran: boolean;
    ok: boolean | null;
    errors: number;
    warnings: number;
    info: number;
    findings: Array<{ severity: string; code: string }>;
    error: string | null;
  };
}

/** `atlas_live_sk_abc…` → `atlas_live_sk_`, `sk_live_abc…` → `sk_live_`; anything else → its first 3 chars. */
export function keyPrefix(key: string): string {
  const m =
    /^(atlas_(?:live|test)_[a-z]+_)/.exec(key) ?? /^([a-z]+_(?:live|test)_)/.exec(key) ?? /^([a-z]+_)/.exec(key);
  return m ? m[1]! : `${key.slice(0, 3)}…`;
}

/** Mask anything that looks like an Atlas (or other bearer) secret in free text. */
export function redactSecrets(text: string): string {
  return text.replace(
    /\b((?:atlas_(?:live|test)_(?:sk|psk|dsk|whsec|pl|at)_)|(?:sk|psk|rk|whsec|ak|fck|cft)_(?:(?:live|test)_)?)[A-Za-z0-9_-]{6,}/g,
    '$1[redacted]',
  );
}

/** Dotted-number compare that tolerates prerelease tags (`1.2.0-rc.1` < `1.2.0`). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.replace(/^[^\d]*/, '').split('-', 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return 0;
}

function isAtlasPackage(name: string): boolean {
  return name.startsWith('@atlasauth/') || name === 'gatsby-plugin-atlasauth';
}

function errorText(err: unknown): string {
  if (err instanceof AtlasApiError) return `HTTP ${err.status}${err.code ? ` ${err.code}` : ''}: ${err.message}`;
  if (err instanceof Error) return err.name === 'AbortError' || err.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS} ms` : err.message;
  return String(err);
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const err = new Error(`timed out after ${TIMEOUT_MS} ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export async function info(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const report = await collectInfo(ctx, args);
  if (wantsJson(args.values)) {
    // Redact the serialized form too: belt and braces over every free-text field.
    ctx.io.out(redactSecrets(JSON.stringify(report, null, 2)));
    return 0;
  }
  for (const line of renderInfo(report)) ctx.io.out(redactSecrets(line));
  return 0;
}

export async function collectInfo(ctx: RunContext, args: ParsedArgs): Promise<InfoReport> {
  const fetchImpl = ctx.fetch ?? globalThis.fetch;
  const projectDir = resolve(args.positionals[1] ?? process.cwd());
  const readJson = (path: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(ctx.readFile(path)) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const pkg = readJson(join(projectDir, 'package.json'));
  const deps: Record<string, string> = {
    ...((pkg?.dependencies as Record<string, string>) ?? {}),
    ...((pkg?.devDependencies as Record<string, string>) ?? {}),
  };
  const installedVersion = (name: string): string | null => {
    const v = readJson(join(projectDir, 'node_modules', ...name.split('/'), 'package.json'))?.version;
    return typeof v === 'string' ? v : null;
  };

  const latestOf = async (name: string): Promise<string | null> => {
    if (typeof fetchImpl !== 'function') return null;
    try {
      return await withTimeout(async (signal) => {
        const res = await fetchImpl(`${NPM_REGISTRY}/${name.replace('/', '%2F')}/latest`, {
          headers: { accept: 'application/json' },
          signal,
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { version?: unknown };
        return typeof body.version === 'string' ? body.version : null;
      });
    } catch {
      return null;
    }
  };

  const atlasNames = Object.keys(deps).filter(isAtlasPackage).sort();
  const cliVersion = getVersion();
  const [cliLatest, ...latest] = await Promise.all([latestOf('@atlasauth/cli'), ...atlasNames.map(latestOf)]);
  const packages: InfoPackage[] = atlasNames.map((name, i) => {
    const installed = installedVersion(name);
    const newest = latest[i] ?? null;
    const current = installed ?? deps[name]!;
    return {
      name,
      wanted: deps[name]!,
      installed,
      latest: newest,
      update_available: Boolean(newest && /\d/.test(current) && compareVersions(current, newest) < 0),
    };
  });

  const fw = FRAMEWORKS.find(([name]) => deps[name] !== undefined);
  const framework = fw ? { name: fw[1], package: fw[0], version: installedVersion(fw[0]) ?? deps[fw[0]] ?? null } : null;

  // Publishable key: the process env first, then the project's .env files.
  let publishable: { key: string; source: string } | null = null;
  for (const name of PUBLISHABLE_ENV) {
    const v = ctx.env[name]?.trim();
    if (v) {
      publishable = { key: v, source: `env ${name}` };
      break;
    }
  }
  if (!publishable) {
    outer: for (const file of ENV_FILES) {
      const vars = readEnvFile(join(projectDir, file));
      for (const name of PUBLISHABLE_ENV) {
        const v = vars?.[name]?.trim();
        if (v) {
          publishable = { key: v, source: `${file} ${name}` };
          break outer;
        }
      }
    }
  }

  const report: InfoReport = {
    object: 'atlas_info',
    generated_at: new Date().toISOString(),
    cli: {
      version: cliVersion,
      latest: cliLatest ?? null,
      update_available: Boolean(cliLatest && compareVersions(cliVersion, cliLatest) < 0),
    },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    project: { path: projectDir, name: typeof pkg?.name === 'string' ? pkg.name : null, framework, packages },
    instance: {
      configured: false,
      api_url: null,
      key_source: null,
      secret_key_prefix: null,
      instance_id: null,
      environment: null,
      frontend_api_host: null,
      publishable_key_prefix: publishable ? keyPrefix(publishable.key) : null,
      publishable_key_source: publishable?.source ?? null,
      publishable_key_matches_instance: null,
      error: null,
    },
    api: { reachable: false, health_status: null, health_latency_ms: null, instance_latency_ms: null, error: null },
    preflight: { ran: false, ok: null, errors: 0, warnings: 0, info: 0, findings: [], error: null },
  };

  let cred: { secretKey: string; apiUrl: string } | null = null;
  try {
    const resolved = instanceCredential(ctx, args);
    cred = { secretKey: resolved.secretKey, apiUrl: resolved.apiUrl };
    report.instance.configured = true;
    report.instance.api_url = resolved.apiUrl;
    report.instance.secret_key_prefix = keyPrefix(resolved.secretKey);
    report.instance.key_source = resolved.instance
      ? 'project manifest'
      : ctx.env.ATLAS_SECRET_KEY?.trim()
        ? 'env ATLAS_SECRET_KEY'
        : 'stored profile';
  } catch (err) {
    report.instance.error = errorText(err);
    report.instance.api_url = envApiUrl(ctx.env) || null;
  }

  // Reachability: the unauthenticated health endpoint, timed.
  const apiUrl = (report.instance.api_url ?? 'https://atlasauth.net').replace(/\/+$/, '');
  if (!report.instance.api_url) report.instance.api_url = apiUrl;
  if (typeof fetchImpl === 'function') {
    const started = Date.now();
    try {
      const res = await withTimeout((signal) => fetchImpl(`${apiUrl}/v1/health`, { signal }));
      report.api.health_status = res.status;
      report.api.health_latency_ms = Date.now() - started;
      report.api.reachable = res.status < 500;
    } catch (err) {
      report.api.error = errorText(err);
    }
  }

  if (cred) {
    const http = httpFor(ctx, cred);
    const started = Date.now();
    try {
      const inst = await withTimeout(() =>
        http.get<{ id?: string; environment?: string; publishable_key?: string; frontend_api_host?: string | null }>('/v1/instance'),
      );
      report.api.instance_latency_ms = Date.now() - started;
      report.api.reachable = true;
      report.instance.instance_id = inst.id ?? null;
      report.instance.environment = inst.environment ?? null;
      report.instance.frontend_api_host = inst.frontend_api_host ?? null;
      if (publishable) {
        report.instance.publishable_key_matches_instance = inst.publishable_key
          ? inst.publishable_key === publishable.key
          : instanceIdFromPublishableKey(publishable.key) === inst.id;
      }
    } catch (err) {
      report.instance.error = errorText(err);
    }
    try {
      const pre = await withTimeout(() =>
        http.get<{ ok?: boolean; findings?: Array<{ severity: string; code: string }> }>('/v1/instance/preflight'),
      );
      const findings = pre.findings ?? [];
      report.preflight = {
        ran: true,
        ok: pre.ok ?? null,
        errors: findings.filter((f) => f.severity === 'error').length,
        warnings: findings.filter((f) => f.severity === 'warning').length,
        info: findings.filter((f) => f.severity === 'info').length,
        findings: findings.map((f) => ({ severity: f.severity, code: f.code })),
        error: null,
      };
    } catch (err) {
      report.preflight.error = errorText(err);
    }
  }
  return report;
}

/** The human block: aligned, copyable, nothing secret. */
export function renderInfo(r: InfoReport): string[] {
  const lines: string[] = [];
  const row = (label: string, value: string) => lines.push(`  ${label.padEnd(22)}${value}`);
  const upd = (u: boolean, latest: string | null) => (u && latest ? `  (update available: ${latest})` : '');

  lines.push('Atlas environment (safe to paste into a support ticket: no secrets)');
  lines.push('');
  lines.push('System');
  row('atlas CLI', `${r.cli.version}${upd(r.cli.update_available, r.cli.latest)}`);
  row('Node.js', r.runtime.node);
  row('OS', `${r.runtime.platform} ${r.runtime.arch}`);
  lines.push('');
  lines.push('Project');
  row('path', r.project.path);
  if (r.project.name) row('name', r.project.name);
  row('framework', r.project.framework ? `${r.project.framework.name} ${r.project.framework.version ?? ''}`.trim() : 'not detected');
  if (r.project.packages.length === 0) row('Atlas packages', 'none in package.json');
  for (const p of r.project.packages) {
    row(p.name, `${p.installed ?? `${p.wanted} (not installed)`}${upd(p.update_available, p.latest)}`);
  }
  lines.push('');
  lines.push('Instance');
  if (!r.instance.configured) row('credential', `not configured (${r.instance.error ?? 'no key'})`);
  else {
    row('secret key', `${r.instance.secret_key_prefix}… (${r.instance.key_source})`);
    if (r.instance.instance_id) row('instance', `${r.instance.instance_id} (${r.instance.environment ?? 'unknown'})`);
    if (r.instance.frontend_api_host) row('frontend API host', r.instance.frontend_api_host);
    if (r.instance.error) row('instance lookup', `failed: ${r.instance.error}`);
  }
  row(
    'publishable key',
    r.instance.publishable_key_prefix
      ? `${r.instance.publishable_key_prefix}… (${r.instance.publishable_key_source})${
          r.instance.publishable_key_matches_instance === false
            ? '  MISMATCH: not this instance’s key'
            : r.instance.publishable_key_matches_instance
              ? '  matches instance'
              : ''
        }`
      : 'not found in env or .env files',
  );
  lines.push('');
  lines.push('API');
  row('URL', r.instance.api_url ?? 'unknown');
  row(
    'reachable',
    r.api.reachable
      ? `yes (health ${r.api.health_status ?? '?'} in ${r.api.health_latency_ms ?? '?'} ms${r.api.instance_latency_ms !== null ? `, instance ${r.api.instance_latency_ms} ms` : ''})`
      : `no${r.api.error ? ` (${r.api.error})` : r.api.health_status ? ` (health ${r.api.health_status})` : ''}`,
  );
  lines.push('');
  lines.push('Preflight');
  if (!r.preflight.ran) row('status', r.preflight.error ? `failed: ${r.preflight.error}` : 'not run (no instance credential)');
  else {
    row('result', `${r.preflight.errors} error(s), ${r.preflight.warnings} warning(s), ${r.preflight.info} info`);
    for (const f of r.preflight.findings.filter((x) => x.severity !== 'info')) row(f.severity, f.code);
    if (r.preflight.errors + r.preflight.warnings > 0) lines.push("  Run 'atlas preflight' for the fixes.");
  }
  return lines;
}

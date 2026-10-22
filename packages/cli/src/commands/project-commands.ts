import { AtlasApiError } from '@atlasauth/backend';
import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson, renderTable, type Column } from '../output';
import {
  findInstance,
  httpFor,
  instanceSecretFromFile,
  parseInstanceEnv,
  readManifest,
  type ProjectInstance,
  type ProjectManifest,
} from '../project';
import { deliverSecret, productDir, writeSecretFile } from '../secrets';
import { requireArg, resolveAuth, wantsJson } from './shared';

/**
 * The project commands that sit beside `atlas init`: `preflight` (a CI gate),
 * `env` (deploy variables without secrets) and `client rotate` (a new OAuth
 * client secret, written straight to its file).
 */

/**
 * The instance credential a project command runs with:
 *  - `--instance <id>`: the instance's secret file from a project manifest;
 *  - `--product <name>` [`--instance-env`]: that project's instance;
 *  - otherwise the profile / ATLAS_SECRET_KEY, as every other command.
 */
export function instanceCredential(
  ctx: RunContext,
  args: ParsedArgs,
): { secretKey: string; apiUrl: string; manifest?: ProjectManifest; instance?: ProjectInstance } {
  const v = args.values;
  const instanceId = str(v, 'instance');
  const product = str(v, 'product');
  if (instanceId) {
    const found = findInstance(ctx.env, instanceId, product);
    if (!found) {
      throw new CliError(
        `No project manifest knows instance ${instanceId}${product ? ` (product '${product}')` : ''}. Run 'atlas init' for it, or use ATLAS_SECRET_KEY.`,
      );
    }
    return {
      secretKey: instanceSecretFromFile(found.instance),
      apiUrl: ctx.env.ATLAS_API_URL?.trim() || found.manifest.api_url,
      manifest: found.manifest,
      instance: found.instance,
    };
  }
  if (product) {
    const { manifest, instance } = projectInstance(ctx, args, product);
    return {
      secretKey: instanceSecretFromFile(instance),
      apiUrl: ctx.env.ATLAS_API_URL?.trim() || manifest.api_url,
      manifest,
      instance,
    };
  }
  const auth = resolveAuth(ctx, v);
  return { secretKey: auth.secretKey, apiUrl: auth.apiUrl };
}

/** The manifest instance for `--product` + `--instance-env` (default: production, else the only one). */
function projectInstance(
  ctx: RunContext,
  args: ParsedArgs,
  product: string,
): { manifest: ProjectManifest; instance: ProjectInstance } {
  const manifest = readManifest(ctx.env, product);
  if (!manifest) {
    throw new CliError(`No project '${product}' at ${productDir(ctx.env, product)}. Run 'atlas init --product ${product}' first.`);
  }
  const requested = str(args.values, 'instance-env');
  const envs = Object.keys(manifest.instances) as Array<keyof ProjectManifest['instances']>;
  const env = requested
    ? parseInstanceEnv(requested, 'production')
    : manifest.instances.production
      ? 'production'
      : envs.length === 1
        ? envs[0]!
        : 'production';
  const instance = manifest.instances[env];
  if (!instance) throw new CliError(`Project '${product}' has no ${env} instance. Run 'atlas init --product ${product} --instance-env ${env}'.`);
  return { manifest, instance };
}

// ---- atlas preflight ---------------------------------------------------------

interface PreflightFinding {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  fix: string;
}

const FINDING_COLUMNS: Column<PreflightFinding>[] = [
  { header: 'SEVERITY', get: (f) => f.severity },
  { header: 'CODE', get: (f) => f.code },
  { header: 'MESSAGE', get: (f) => f.message },
];

/** `atlas preflight` — run the instance's setup checks; exit 1 on errors (or warnings with --fail-on warning). */
export async function preflight(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const failOn = str(args.values, 'fail-on') ?? 'error';
  if (failOn !== 'error' && failOn !== 'warning') {
    throw new CliError(`--fail-on must be error or warning, got '${failOn}'.`);
  }
  const cred = instanceCredential(ctx, args);
  const report = await httpFor(ctx, cred).get<{ ok: boolean; findings: PreflightFinding[] }>('/v1/instance/preflight');
  const findings = report.findings ?? [];
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  const failed = errors > 0 || (failOn === 'warning' && warnings > 0);

  if (wantsJson(args.values)) {
    printJson(ctx.io, report);
  } else if (findings.length === 0) {
    ctx.io.out('Preflight passed: no findings.');
  } else {
    ctx.io.out(renderTable(FINDING_COLUMNS, findings));
    ctx.io.out('');
    for (const f of findings.filter((x) => x.severity !== 'info')) {
      ctx.io.out(`${f.code}: ${f.fix}`);
    }
    ctx.io.out('');
    ctx.io.out(`${errors} error(s), ${warnings} warning(s), ${findings.length - errors - warnings} info.`);
  }
  if (failed) {
    ctx.io.err(
      `atlas: preflight failed (${errors} error(s)${failOn === 'warning' ? `, ${warnings} warning(s)` : ''}).`,
    );
    return 1;
  }
  return 0;
}

// ---- atlas env ----------------------------------------------------------------

const FORMATS = ['dotenv', 'coolify', 'vercel'] as const;
type EnvFormat = (typeof FORMATS)[number];

/** Public values, then each secret as a reference to its file — never the value. */
export async function envCommand(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const format = (str(args.values, 'format') ?? 'dotenv') as EnvFormat;
  if (!FORMATS.includes(format)) throw new CliError(`--format must be one of: ${FORMATS.join(', ')} (got '${format}').`);
  const product = str(args.values, 'product');
  if (!product) throw new CliError('atlas env needs --product <name> (the name you passed to atlas init).');
  const { manifest, instance } = projectInstance(ctx, args, product);

  const pub: Record<string, string> = {
    ATLAS_PUBLISHABLE_KEY: instance.publishable_key,
    ATLAS_API_URL: manifest.api_url,
  };
  if (instance.frontend_api_host) pub.ATLAS_FRONTEND_API = `https://${instance.frontend_api_host}`;
  if (instance.issuer) pub.ATLAS_ISSUER = instance.issuer;
  if (instance.discovery_url) pub.ATLAS_DISCOVERY_URL = instance.discovery_url;
  if (instance.jwks_uri) pub.ATLAS_JWKS_URI = instance.jwks_uri;
  if (instance.oauth_client) pub.ATLAS_CLIENT_ID = instance.oauth_client.client_id;

  const secrets: Array<{ key: string; file: string }> = [{ key: 'ATLAS_SECRET_KEY', file: instance.secret_file }];
  if (instance.oauth_client?.secret_file) secrets.push({ key: 'ATLAS_CLIENT_SECRET', file: instance.oauth_client.secret_file });
  if (instance.webhook?.secret_file) secrets.push({ key: 'ATLAS_WEBHOOK_SECRET', file: instance.webhook.secret_file });

  if (wantsJson(args.values)) {
    printJson(ctx.io, { product, environment: instance.environment, public: pub, secret_files: Object.fromEntries(secrets.map((s) => [s.key, s.file])) });
    return 0;
  }

  const out = (l: string) => ctx.io.out(l);
  if (format === 'dotenv') {
    out(`# ${product} (${instance.environment}): public values`);
    for (const [k, v] of Object.entries(pub)) out(`${k}=${v}`);
    out('# Secrets are not printed. Each *_FILE variable names the 0600 file that holds it.');
    for (const s of secrets) out(`${s.key}_FILE=${s.file}`);
  } else if (format === 'coolify') {
    out(`# ${product} (${instance.environment}): paste into Coolify → Environment Variables (Developer view).`);
    for (const [k, v] of Object.entries(pub)) out(`${k}=${v}`);
    out('# Secrets: copy each value from its file (mark them as secret in Coolify):');
    for (const s of secrets) out(`${s.key}=@${s.file}`);
  } else {
    out(`# ${product} (${instance.environment}): Vercel CLI commands. Secrets are piped from their files, never echoed.`);
    const target = instance.environment === 'production' ? 'production' : 'preview';
    for (const [k, v] of Object.entries(pub)) out(`printf '%s' '${v.replace(/'/g, "'\\''")}' | vercel env add ${k} ${target}`);
    for (const s of secrets) out(`sed -n 's/^${s.key}=//p' '${s.file}' | tr -d '\\n' | vercel env add ${s.key} ${target}`);
  }
  return 0;
}

// ---- atlas client rotate ----------------------------------------------------------

/** `atlas client rotate <id> [--now | --overlap <seconds>]` — the new secret goes straight to its file. */
export async function client(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  if (sub !== 'rotate') {
    throw new CliError(sub ? `Unknown subcommand 'client ${sub}'. Try: rotate.` : 'client needs a subcommand: rotate.');
  }
  const ref = requireArg(args.positionals, 2, 'client-id');
  const v = args.values;
  const overlapRaw = str(v, 'overlap');
  if (v.now === true && overlapRaw !== undefined) throw new CliError('Pass --now or --overlap, not both.');
  let overlapSeconds: number | undefined;
  if (v.now === true) overlapSeconds = 0;
  else if (overlapRaw !== undefined) {
    const n = Number(overlapRaw);
    if (!Number.isInteger(n) || n < 0) throw new CliError(`--overlap must be a whole number of seconds, got '${overlapRaw}'.`);
    overlapSeconds = n;
  }

  const cred = instanceCredential(ctx, args);
  const api = httpFor(ctx, cred);

  // Accept the internal id or the public client_id.
  let id = ref;
  if (ref.startsWith('client_')) {
    const rows = (await api.get<{ data?: Array<{ id: string; client_id: string }> }>('/v1/oauth_clients')).data ?? [];
    const match = rows.find((c) => c.client_id === ref);
    if (!match) throw new CliError(`No OAuth client with client_id ${ref} on this instance.`);
    id = match.id;
  }

  let res: { id: string; client_id: string; client_secret: string; previous_secret_expires_at?: number | null };
  try {
    res = await api.post(`/v1/oauth_clients/${id}/rotate_secret`, overlapSeconds === undefined ? {} : { overlap_seconds: overlapSeconds });
  } catch (err) {
    if (err instanceof AtlasApiError && err.status === 404) throw new CliError(`No OAuth client ${ref} on this instance.`);
    throw err;
  }

  const product = str(v, 'product') ?? cred.manifest?.product;
  const env = cred.instance?.environment;
  const fileName = product && env && cred.instance?.oauth_client?.id === res.id ? `${env}-oauth-client.env` : `oauth-client-${res.id}.env`;
  const entries = { ATLAS_CLIENT_ID: res.client_id, ATLAS_CLIENT_SECRET: res.client_secret };
  if (v['print-secret'] === true) {
    deliverSecret({ io: ctx.io, env: ctx.env, product: product ?? 'atlasauth', fileName, entries, label: 'The new client secret', printSecret: true });
  } else {
    // A rotation replaces the file by design: the old secret is the one being retired.
    const { path } = writeSecretFile(productDir(ctx.env, product ?? 'atlasauth'), fileName, entries, {
      force: true,
      comment: `OAuth client ${res.id}. Server-side only.`,
    });
    ctx.io.out(`New client secret for ${res.client_id} written to ${path} (mode 0600).`);
  }

  const expires = res.previous_secret_expires_at;
  if (overlapSeconds === 0 || expires === null) ctx.io.out('The previous secret stopped working immediately.');
  else if (typeof expires === 'number') ctx.io.out(`The previous secret keeps working until ${new Date(expires).toISOString()}.`);
  else ctx.io.out('The API did not say when the previous secret stops working; assume immediately and deploy the new one now.');
  return 0;
}

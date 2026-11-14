import { existsSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { str, type ParsedArgs } from '../args';
import type { ConfigHttp } from '../config-http';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import { httpFor } from '../project';
import { deserialize, type Format, type Json } from '../serialize';
import { loadCodeConfig } from './config';
import { envApiUrl, resolveAuth, wantsJson } from './shared';
import { emptyInput, renderTypes, type TypesInput } from './types-emit';

const DEFAULT_OUT = 'atlas-types.d.ts';
/** The OAuth scopes every instance serves besides its own catalogue. */
const BASE_SCOPES = ['email', 'offline_access', 'openid', 'profile'];
/** The roles every organization has. */
const SYSTEM_ORG_ROLES = ['org:admin', 'org:member'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

// ───────────────────────────── live instance ─────────────────────────────

/** A `{ data: [...] }` list. A truncated list is an error: a type built from half the keys would reject valid ones. */
async function rows(http: ConfigHttp, path: string): Promise<Obj[]> {
  const res = await http.get<{ data?: unknown; has_more?: boolean }>(path);
  if (res?.has_more === true) throw new CliError(`${path} has more entries than one page; the generator cannot read them all.`);
  return Array.isArray(res?.data) ? res.data.filter(isObj) : [];
}

/** Type names and relation names of one OpenFGA-style model (`type_definitions`). */
function fgaNames(model: unknown): { types: string[]; relations: string[] } {
  const defs = isObj(model) && Array.isArray(model.type_definitions) ? model.type_definitions.filter(isObj) : [];
  return {
    types: defs.map((d) => String(d.type ?? '')).filter(Boolean),
    relations: defs.flatMap((d) => (isObj(d.relations) ? Object.keys(d.relations) : [])),
  };
}

/** Read every source from the live instance. A source that fails is named in `failed` and left empty. */
export async function readLive(http: ConfigHttp): Promise<{ input: TypesInput; failed: string[] }> {
  const input = emptyInput();
  const failed: string[] = [];
  const source = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      failed.push(`${name} (${err instanceof Error ? err.message : String(err)})`);
    }
  };
  await Promise.all([
    source('permissions', async () => void input.permissions.push(...(await rows(http, '/v1/permissions')).map((r) => String(r.key ?? '')))),
    source('roles', async () => {
      for (const r of await rows(http, '/v1/roles')) {
        input.orgRoles.push(String(r.key ?? ''));
        input.permissions.push(...strings(r.permissions));
      }
    }),
    source('app roles', async () => {
      for (const r of await rows(http, '/v1/app_roles')) {
        input.appRoles.push(String(r.key ?? ''));
        input.appPermissions.push(...strings(r.permissions));
      }
    }),
    source('billing plans', async () => {
      for (const r of await rows(http, '/v1/billing/plans')) {
        input.plans.push(String(r.slug ?? ''));
        input.features.push(...strings(r.features));
      }
    }),
    source('scopes', async () => {
      input.scopes.push(...BASE_SCOPES, ...(await rows(http, '/v1/instance/scopes')).map((r) => String(r.name ?? '')));
    }),
    source('JWT templates', async () => {
      for (const r of await rows(http, '/v1/jwt_templates')) {
        input.jwtTemplates.push({ name: String(r.name ?? ''), claims: isObj(r.claims) ? Object.keys(r.claims) : [] });
      }
    }),
    source('metadata schema', async () => {
      const t = await http.get<{ schemas?: unknown }>('/v1/instance/user_traits_schema');
      for (const [target, schema] of Object.entries(isObj(t?.schemas) ? t.schemas : {})) if (isObj(schema)) input.traits[target] = schema;
    }),
    source('webhook events', async () => void input.webhookEvents.push(...(await rows(http, '/v1/webhook_event_schemas')).map((r) => String(r.type ?? '')))),
    source('app event types', async () => void input.appEvents.push(...(await rows(http, '/v1/app_event_types')).map((r) => String(r.type ?? '')))),
    source('audit events', async () => void input.auditEvents.push(...(await rows(http, '/v1/audit_event_schemas')).map((r) => String(r.action ?? '')))),
    source('authorization models', async () => {
      for (const store of await rows(http, '/v1/fga/stores')) {
        const id = encodeURIComponent(String(store.id ?? ''));
        const models = await rows(http, `/v1/fga/stores/${id}/authorization-models`);
        // The newest model is the one in force.
        const latest = [...models].sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))[0];
        if (!latest) continue;
        const full = await http.get<{ model?: unknown }>(`/v1/fga/stores/${id}/authorization-models/${encodeURIComponent(String(latest.id ?? ''))}`);
        const names = fgaNames(full?.model);
        input.fgaTypes.push(...names.types);
        input.fgaRelations.push(...names.relations);
      }
    }),
  ]);
  return { input, failed: failed.sort() };
}

// ───────────────────────────── atlas.yaml (offline) ─────────────────────────────

const TYPE_FILES = ['permissions', 'roles', 'billing_plans', 'scopes', 'jwt_templates', 'user_traits_schema'];

/** The sections of an atlas.yaml / atlas.json / atlas.config.* file, or of a config directory (one file per type). */
async function readConfigSections(ctx: RunContext, path: string): Promise<Obj> {
  if (!existsSync(path)) throw new CliError(`Config not found: ${path}.`);
  const parse = (file: string): unknown => {
    const ext = extname(file).toLowerCase();
    const format: Format = ext === '.yaml' || ext === '.yml' ? 'yaml' : 'json';
    return deserialize(ctx.readFile(file), format) as Json;
  };
  if (statSync(path).isDirectory()) {
    const out: Obj = {};
    for (const type of TYPE_FILES) {
      const file = ['json', 'yaml', 'yml'].map((e) => join(path, `${type}.${e}`)).find((f) => existsSync(f));
      if (file) out[type] = parse(file);
    }
    return out;
  }
  const ext = extname(path).toLowerCase();
  const doc = /^\.[cm]?[jt]s$/.test(ext) ? JSON.parse(JSON.stringify((await loadCodeConfig(path)) ?? null)) : parse(path);
  if (!isObj(doc)) throw new CliError(`${path} must be an object keyed by resource type.`);
  return doc;
}

export function inputFromConfig(sections: Obj): TypesInput {
  const input = emptyInput();
  const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
  input.orgRoles.push(...SYSTEM_ORG_ROLES);
  for (const p of list(sections.permissions)) input.permissions.push(String(p.key ?? ''));
  for (const r of list(sections.roles)) {
    input.orgRoles.push(String(r.key ?? ''));
    input.permissions.push(...strings(r.permissions));
  }
  for (const p of list(sections.billing_plans)) {
    input.plans.push(String(p.slug ?? ''));
    input.features.push(...strings(p.features));
  }
  input.scopes.push(...BASE_SCOPES, ...(isObj(sections.scopes) ? list(sections.scopes.scopes) : []).map((s) => String(s.name ?? '')));
  for (const t of list(sections.jwt_templates)) {
    input.jwtTemplates.push({ name: String(t.name ?? ''), claims: isObj(t.claims) ? Object.keys(t.claims) : [] });
  }
  const traits = isObj(sections.user_traits_schema) && isObj(sections.user_traits_schema.schemas) ? sections.user_traits_schema.schemas : {};
  for (const [target, schema] of Object.entries(traits)) if (isObj(schema)) input.traits[target] = schema;
  return input;
}

// ───────────────────────────── the command ─────────────────────────────

/**
 * `atlas types generate [--out <file>] [--check] [--from-config <file|dir>] [--lang ts]`:
 * write a TypeScript declaration file that registers your instance's keys with the SDKs.
 * Read-only against the instance; `--check` writes nothing and exits 1 when the file is stale.
 */
export async function types(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const v = args.values;
  const sub = args.positionals[1];
  if (sub !== 'generate') throw new CliError(sub ? `Unknown subcommand 'types ${sub}'. Try: generate.` : 'types needs a subcommand: generate.');
  const lang = str(v, 'lang') ?? 'ts';
  if (lang !== 'ts') throw new CliError(`--lang ${lang} is not supported: only 'ts' (TypeScript) is generated.`);
  const out = str(v, 'out') ?? DEFAULT_OUT;
  const check = v.check === true;

  let input: TypesInput;
  let label: string;
  const failed: string[] = [];
  const fromConfig = str(v, 'from-config');
  if (fromConfig) {
    input = inputFromConfig(await readConfigSections(ctx, fromConfig));
    label = 'atlas config file';
  } else {
    const auth = resolveAuth(ctx, v);
    const http = httpFor(ctx, { secretKey: auth.secretKey, apiUrl: envApiUrl(ctx.env) ?? auth.apiUrl });
    const live = await readLive(http);
    input = live.input;
    failed.push(...live.failed);
    label = 'live instance';
  }
  if (failed.length && check) {
    throw new CliError(`Could not read: ${failed.join('; ')}. A check against a partial read would be wrong, so nothing was compared.`);
  }
  for (const f of failed) ctx.io.err(`atlas: could not read ${f}; those types stay 'string'.`);

  const text = renderTypes(input, label);
  let current: string | null = null;
  try {
    current = ctx.readFile(out);
  } catch {
    current = null;
  }

  if (check) {
    const ok = current === text;
    if (wantsJson(v)) printJson(ctx.io, { out, up_to_date: ok });
    else if (ok) ctx.io.out(`${out} is up to date.`);
    else ctx.io.err(`atlas: ${out} ${current === null ? 'does not exist' : 'is out of date'}. Run 'atlas types generate' and commit it.`);
    return ok ? 0 : 1;
  }

  if (current !== text) writeFileSync(out, text);
  if (wantsJson(v)) printJson(ctx.io, { out, written: current !== text, unreadable: failed });
  else ctx.io.out(current === text ? `${out} is already up to date.` : `Wrote ${out}. Add it to your tsconfig "include" so the SDKs pick up the types.`);
  return 0;
}

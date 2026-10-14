import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { str, type ParsedArgs, type Values } from '../args';
import { createConfigHttp, isNotFound, type ConfigHttp } from '../config-http';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import {
  canonicalize,
  deepEqual,
  deserialize,
  serialize,
  type Format,
  type Json,
} from '../serialize';
import { resolveAuth } from './shared';

// ───────────────────────────── resource model ─────────────────────────────

/** A config document ready for disk / comparison: a plain, redacted JSON value. */
type Config = Json;

/** One live resource: its natural key, its redacted projection, and its API id. */
interface LiveEntry {
  key: string;
  config: Config;
  /** The server id/name used to address an update or delete. */
  id: string;
}

/**
 * A collection resource — many instances addressed by a natural key (a name, a
 * slug, a url). The engine lists live entries, matches them to the desired file
 * by key, and applies the create / update / delete the diff implies.
 */
interface CollectionSpec {
  kind: 'collection';
  type: string;
  /** Natural key of a desired config read from a file (must match LiveEntry.key). */
  keyOf(config: Config): string;
  fetchLive(http: ConfigHttp): Promise<LiveEntry[]>;
  create(http: ConfigHttp, config: Config): Promise<void>;
  /** Apply an update to an existing resource; omit when the resource is immutable. */
  update?(http: ConfigHttp, live: LiveEntry, config: Config): Promise<void>;
  /** Delete an existing resource (only ever called under `--prune`); omit when unsupported. */
  remove?(http: ConfigHttp, live: LiveEntry): Promise<void>;
}

/** A singleton resource — exactly one document per instance (the instance config, a schema). */
interface SingletonSpec {
  kind: 'singleton';
  type: string;
  /** The current document, or null when none is set (a 404). */
  fetchLive(http: ConfigHttp): Promise<Config | null>;
  apply(http: ConfigHttp, config: Config): Promise<void>;
}

type ResourceSpec = CollectionSpec | SingletonSpec;

// ───────────────────────────── small helpers ─────────────────────────────

/** GET a `{ data: [...] }` list envelope, tolerating an absent/garbled body. */
async function listData<T>(http: ConfigHttp, path: string): Promise<T[]> {
  const res = await http.get<{ data?: T[] }>(path);
  return Array.isArray(res?.data) ? res.data : [];
}

/** Build a config object from a row, keeping only the named keys and dropping null/undefined. */
function pick<T extends Record<string, unknown>>(row: T, keys: readonly string[]): Config {
  const out: Record<string, Json> = {};
  for (const k of keys) {
    const v = row[k];
    if (v === null || v === undefined) continue;
    out[k] = v as Json;
  }
  return out;
}

/** The write body for a create/update: strip null/undefined so the API never sees them. */
function compact(config: Config): Record<string, Json> {
  const out: Record<string, Json> = {};
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    for (const [k, v] of Object.entries(config)) {
      if (v === null || v === undefined) continue;
      out[k] = v;
    }
  }
  return out;
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

// ───────────────────────────── the registry ─────────────────────────────

/**
 * The single source of truth for what `atlas config` round-trips — the same
 * resource set the Terraform provider manages. Each entry maps a resource type
 * to its list/create/update/delete endpoints and its redacted projection.
 * SECRETS ARE NEVER PART OF A PROJECTION: the management API never returns them
 * on a read, so they never reach disk; a credential that must be (re)written is
 * supplied at import time via a `${ENV_VAR}` placeholder in the file.
 */
function registry(): ResourceSpec[] {
  const specs: ResourceSpec[] = [
    // 1. Instance config (auth_config + allowed origins) — the §9.3 singleton.
    {
      kind: 'singleton',
      type: 'instance',
      async fetchLive(http) {
        const inst = await http.get<{ allowed_origins?: Json; auth_config?: Json }>('/v1/instance');
        return {
          allowed_origins: inst.allowed_origins ?? [],
          auth_config: inst.auth_config ?? {},
        };
      },
      async apply(http, config) {
        const c = compact(config);
        await http.patch('/v1/instance', {
          allowed_origins: c.allowed_origins ?? [],
          auth_config: c.auth_config ?? {},
        });
      },
    },

    // 2. Org settings schema (P1-5) — a singleton JSON Schema; 404 when unset.
    {
      kind: 'singleton',
      type: 'org_settings_schema',
      async fetchLive(http) {
        try {
          const s = await http.get<{ schema?: Json }>('/v1/organization_settings_schema');
          return { schema: s.schema ?? {} };
        } catch (err) {
          if (isNotFound(err)) return null;
          throw err;
        }
      },
      async apply(http, config) {
        const c = compact(config);
        await http.put('/v1/organization_settings_schema', { schema: c.schema ?? {} });
      },
    },

    // 3. Redirect URL allowlist — key = the (normalised) url; immutable, so no update.
    {
      kind: 'collection',
      type: 'redirect_urls',
      keyOf: (c) => String(obj(c).url ?? ''),
      async fetchLive(http) {
        const rows = await listData<{ id: string; url: string }>(http, '/v1/redirect_urls');
        return rows.map((r) => ({ key: r.url, id: r.id, config: pick(r, ['url']) }));
      },
      async create(http, config) {
        await http.post('/v1/redirect_urls', { url: obj(config).url });
      },
      async remove(http, live) {
        await http.delete(`/v1/redirect_urls/${enc(live.id)}`);
      },
    },

    // 4. OAuth clients (first-party / M2M apps) — key = name.
    {
      kind: 'collection',
      type: 'oauth_clients',
      keyOf: (c) => String(obj(c).name ?? ''),
      async fetchLive(http) {
        const rows = await listData<Record<string, unknown>>(http, '/v1/oauth_clients');
        return rows.map((r) => ({
          key: String(r.name ?? ''),
          id: String(r.id ?? ''),
          config: pick(r, OAUTH_CLIENT_KEYS),
        }));
      },
      async create(http, config) {
        await http.post('/v1/oauth_clients', compact(config));
      },
      async update(http, live, config) {
        await http.patch(`/v1/oauth_clients/${enc(live.id)}`, compact(config));
      },
      async remove(http, live) {
        await http.delete(`/v1/oauth_clients/${enc(live.id)}`);
      },
    },

    // 5. Social / enterprise OAuth providers — key = the catalog provider slug.
    {
      kind: 'collection',
      type: 'oauth_providers',
      keyOf: (c) => String(obj(c).provider ?? ''),
      async fetchLive(http) {
        const rows = await listData<Record<string, unknown>>(http, '/v1/oauth_providers');
        return rows
          .filter((r) => r.configured === true)
          .map((r) => ({
            key: String(r.provider ?? ''),
            id: String(r.provider ?? ''),
            config: pick(r, OAUTH_PROVIDER_KEYS),
          }));
      },
      create: putProvider,
      update: (http, _live, config) => putProvider(http, config),
      async remove(http, live) {
        await http.delete(`/v1/oauth_providers/${enc(live.id)}`);
      },
    },

    // 6. Resource servers (API audiences) — key = identifier.
    {
      kind: 'collection',
      type: 'resource_servers',
      keyOf: (c) => String(obj(c).identifier ?? ''),
      async fetchLive(http) {
        const rows = await listData<Record<string, unknown>>(http, '/v1/resource_servers');
        return rows.map((r) => ({
          key: String(r.identifier ?? ''),
          id: String(r.id ?? ''),
          config: pick(r, RESOURCE_SERVER_KEYS),
        }));
      },
      async create(http, config) {
        await http.post('/v1/resource_servers', compact(config));
      },
      async update(http, live, config) {
        const body = compact(config);
        delete body.identifier; // immutable
        await http.patch(`/v1/resource_servers/${enc(live.id)}`, body);
      },
      async remove(http, live) {
        await http.delete(`/v1/resource_servers/${enc(live.id)}`);
      },
    },

    // 7. JWT templates — key = name; claims is a flat template map.
    {
      kind: 'collection',
      type: 'jwt_templates',
      keyOf: (c) => String(obj(c).name ?? ''),
      async fetchLive(http) {
        const rows = await listData<{ name: string; claims: Json }>(http, '/v1/jwt_templates');
        return rows.map((r) => ({
          key: r.name,
          id: r.name,
          config: { name: r.name, claims: r.claims ?? {} },
        }));
      },
      async create(http, config) {
        const c = obj(config);
        await http.post('/v1/jwt_templates', { name: c.name, claims: c.claims ?? {} });
      },
      async update(http, live, config) {
        await http.patch(`/v1/jwt_templates/${enc(live.id)}`, { claims: obj(config).claims ?? {} });
      },
      async remove(http, live) {
        await http.delete(`/v1/jwt_templates/${enc(live.id)}`);
      },
    },

    // 8. Roles — key = key; label via PATCH, permission set via PUT. System roles skipped.
    {
      kind: 'collection',
      type: 'roles',
      keyOf: (c) => String(obj(c).key ?? ''),
      async fetchLive(http) {
        const rows = await listData<Record<string, unknown>>(http, '/v1/roles');
        return rows
          .filter((r) => r.is_system !== true)
          .map((r) => ({
            key: String(r.key ?? ''),
            id: String(r.id ?? ''),
            config: pick(r, ROLE_KEYS),
          }));
      },
      async create(http, config) {
        await http.post('/v1/roles', compact(config));
      },
      async update(http, live, config) {
        const c = obj(config);
        await http.patch(`/v1/roles/${enc(live.id)}`, {
          name: c.name,
          description: c.description ?? null,
        });
        await http.put(`/v1/roles/${enc(live.id)}/permissions`, {
          permissions: Array.isArray(c.permissions) ? c.permissions : [],
        });
      },
      async remove(http, live) {
        await http.delete(`/v1/roles/${enc(live.id)}`);
      },
    },

    // 9. Webhook endpoints — key = url.
    {
      kind: 'collection',
      type: 'webhook_endpoints',
      keyOf: (c) => String(obj(c).url ?? ''),
      async fetchLive(http) {
        const rows = await listData<Record<string, unknown>>(http, '/v1/webhook_endpoints');
        return rows.map((r) => ({
          key: String(r.url ?? ''),
          id: String(r.id ?? ''),
          config: pick(r, WEBHOOK_KEYS),
        }));
      },
      async create(http, config) {
        const c = obj(config);
        await http.post('/v1/webhook_endpoints', {
          url: c.url,
          enabled_events: c.enabled_events ?? [],
        });
      },
      async update(http, live, config) {
        await http.patch(`/v1/webhook_endpoints/${enc(live.id)}`, compact(config));
      },
      async remove(http, live) {
        await http.delete(`/v1/webhook_endpoints/${enc(live.id)}`);
      },
    },

    // 10. SSO connections — key = a stable identifier derived from the connection.
    {
      kind: 'collection',
      type: 'sso_connections',
      keyOf: ssoKey,
      async fetchLive(http) {
        const rows = await listData<Record<string, unknown>>(http, '/v1/sso_connections');
        return rows.map((r) => {
          const config = pick(r, SSO_KEYS);
          return { key: ssoKey(config), id: String(r.id ?? ''), config };
        });
      },
      async create(http, config) {
        await http.post('/v1/sso_connections', compact(config));
      },
      async update(http, live, config) {
        await http.patch(`/v1/sso_connections/${enc(live.id)}`, compact(config));
      },
      async remove(http, live) {
        await http.delete(`/v1/sso_connections/${enc(live.id)}`);
      },
    },

    // 11. Billing plans — key = slug.
    {
      kind: 'collection',
      type: 'billing_plans',
      keyOf: (c) => String(obj(c).slug ?? ''),
      async fetchLive(http) {
        const rows = await listData<Record<string, unknown>>(http, '/v1/billing/plans');
        return rows.map((r) => ({
          key: String(r.slug ?? ''),
          id: String(r.id ?? ''),
          config: pick(r, BILLING_KEYS),
        }));
      },
      async create(http, config) {
        await http.post('/v1/billing/plans', compact(config));
      },
      async update(http, live, config) {
        const body = compact(config);
        delete body.slug; // immutable
        await http.patch(`/v1/billing/plans/${enc(live.id)}`, body);
      },
      async remove(http, live) {
        await http.delete(`/v1/billing/plans/${enc(live.id)}`);
      },
    },

    // 12. Notification templates (P2-12) — key = name; replace via PUT.
    {
      kind: 'collection',
      type: 'notification_templates',
      keyOf: (c) => String(obj(c).name ?? ''),
      async fetchLive(http) {
        const rows = await listData<Record<string, unknown>>(http, '/v1/notification_templates');
        return rows.map((r) => ({
          key: String(r.name ?? ''),
          id: String(r.name ?? ''),
          config: pick(r, NOTIFICATION_KEYS),
        }));
      },
      async create(http, config) {
        await http.post('/v1/notification_templates', compact(config));
      },
      async update(http, live, config) {
        const body = compact(config);
        delete body.name; // the name is the URL key
        await http.put(`/v1/notification_templates/${enc(live.id)}`, body);
      },
      async remove(http, live) {
        await http.delete(`/v1/notification_templates/${enc(live.id)}`);
      },
    },

    // 13. Email templates (§11.1) — key = name; only the CUSTOMISED overrides are config.
    {
      kind: 'collection',
      type: 'email_templates',
      keyOf: (c) => String(obj(c).name ?? ''),
      async fetchLive(http) {
        const rows = await listData<{
          name: string;
          customised?: boolean;
          override?: { subject?: string; text?: string } | null;
        }>(http, '/v1/email_templates');
        return rows
          .filter((r) => r.customised && r.override)
          .map((r) => ({
            key: r.name,
            id: r.name,
            config: pick({ name: r.name, ...(r.override ?? {}) }, EMAIL_KEYS),
          }));
      },
      async create(http, config) {
        await putEmail(http, config);
      },
      async update(http, _live, config) {
        await putEmail(http, config);
      },
      async remove(http, live) {
        await http.delete(`/v1/email_templates/${enc(live.id)}`);
      },
    },

    // 14. Organization policies — key = organization_id; attaches to existing orgs.
    {
      kind: 'collection',
      type: 'organization_policies',
      keyOf: (c) => String(obj(c).organization_id ?? ''),
      async fetchLive(http) {
        const orgs = await listData<{ id: string }>(http, '/v1/organizations');
        const out: LiveEntry[] = [];
        for (const org of orgs) {
          // There is no GET for org policy; an empty PATCH returns it unchanged.
          const res = await http.patch<{ policy?: Record<string, unknown> }>(
            `/v1/organizations/${enc(org.id)}/policy`,
            {},
          );
          const policy = res?.policy ?? {};
          const config = pick({ organization_id: org.id, ...policy }, ORG_POLICY_KEYS);
          // Only orgs with a real (non-default) policy are config.
          if (Object.keys(obj(config)).length > 1) {
            out.push({ key: org.id, id: org.id, config });
          }
        }
        return out;
      },
      async create(http, config) {
        await patchOrgPolicy(http, config);
      },
      async update(http, _live, config) {
        await patchOrgPolicy(http, config);
      },
      // No delete: pruning a policy would silently loosen an org's security, so
      // org policies are never deleted by import (reported as skipped).
    },
  ];
  return specs;
}

const OAUTH_CLIENT_KEYS = [
  'name',
  'redirect_uris',
  'allowed_scopes',
  'grant_types',
  'token_endpoint_auth_method',
  'logo_url',
  'first_party',
] as const;
const OAUTH_PROVIDER_KEYS = [
  'provider',
  'enabled',
  'allow_sign_in',
  'allow_sign_up',
  'scopes',
  'client_id',
] as const;
const RESOURCE_SERVER_KEYS = [
  'identifier',
  'name',
  'scopes',
  'token_ttl_seconds',
  'signing_alg',
] as const;
const ROLE_KEYS = ['key', 'name', 'description', 'permissions'] as const;
const WEBHOOK_KEYS = ['url', 'enabled_events', 'active'] as const;
const SSO_KEYS = [
  'type',
  'status',
  'organization_id',
  'oidc_issuer',
  'oidc_client_id',
  'saml_idp_entity_id',
  'saml_idp_sso_url',
  'saml_sp_entity_id',
  'saml_allow_idp_initiated',
  'saml_sign_authn_requests',
  'saml_want_response_signed',
  'discourse_provider_url',
  'allowed_domains',
  'claim_role_mappings',
  'default_role_id',
] as const;
const BILLING_KEYS = [
  'name',
  'slug',
  'stripe_price_id',
  'interval',
  'amount',
  'currency',
  'features',
  'limits',
  'audience',
  'active',
  'pricing_model',
  'trial_days',
  'stripe_meter_id',
  'usage_unit',
] as const;
const NOTIFICATION_KEYS = ['name', 'subject', 'body', 'category'] as const;
const EMAIL_KEYS = ['name', 'subject', 'text'] as const;
const ORG_POLICY_KEYS = [
  'organization_id',
  'requireMfa',
  'ssoRequired',
  'sessionIdleOverrideMs',
  'allowedSignInMethods',
  'ipAllowlist',
  'maxSessionAgeSeconds',
] as const;

/** Narrow a Config to a plain string-keyed record for field access. */
function obj(config: Config): Record<string, Json> {
  return config && typeof config === 'object' && !Array.isArray(config)
    ? (config as Record<string, Json>)
    : {};
}

/** A stable natural key for an SSO connection, which has no name field. */
function ssoKey(config: Config): string {
  const c = obj(config);
  const type = String(c.type ?? 'sso');
  const id =
    c.oidc_issuer ?? c.saml_idp_entity_id ?? c.saml_sp_entity_id ?? c.discourse_provider_url ?? '';
  return `${type}:${String(id)}`;
}

/** Configure an OAuth provider: credentials/scopes (PUT), then scope + enabled toggles. */
async function putProvider(http: ConfigHttp, config: Config): Promise<void> {
  const c = obj(config);
  const values: Record<string, Json> = {};
  if (c.client_id !== undefined && c.client_id !== null) values.client_id = c.client_id;
  // A secret only exists here when the file carried a ${ENV} placeholder for it.
  if (c.client_secret !== undefined && c.client_secret !== null) {
    values.client_secret = c.client_secret;
  }
  const body: Record<string, Json> = {};
  if (Object.keys(values).length) body.values = values;
  if (Array.isArray(c.scopes)) body.scopes = c.scopes;
  const provider = String(c.provider ?? '');
  if (Object.keys(body).length) {
    await http.put(`/v1/oauth_providers/${enc(provider)}`, body);
  }
  if (c.allow_sign_in !== undefined || c.allow_sign_up !== undefined) {
    await http.post(`/v1/oauth_providers/${enc(provider)}/scope`, {
      allow_sign_in: c.allow_sign_in ?? true,
      allow_sign_up: c.allow_sign_up ?? true,
    });
  }
  if (c.enabled !== undefined) {
    await http.post(`/v1/oauth_providers/${enc(provider)}/enabled`, { enabled: c.enabled });
  }
}

async function putEmail(http: ConfigHttp, config: Config): Promise<void> {
  const c = obj(config);
  const body: Record<string, Json> = {};
  if (c.subject !== undefined) body.subject = c.subject;
  if (c.text !== undefined) body.text = c.text;
  await http.put(`/v1/email_templates/${enc(String(c.name ?? ''))}`, body);
}

async function patchOrgPolicy(http: ConfigHttp, config: Config): Promise<void> {
  const c = obj(config);
  const body: Record<string, Json> = {};
  for (const k of ORG_POLICY_KEYS) {
    if (k === 'organization_id') continue;
    if (c[k] !== undefined && c[k] !== null) body[k] = c[k];
  }
  await http.patch(`/v1/organizations/${enc(String(c.organization_id ?? ''))}/policy`, body);
}

// ───────────────────────────── the command ─────────────────────────────

/** `atlas config export|import` — Auth0 `deploy-cli`-style config-as-code. */
export async function config(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  switch (sub) {
    case 'export':
      return exportConfig(ctx, args.values);
    case 'import':
      return importConfig(ctx, args.values);
    default:
      throw new CliError(
        sub
          ? `Unknown subcommand 'config ${sub}'. Try: export, import.`
          : 'config needs a subcommand: export, import.',
      );
  }
}

function resolveFormat(values: Values): Format {
  const raw = str(values, 'format');
  if (raw === undefined) return 'json';
  if (raw !== 'json' && raw !== 'yaml') {
    throw new CliError(`--format must be 'json' or 'yaml', got '${raw}'.`);
  }
  return raw;
}

function resolveDir(values: Values): string {
  return str(values, 'dir') || './atlas-config';
}

/** Build the config HTTP client from the resolved profile credential. */
function requireHttp(ctx: RunContext, values: Values): ConfigHttp {
  const auth = resolveAuth(ctx, values);
  const make = ctx.makeHttp ?? createConfigHttp;
  return make({ secretKey: auth.secretKey, apiUrl: auth.apiUrl });
}

async function exportConfig(ctx: RunContext, values: Values): Promise<number> {
  const http = requireHttp(ctx, values);
  const dir = resolveDir(values);
  const format = resolveFormat(values);
  const ext = format === 'json' ? 'json' : 'yaml';

  mkdirSync(dir, { recursive: true });
  let fileCount = 0;

  for (const spec of registry()) {
    if (spec.kind === 'singleton') {
      const live = await spec.fetchLive(http);
      if (live === null) continue; // nothing to write (e.g. no schema registered)
      writeFileSync(join(dir, `${spec.type}.${ext}`), serialize(live, format));
      fileCount += 1;
    } else {
      const entries = await spec.fetchLive(http);
      // Deterministic: entries sorted by natural key, keys sorted inside each.
      const sorted = [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const doc = sorted.map((e) => canonicalize(e.config));
      writeFileSync(join(dir, `${spec.type}.${ext}`), serialize(doc, format));
      fileCount += 1;
    }
  }

  ctx.io.out(`Exported ${fileCount} resource file(s) to ${dir} (${format}).`);
  ctx.io.out('Secrets are never exported — supply any credential at import via a ${ENV} placeholder.');
  return 0;
}

interface Change {
  type: string;
  action: 'create' | 'update' | 'delete';
  key: string;
}

async function importConfig(ctx: RunContext, values: Values): Promise<number> {
  const http = requireHttp(ctx, values);
  const dir = resolveDir(values);
  const format = resolveFormat(values);
  const ext = format === 'json' ? 'json' : 'yaml';
  const dryRun = values['dry-run'] === true;
  const prune = values.prune === true;

  if (!existsSync(dir)) {
    throw new CliError(`Config directory not found: ${dir}. Run 'atlas config export' first.`);
  }
  const present = new Set(readdirSync(dir));

  const changes: Change[] = [];
  const applications: Array<() => Promise<void>> = [];
  let unchanged = 0;
  const skippedDeletes: Change[] = [];

  for (const spec of registry()) {
    const file = `${spec.type}.${ext}`;
    // A type with no file is simply NOT MANAGED — leave live untouched.
    if (!present.has(file)) continue;
    const text = readFileSync(join(dir, file), 'utf8');
    const parsed = interpolate(deserialize(text, format), ctx.env);

    if (spec.kind === 'singleton') {
      const desired = parsed;
      const live = await spec.fetchLive(http);
      if (live !== null && deepEqual(desired, live)) {
        unchanged += 1;
        continue;
      }
      changes.push({ type: spec.type, action: live === null ? 'create' : 'update', key: '' });
      applications.push(() => spec.apply(http, desired));
      continue;
    }

    // Collection: diff desired-by-key against live-by-key.
    const desiredList = asArray(parsed);
    const desiredByKey = new Map<string, Config>();
    for (const cfg of desiredList) desiredByKey.set(spec.keyOf(cfg), cfg);
    const live = await spec.fetchLive(http);
    const liveByKey = new Map(live.map((e) => [e.key, e]));

    for (const [key, cfg] of desiredByKey) {
      const existing = liveByKey.get(key);
      if (!existing) {
        changes.push({ type: spec.type, action: 'create', key });
        applications.push(() => spec.create(http, cfg));
      } else if (!deepEqual(cfg, existing.config)) {
        if (!spec.update) {
          throw new CliError(
            `${spec.type} '${key}' changed but is immutable; recreate it instead.`,
          );
        }
        const upd = spec.update;
        changes.push({ type: spec.type, action: 'update', key });
        applications.push(() => upd(http, existing, cfg));
      } else {
        unchanged += 1;
      }
    }

    for (const entry of live) {
      if (desiredByKey.has(entry.key)) continue;
      const change: Change = { type: spec.type, action: 'delete', key: entry.key };
      if (!spec.remove) {
        skippedDeletes.push(change);
        continue;
      }
      if (prune) {
        const rm = spec.remove;
        changes.push(change);
        applications.push(() => rm(http, entry));
      } else {
        skippedDeletes.push(change);
      }
    }
  }

  printPlan(ctx, changes, unchanged, skippedDeletes, { dryRun, prune });

  if (dryRun) return 0;
  for (const apply of applications) await apply();
  if (changes.length) ctx.io.out(`Applied ${changes.length} change(s).`);
  else ctx.io.out('No changes to apply.');
  return 0;
}

function printPlan(
  ctx: RunContext,
  changes: Change[],
  unchanged: number,
  skippedDeletes: Change[],
  opts: { dryRun: boolean; prune: boolean },
): void {
  const heading = opts.dryRun ? 'Plan (dry run — nothing applied):' : 'Plan:';
  ctx.io.out(heading);
  if (changes.length === 0) {
    ctx.io.out('  (no changes)');
  }
  const sign = { create: '+', update: '~', delete: '-' } as const;
  for (const c of [...changes].sort(sortChange)) {
    const label = c.key ? `${c.type} ${c.key}` : c.type;
    ctx.io.out(`  ${sign[c.action]} ${c.action} ${label}`);
  }
  if (!opts.prune && skippedDeletes.length) {
    ctx.io.out(
      `  ${skippedDeletes.length} resource(s) exist live but not in config — pass --prune to delete.`,
    );
  }
  ctx.io.out(`  ${unchanged} unchanged.`);
}

function sortChange(a: Change, b: Change): number {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  if (a.action !== b.action) return a.action < b.action ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function asArray(value: Json): Config[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Replace `${ENV_VAR}` placeholders inside any string with the environment's
 * value — the one sanctioned way a secret enters an import without ever living
 * on disk. An unset variable is left verbatim so the plan surfaces it rather
 * than silently blanking a credential.
 */
function interpolate(value: Json, env: NodeJS.ProcessEnv): Json {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name: string) => env[name] ?? match);
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env));
  if (value !== null && typeof value === 'object') {
    const out: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, env);
    return out;
  }
  return value;
}

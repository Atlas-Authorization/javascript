import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { AtlasApiError, DEFAULT_API_URL } from '@atlasauth/backend';
import { envApiUrl, resolveAuth } from './shared';
import { parseDotenv, productDir, writeSecretFile } from '../secrets';

// ───────────────────────────── resource model ─────────────────────────────

/** A config document ready for disk / comparison: a plain, redacted JSON value. */
type Config = Json;

/** One live resource: its natural key, its redacted projection, and its API id. */
interface LiveEntry {
  key: string;
  config: Config;
  /** The server id/name used to address an update or delete. */
  id: string;
  /** Owned by a connected platform (its id): listed apart, never diffed, pruned or exported. */
  managedBy?: string;
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
  apply(http: ConfigHttp, config: Config, opts: ApplyOpts): Promise<void>;
  /**
   * Bring the live and the desired document to one comparable (and printable)
   * shape: both forms of an origin list, a secret shown as "(secret set)". Only
   * the comparison and the plan output use it; apply always sends the file as written.
   */
  normalize?(config: Config): Config;
}

/** Flags that reach a singleton's apply. */
interface ApplyOpts {
  /** Enable a hook even when its test call fails (`?force=true`). */
  forceHook: boolean;
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

/**
 * The write body: strip null/undefined. On a PATCH (`keepNull`) an explicit file
 * `null` is kept so it clears a nullable field; an absent key stays unmanaged.
 */
function compact(config: Config, keepNull = false): Record<string, Json> {
  const out: Record<string, Json> = {};
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    for (const [k, v] of Object.entries(config)) {
      if (v === undefined || (v === null && !keepNull)) continue;
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
    // 0. Email provider — first, because email sign-in strategies need one. Secrets
    //    (api_key, …) are write-only: the live side shows "(secret set)", never a value.
    {
      kind: 'singleton',
      type: 'email_provider',
      async fetchLive(http) {
        let p: Record<string, unknown>;
        try {
          p = await http.get<Record<string, unknown>>('/v1/messaging_providers/email');
        } catch (err) {
          if (isNotFound(err)) return null;
          throw err;
        }
        if (!p || p.configured === false) return null;
        const config: Record<string, Json> = { ...obj((p.config ?? null) as Json) };
        const set = obj((p.secrets_set ?? null) as Json);
        const names = Array.isArray(p.secrets_set) ? (p.secrets_set as string[]) : Object.keys(set).filter((k) => set[k] === true);
        for (const k of names) config[k] = SECRET_SET;
        return pick({ ...p, config }, ['transport', 'from_address', 'config']);
      },
      async apply(http, config) {
        await http.put('/v1/messaging_providers/email', compact(withoutMarkers(config)));
      },
      normalize: (c) => redactSecrets(c, ['config']),
    },

    // 1. Instance config (auth_config + allowed origins) — the §9.3 singleton.
    {
      kind: 'singleton',
      type: 'instance',
      async fetchLive(http) {
        const inst = await http.get<{ allowed_origins?: Json; allowed_origin_integrations?: Json; auth_config?: Json }>('/v1/instance');
        const hints = obj(inst.allowed_origin_integrations ?? null);
        const origins = originStrings(inst.allowed_origins ?? []).map((o): Json => (hints[o] ? { origin: o, integration: hints[o]! } : o));
        return { allowed_origins: origins, auth_config: stripOriginIntegrations(inst.auth_config ?? {}) };
      },
      async apply(http, config) {
        const c = compact(config);
        // Integration hints live in auth_config.originIntegrations server-side and a
        // write replaces auth_config, so carry the live hints over for any origin the
        // file names as a plain string (the plan ignores hints the file does not set).
        const live = await http.get<{ allowed_origin_integrations?: Json; auth_config?: Json }>('/v1/instance');
        const liveHints = obj(live.allowed_origin_integrations ?? null);
        const authConfig: Record<string, Json> = stripOriginIntegrations(c.auth_config ?? {});
        const body: Record<string, Json> = { auth_config: authConfig };
        if (c.allowed_origins !== undefined) {
          // A file without allowed_origins leaves the live origins alone (a partial
          // document, e.g. one produced by `atlas migrate better-auth config`).
          body.allowed_origins = (Array.isArray(c.allowed_origins) ? c.allowed_origins : []).map((e): Json =>
            typeof e === 'string' && liveHints[e] ? { origin: e, integration: liveHints[e]! } : e,
          );
        } else {
          const kept = obj(live.auth_config ?? null).originIntegrations;
          if (kept !== undefined) authConfig.originIntegrations = kept;
        }
        await http.patch('/v1/instance', body);
      },
      normalize(c) {
        const d = obj(c);
        const hints: Record<string, Json> = {};
        for (const e of Array.isArray(d.allowed_origins) ? d.allowed_origins : []) {
          const o = obj(e);
          if (o.integration) hints[String(o.origin)] = o.integration;
        }
        const out: Record<string, Json> = {};
        if (d.allowed_origins !== undefined) out.allowed_origins = originStrings(d.allowed_origins);
        if (Object.keys(hints).length) out.allowed_origin_integrations = hints;
        if (d.auth_config !== undefined) out.auth_config = stripOriginIntegrations(d.auth_config);
        return out;
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
        await http.patch(`/v1/oauth_clients/${enc(live.id)}`, compact(config, true));
      },
      async remove(http, live) {
        await http.delete(`/v1/oauth_clients/${enc(live.id)}`);
      },
    },

    // 4b. Hooks — after the clients. before_user_create: url, timeout_ms, fail_closed,
    //     enabled; the signing secret is write-only ("(secret set)").
    {
      kind: 'singleton',
      type: 'hooks',
      async fetchLive(http) {
        let h: Record<string, unknown>;
        try {
          h = await http.get<Record<string, unknown>>('/v1/instance/hooks/before_user_create');
        } catch (err) {
          if (isNotFound(err)) return null;
          throw err;
        }
        if (!h || (h.url == null && h.enabled !== true)) return null;
        const bu = pick(h, ['url', 'timeout_ms', 'fail_closed', 'enabled']) as Record<string, Json>;
        if (h.signing_secret_set === true) bu.signing_secret = SECRET_SET;
        return { before_user_create: bu };
      },
      async apply(http, config, opts) {
        const bu = compact(obj(withoutMarkers(config)).before_user_create ?? {}, true);
        if (Object.keys(bu).length === 0) return;
        try {
          await http.patch(`/v1/instance/hooks/before_user_create${opts.forceHook ? '?force=true' : ''}`, bu);
        } catch (err) {
          const refused = err instanceof AtlasApiError && err.status === 409 ? err.errors.find((e) => e.code === 'HOOK_TEST_FAILED') : undefined;
          if (refused) {
            throw new CliError(
              `hooks.before_user_create: the change was refused because the hook test call failed (HOOK_TEST_FAILED): ${refused.message} ` +
                'The hook was left as it was. Deploy the route, or pass --force-hook to apply it anyway.',
            );
          }
          throw err;
        }
      },
      normalize: (c) => redactSecrets(c, ['before_user_create']),
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

    // 5b. Custom (generic) OAuth 2.0 / OIDC login providers — key = provider_key.
    {
      kind: 'collection',
      type: 'custom_oauth_providers',
      keyOf: (c) => String(obj(c).provider_key ?? ''),
      async fetchLive(http) {
        const rows = await listData<Record<string, unknown>>(http, '/v1/custom_oauth_providers');
        return rows.map((r) => ({
          key: String(r.provider_key ?? ''),
          id: String(r.id ?? ''),
          config: pick(r, CUSTOM_PROVIDER_KEYS),
        }));
      },
      async create(http, config) {
        await http.post('/v1/custom_oauth_providers', compact(config));
      },
      async update(http, live, config) {
        const body = compact(config, true);
        delete body.provider_key; // immutable
        await http.patch(`/v1/custom_oauth_providers/${enc(live.id)}`, body);
      },
      async remove(http, live) {
        await http.delete(`/v1/custom_oauth_providers/${enc(live.id)}`);
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
        const body = compact(config);
        delete body.signing_alg; // read-only (reported, not settable)
        await http.post('/v1/resource_servers', body);
      },
      async update(http, live, config) {
        const body = compact(config, true);
        delete body.identifier; // immutable
        delete body.signing_alg; // read-only
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

    // 7b. Custom permissions — key = key. Before roles, which grant them. System ones skipped.
    {
      kind: 'collection',
      type: 'permissions',
      keyOf: (c) => String(obj(c).key ?? ''),
      async fetchLive(http) {
        const rows = await listData<Record<string, unknown>>(http, '/v1/permissions');
        return rows
          .filter((r) => r.is_system !== true)
          .map((r) => ({ key: String(r.key ?? ''), id: String(r.id ?? ''), config: pick(r, PERMISSION_KEYS) }));
      },
      async create(http, config) {
        await http.post('/v1/permissions', compact(config));
      },
      async update(http, live, config) {
        const c = obj(config);
        await http.patch(`/v1/permissions/${enc(live.id)}`, { name: c.name, description: c.description ?? null });
      },
      async remove(http, live) {
        await http.delete(`/v1/permissions/${enc(live.id)}`);
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
          ...(typeof r.managed_by === 'string' && r.managed_by ? { managedBy: r.managed_by } : {}),
        }));
      },
      async create(http, config) {
        const c = obj(config);
        await http.post('/v1/webhook_endpoints', {
          url: c.url,
          enabled_events: c.enabled_events ?? [],
          // Sent on create so a paused endpoint is never live, even briefly.
          ...(typeof c.active === 'boolean' ? { active: c.active } : {}),
        });
      },
      async update(http, live, config) {
        await http.patch(`/v1/webhook_endpoints/${enc(live.id)}`, compact(config, true));
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
        const body = compact(config, true);
        delete body.type; // fixed at creation; PATCH does not take it
        await http.patch(`/v1/sso_connections/${enc(live.id)}`, body);
      },
      async remove(http, live) {
        await http.delete(`/v1/sso_connections/${enc(live.id)}`);
      },
    },

    // 10b. SSO onboarding profiles (hosted setup links) — key = name. After the SSO
    //      connections; a profile may name an organization that already exists.
    {
      kind: 'collection',
      type: 'sso_onboarding_profiles',
      keyOf: (c) => String(obj(c).name ?? ''),
      async fetchLive(http) {
        let rows: Record<string, unknown>[];
        try {
          rows = await listData<Record<string, unknown>>(http, '/v1/sso_onboarding_profiles');
        } catch (err) {
          if (isNotFound(err)) return [];
          throw err;
        }
        return rows.map((r) => {
          const config = pick(r, SSO_PROFILE_KEYS);
          return { key: String(r.name ?? ''), id: String(r.id ?? ''), config };
        });
      },
      async create(http, config) {
        await http.post('/v1/sso_onboarding_profiles', compact(config));
      },
      async update(http, live, config) {
        await http.patch(`/v1/sso_onboarding_profiles/${enc(live.id)}`, compact(config, true));
      },
      async remove(http, live) {
        await http.delete(`/v1/sso_onboarding_profiles/${enc(live.id)}`);
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
        const body = compact(config, true);
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
        const body = compact(config, true);
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

    // 12. Branding — the hosted-page appearance; a partial merge on write (PATCH).
    {
      kind: 'singleton',
      type: 'branding',
      async fetchLive(http) {
        let b: Record<string, Json>;
        try {
          b = await http.get<Record<string, Json>>('/v1/branding');
        } catch (err) {
          if (isNotFound(err)) return null;
          throw err;
        }
        const { object: _o, resolved: _r, ...fields } = b ?? {};
        const out = compact(fields);
        return Object.keys(out).length ? out : null;
      },
      async apply(http, config) {
        await http.patch('/v1/branding', compact(config, true));
      },
    },

    // 13. Cookie-consent banner — last: it only needs the instance. PUT replaces the
    //     whole setting and needs script_url, so apply merges the file over the live one.
    {
      kind: 'singleton',
      type: 'cookie_consent',
      async fetchLive(http) {
        let cc: Record<string, Json>;
        try {
          cc = await http.get<Record<string, Json>>('/v1/instance/cookie_consent');
        } catch (err) {
          if (isNotFound(err)) return null;
          throw err;
        }
        const out = pick(cc ?? {}, COOKIE_CONSENT_KEYS) as Record<string, Json>;
        return Object.keys(out).length ? out : null;
      },
      async apply(http, config) {
        const live = await http.get<Record<string, Json>>('/v1/instance/cookie_consent');
        const body: Record<string, Json> = { ...(pick(live ?? {}, COOKIE_CONSENT_KEYS) as Record<string, Json>), ...compact(config, true) };
        if (body.script_url === undefined || body.script_url === null) {
          throw new CliError('cookie_consent needs a script_url (the consent manager script) when none is set on the instance.');
        }
        await http.put('/v1/instance/cookie_consent', body);
      },
    },

    // 14. "Sign in with Atlas" button on the hosted pages. The file says whether it
    //     is on; `connection_id` (optional) links an SSO connection the instance
    //     already has instead of the preset one. Only `enabled` is exported or
    //     compared: the connection id is this instance's own.
    {
      kind: 'singleton',
      type: 'sign_in_with_atlas',
      async fetchLive(http) {
        let live: { enabled?: Json };
        try {
          live = await http.get<{ enabled?: Json }>('/v1/instance/sign_in_with_atlas');
        } catch (err) {
          if (isNotFound(err)) return null;
          throw err;
        }
        return { enabled: live?.enabled === true };
      },
      normalize: (c) => ({ enabled: obj(c).enabled === true }),
      async apply(http, config) {
        const c = obj(config);
        if (typeof c.enabled !== 'boolean') throw new CliError('sign_in_with_atlas needs enabled: true or false.');
        await http.patch('/v1/instance/sign_in_with_atlas', {
          enabled: c.enabled,
          ...(c.connection_id !== undefined ? { connection_id: c.connection_id } : {}),
        });
      },
    },

    // 15. Staged signing-key rotation: `prepublish_days` (1..90) publishes each new key
    //     that many days before it signs; null or 0 turns it off. Only the policy, never keys.
    {
      kind: 'singleton',
      type: 'signing_key_policy',
      async fetchLive(http) {
        let live: { prepublish_days?: Json };
        try {
          live = await http.get<{ prepublish_days?: Json }>('/v1/instance/signing_key_policy');
        } catch (err) {
          if (isNotFound(err)) return null;
          throw err;
        }
        return live?.prepublish_days ? { prepublish_days: live.prepublish_days } : null;
      },
      normalize: (c) => ({ prepublish_days: obj(c).prepublish_days || null }),
      async apply(http, config) {
        const d = obj(config).prepublish_days ?? null;
        if (d !== null && (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 90)) {
          throw new CliError('signing_key_policy.prepublish_days must be a whole number of days from 1 to 90, or null / 0 to turn it off.');
        }
        await http.patch('/v1/instance/signing_key_policy', { prepublish_days: d || null });
      },
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
  'post_logout_redirect_uris',
  'claims_redirect_uris',
  'backchannel_logout_uri',
  'backchannel_logout_session_required',
  'frontchannel_logout_uri',
  'frontchannel_logout_session_required',
  'skip_logout_confirmation',
  'refresh_touches_session',
  'require_verified_email',
  'require_pkce',
  'login_url',
  'consent_url',
  'subject_type',
  'sector_identifier_uri',
  'access_token_format',
  'token_lifetimes',
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
const PERMISSION_KEYS = ['key', 'name', 'description'] as const;
const CUSTOM_PROVIDER_KEYS = [
  'provider_key',
  'display_name',
  'icon_url',
  'protocol',
  'issuer',
  'discovery_url',
  'authorization_endpoint',
  'token_endpoint',
  'userinfo_endpoint',
  'jwks_uri',
  'scopes',
  'pkce',
  'authorization_params',
  'token_params',
  'token_endpoint_auth_method',
  'profile_source',
  'profile_mapping',
  'client_id',
  'enabled',
  'allow_sign_in',
  'allow_sign_up',
] as const;
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
const SSO_PROFILE_KEYS = ['name', 'allowed_connection_types', 'organization_id', 'company_name', 'allow_scim', 'intents', 'return_url'] as const;
const COOKIE_CONSENT_KEYS = ['enabled', 'script_url', 'script_id', 'site_id', 'blocking_mode', 'extra_origins', 'settings_link', 'culture', 'host_aliases'] as const;
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
  'provider',
  'annual_price_id',
  'kind',
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

/** What a write-only secret looks like on the live side, and in a plan. */
const SECRET_SET = '(secret set)';
const SECRET_KEY = /(secret|token|password|passwd|api_?key|private_?key)/i;

/**
 * Show each secret value under `groups` as "(secret set)" so a plan never echoes it
 * and compares equal to the live "(secret set)". An unresolved \${VAR} stays visible
 * (apply refuses it), as does an empty value.
 */
function redactSecrets(config: Config, groups: string[]): Config {
  const out = { ...obj(config) };
  const mask = (g: Record<string, Json>): Record<string, Json> =>
    Object.fromEntries(
      Object.entries(g).map(([k, v]) => [k, SECRET_KEY.test(k) && typeof v === 'string' && v !== '' && !/^\$\{[A-Z0-9_]+\}$/.test(v) ? SECRET_SET : v]),
    );
  for (const g of groups) if (out[g] && typeof out[g] === 'object' && !Array.isArray(out[g])) out[g] = mask(obj(out[g]!));
  return out;
}

/** A document without any "(secret set)" marker: what an export writes and what apply sends. */
function withoutMarkers(value: Json): Json {
  if (Array.isArray(value)) return value.map(withoutMarkers);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== SECRET_SET).map(([k, v]) => [k, withoutMarkers(v)]));
  }
  return value;
}

/** An origin list in either form (strings, or { origin, integration }) as plain strings. */
function originStrings(list: Json): string[] {
  return (Array.isArray(list) ? list : []).map((e) => (typeof e === 'string' ? e : String(obj(e).origin ?? '')));
}

/** auth_config without the integration hints, which belong to allowed_origins. */
function stripOriginIntegrations(authConfig: Json): Record<string, Json> {
  const { originIntegrations: _hints, ...rest } = obj(authConfig);
  return rest;
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
  // Provider settings (a tenant, a domain, Apple's team/key ids) ride along in `values`.
  const values: Record<string, Json> = { ...obj(c.values ?? null) };
  if (c.client_id !== undefined && c.client_id !== null) values.client_id = c.client_id;
  // A secret only exists here when the file carried a ${ENV} placeholder for it.
  if (c.client_secret !== undefined && c.client_secret !== null) {
    values.client_secret = c.client_secret;
  }
  const body: Record<string, Json> = {};
  if (Object.keys(values).length) body.values = values;
  if (Array.isArray(c.scopes)) body.scopes = c.scopes;
  // Credential-less providers (siwe, siws, siwb, siwf) take verifier settings instead.
  if (c.settings && typeof c.settings === 'object' && !Array.isArray(c.settings)) body.settings = c.settings;
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
    case 'plan':
      return planConfig(ctx, args.values, { dir: resolveDir(args.values), format: resolveFormat(args.values), env: readSecretsEnv(ctx, args.values) });
    case 'promote':
      return promoteConfig(ctx, args.values);
    default:
      throw new CliError(
        sub
          ? `Unknown subcommand 'config ${sub}'. Try: export, import, plan, promote.`
          : 'config needs a subcommand: export, import, plan, promote.',
      );
  }
}

export function resolveFormat(values: Values): Format {
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

/** Write every resource type's live config to `dir` (deterministic, secrets omitted); returns the file count. */
async function writeExport(http: ConfigHttp, dir: string, format: Format): Promise<number> {
  const ext = format === 'json' ? 'json' : 'yaml';
  mkdirSync(dir, { recursive: true });
  let fileCount = 0;

  for (const spec of registry()) {
    if (spec.kind === 'singleton') {
      const live = await spec.fetchLive(http);
      if (live === null) continue; // nothing to write (e.g. no schema registered)
      writeFileSync(join(dir, `${spec.type}.${ext}`), serialize(withoutMarkers(live), format));
      fileCount += 1;
    } else {
      const entries = (await spec.fetchLive(http)).filter((e) => !e.managedBy);
      // Deterministic: entries sorted by natural key, keys sorted inside each.
      const sorted = [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const doc = sorted.map((e) => canonicalize(e.config));
      writeFileSync(join(dir, `${spec.type}.${ext}`), serialize(doc, format));
      fileCount += 1;
    }
  }
  return fileCount;
}

async function exportConfig(ctx: RunContext, values: Values): Promise<number> {
  const http = requireHttp(ctx, values);
  const dir = resolveDir(values);
  const format = resolveFormat(values);
  const fileCount = await writeExport(http, dir, format);

  ctx.io.out(`Exported ${fileCount} resource file(s) to ${dir} (${format}).`);
  ctx.io.out('Secrets are never exported — supply any credential at import via a ${ENV} placeholder.');
  return 0;
}

export interface Change {
  type: string;
  action: 'create' | 'update' | 'delete';
  key: string;
  /** The live document (absent on a create). Carried for `atlas config plan`'s field diff. */
  before?: Config;
  /** The desired document (absent on a delete). */
  after?: Config;
}

/** A planned change and the call that applies it. */
export interface PlannedChange extends Change {
  apply: () => Promise<void>;
}

/** What `atlas config import` would do: the changes, the unchanged count and the skipped deletes. */
export interface ConfigPlan {
  changes: PlannedChange[];
  unchanged: number;
  skippedDeletes: Change[];
  /** Live resources owned by a connected platform: shown for information, never changed. */
  managed: Array<{ type: string; key: string; managedBy: string }>;
}

/**
 * Diff a config directory against the live instance. Nothing is written: the
 * returned changes carry their own `apply`. Used by `atlas config import` and by
 * `atlas migrate better-auth` (which shows the plan before applying it).
 */
export async function planConfigImport(
  http: ConfigHttp,
  opts: { dir: string; format: Format; env: NodeJS.ProcessEnv; prune: boolean; forceHook?: boolean },
): Promise<ConfigPlan> {
  const { dir, format, env, prune } = opts;
  const applyOpts: ApplyOpts = { forceHook: opts.forceHook === true };
  const ext = format === 'json' ? 'json' : 'yaml';
  if (!existsSync(dir)) {
    throw new CliError(`Config directory not found: ${dir}. Run 'atlas config export' first.`);
  }
  const present = new Set(readdirSync(dir));

  const changes: PlannedChange[] = [];
  let unchanged = 0;
  const skippedDeletes: Change[] = [];
  const managed: ConfigPlan['managed'] = [];

  for (const spec of registry()) {
    const file = `${spec.type}.${ext}`;
    // A type with no file is simply NOT MANAGED — leave live untouched.
    if (!present.has(file)) continue;
    const text = readFileSync(join(dir, file), 'utf8');
    const parsed = interpolate(deserialize(text, format), env);

    if (spec.kind === 'singleton') {
      const desired = parsed;
      const liveRaw = await spec.fetchLive(http);
      const norm = spec.normalize ?? ((c: Config) => c);
      const desiredN = norm(desired);
      // A section that only clears fields (all null) against nothing live is already satisfied.
      if (liveRaw === null && onlyNulls(desiredN)) {
        unchanged += 1;
        continue;
      }
      const live = liveRaw === null ? null : comparable(norm(liveRaw), desiredN, prune);
      if (live !== null && deepEqual(desiredN, live)) {
        unchanged += 1;
        continue;
      }
      changes.push({ type: spec.type, action: live === null ? 'create' : 'update', key: '', ...(live === null ? {} : { before: live }), after: desiredN, apply: () => spec.apply(http, desired, applyOpts) });
      continue;
    }

    // Collection: diff desired-by-key against live-by-key.
    const desiredList = asArray(parsed);
    const desiredByKey = new Map<string, Config>();
    for (const cfg of desiredList) desiredByKey.set(spec.keyOf(cfg), cfg);
    const all = await spec.fetchLive(http);
    for (const e of all) if (e.managedBy) managed.push({ type: spec.type, key: e.key, managedBy: e.managedBy });
    const live = all.filter((e) => !e.managedBy);
    const liveByKey = new Map(live.map((e) => [e.key, e]));

    for (const [key, cfg] of desiredByKey) {
      const existing = liveByKey.get(key);
      if (!existing) {
        changes.push({ type: spec.type, action: 'create', key, after: cfg, apply: () => spec.create(http, cfg) });
      } else if (!deepEqual(cfg, comparable(existing.config, cfg, prune))) {
        if (!spec.update) {
          throw new CliError(
            `${spec.type} '${key}' changed but is immutable; recreate it instead.`,
          );
        }
        const upd = spec.update;
        changes.push({ type: spec.type, action: 'update', key, before: comparable(existing.config, cfg, prune), after: cfg, apply: () => upd(http, existing, cfg) });
      } else {
        unchanged += 1;
      }
    }

    for (const entry of live) {
      if (desiredByKey.has(entry.key)) continue;
      const change: Change = { type: spec.type, action: 'delete', key: entry.key, before: entry.config };
      if (!spec.remove) {
        skippedDeletes.push(change);
        continue;
      }
      if (prune) {
        const rm = spec.remove;
        changes.push({ ...change, apply: () => rm(http, entry) });
      } else {
        skippedDeletes.push(change);
      }
    }
  }
  return { changes, unchanged, skippedDeletes, managed };
}

/** True for a non-empty object whose every leaf is `null` (a file that only clears fields). */
function onlyNulls(x: Json | undefined): boolean {
  if (x === null) return true;
  if (typeof x !== 'object' || Array.isArray(x) || x === undefined) return false;
  const vals = Object.values(x);
  return vals.length > 0 && vals.every(onlyNulls);
}

/**
 * The live document as the plan compares it. With `--prune` the whole live
 * document (keys the file leaves unset show as drift). Without it only the keys
 * the file sets, recursively, so a freshly applied file plans clean. A desired
 * `null` means "unset", so it matches a live key that is absent.
 */
function comparable(live: Config, desired: Config, prune: boolean): Config {
  if (prune) return live;
  const isObj = (x: Json | undefined): x is { [k: string]: Json } => x !== null && typeof x === 'object' && !Array.isArray(x);
  if (!isObj(live) || !isObj(desired)) return live;
  const out: { [k: string]: Json } = {};
  for (const k of Object.keys(desired)) {
    const l = live[k];
    if (l === undefined || l === null) {
      if (desired[k] === null) out[k] = null;
      continue;
    }
    out[k] = comparable(l, desired[k]!, false);
  }
  return out;
}

/** The stored credential of a named profile (one profile per environment). */
function profileHttp(ctx: RunContext, name: string): { http: ConfigHttp; secretKey: string } {
  const stored = ctx.config.load().profiles[name];
  if (!stored?.secret_key) {
    throw new CliError(`No profile named '${name}'. Run 'atlas login --profile ${name}' with that environment's secret key.`);
  }
  const secretKey = stored.secret_key;
  const apiUrl = envApiUrl(ctx.env) || stored.api_url || DEFAULT_API_URL;
  const make = ctx.makeHttp ?? createConfigHttp;
  return { http: make({ secretKey, apiUrl }), secretKey };
}

/** True for a production (live) secret key: `atlas_live_sk_…` or `sk_live_…`. */
const isLiveKey = (key: string) => /(?:^|_)live_/.test(key);

/**
 * `atlas config promote --from <profile> --to <profile>`: copy one environment's
 * configuration to another (development → staging → production) through the same
 * plan/apply engine as `config import`. Each environment is a profile holding that
 * instance's secret key. Secrets never travel: `${ENV}` placeholders stay as they
 * are and credentials are set per environment. `--dry-run` prints the plan only;
 * applying to a live (production) key needs `--yes`.
 */
async function promoteConfig(ctx: RunContext, values: Values): Promise<number> {
  const from = str(values, 'from');
  const to = str(values, 'to');
  if (!from || !to) throw new CliError('promote needs --from <profile> and --to <profile> (one profile per environment).');
  if (from === to) throw new CliError('--from and --to name the same profile.');
  const format = resolveFormat(values);
  const dryRun = values['dry-run'] === true;
  const prune = values.prune === true;

  const source = profileHttp(ctx, from);
  const target = profileHttp(ctx, to);
  if (source.secretKey === target.secretKey) {
    throw new CliError(`Profiles '${from}' and '${to}' hold the same secret key — they are the same environment.`);
  }
  if (!dryRun && isLiveKey(target.secretKey) && values.yes !== true) {
    throw new CliError(`'${to}' is a live (production) environment. Review with --dry-run, then re-run with --yes to apply.`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'atlas-promote-'));
  try {
    await writeExport(source.http, dir, format);
    const plan = await planConfigImport(target.http, { dir, format, env: ctx.env, prune });
    ctx.io.out(`Promoting ${from} -> ${to}`);
    printPlan(ctx, plan.changes, plan.unchanged, plan.skippedDeletes, { dryRun, prune });
    if (dryRun) return 0;
    for (const change of plan.changes) await change.apply();
    ctx.io.out(plan.changes.length ? `Applied ${plan.changes.length} change(s) to ${to}.` : 'No changes to apply.');
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function importConfig(ctx: RunContext, values: Values): Promise<number> {
  const http = requireHttp(ctx, values);
  const dir = resolveDir(values);
  const format = resolveFormat(values);
  const dryRun = values['dry-run'] === true;
  const prune = values.prune === true;

  const plan = await planConfigImport(http, { dir, format, env: readSecretsEnv(ctx, values), prune, forceHook: values['force-hook'] === true });
  printPlan(ctx, plan.changes, plan.unchanged, plan.skippedDeletes, { dryRun, prune });

  if (dryRun) return 0;
  for (const change of plan.changes) await change.apply();
  if (plan.changes.length) ctx.io.out(`Applied ${plan.changes.length} change(s).`);
  else ctx.io.out('No changes to apply.');
  return 0;
}

/** One differing field between the live and the desired document. */
export interface FieldDiff {
  path: string;
  before?: Json;
  after?: Json;
}

/** Leaf-level differences between two documents, as dotted paths (arrays compare whole). */
export function diffFields(before: Json | undefined, after: Json | undefined, path = ''): FieldDiff[] {
  const isObj = (x: Json | undefined): x is { [k: string]: Json } => x !== null && typeof x === 'object' && !Array.isArray(x);
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diffFields(before[k], after[k], path ? `${path}.${k}` : k));
  }
  if (before !== undefined && after !== undefined && deepEqual(before, after)) return [];
  if (before === undefined && after === undefined) return [];
  return [{ path: path || '(document)', ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) }];
}

const show = (v: Json | undefined) => (v === undefined ? '(unset)' : typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v));

/**
 * `atlas config plan`: a Terraform-style, read-only diff of a config directory
 * (`atlas config export` output, committed to git) against the live instance.
 * Field-level for updates, `--json` for tooling, and `--exit-code` to exit 2
 * when there is drift so CI can gate on it. Never writes anything.
 */
async function planConfig(ctx: RunContext, values: Values, source: ConfigSource): Promise<number> {
  const http = requireHttp(ctx, values);
  const { dir, format, env } = source;
  const where = source.label ?? dir;
  const prune = values.prune === true;
  const plan = await planConfigImport(http, { dir, format, env, prune });
  const deletes: Change[] = prune ? [] : plan.skippedDeletes;
  const all: Change[] = plan.changes;
  const rows = all.map((c) => ({
    type: c.type,
    key: c.key || null,
    action: c.action,
    fields: c.action === 'update' ? diffFields(c.before, c.after) : [],
  }));
  const pending = rows.length;

  if (values.json === true) {
    ctx.io.out(
      JSON.stringify(
        {
          object: 'config_plan',
          changes: rows,
          unchanged: plan.unchanged,
          unmanaged_live: deletes.map((d) => ({ type: d.type, key: d.key || null })),
          managed_by_platform: plan.managed.map((m) => ({ type: m.type, key: m.key, managed_by: m.managedBy })),
          has_changes: pending > 0,
        },
        null,
        2,
      ),
    );
  } else {
    ctx.io.out(`Plan: ${pending} to change, ${plan.unchanged} unchanged${deletes.length ? `, ${deletes.length} live but not in config` : ''}.`);
    const sign = { create: '+', update: '~', delete: '-' } as const;
    for (const c of [...all].sort(sortChange)) {
      const label = c.key ? `${c.type} ${c.key}` : c.type;
      ctx.io.out('');
      ctx.io.out(`${sign[c.action]} ${label} (${c.action})`);
      if (c.action === 'update') {
        for (const f of diffFields(c.before, c.after)) ctx.io.out(`    ${f.path}: ${show(f.before)} -> ${show(f.after)}`);
      }
    }
    if (deletes.length) {
      ctx.io.out('');
      ctx.io.out(`Live but not in ${where} (kept; pass --prune to plan their deletion):`);
      for (const d of deletes) ctx.io.out(`    ${d.type}${d.key ? ` ${d.key}` : ''}`);
    }
    if (plan.managed.length) {
      ctx.io.out('');
      ctx.io.out('Managed by a connected platform (not part of this file; never pruned):');
      for (const m of plan.managed) ctx.io.out(`    ${m.type} ${m.key} (${m.managedBy})`);
    }
    if (pending === 0) ctx.io.out(`No drift: the instance matches ${where}.`);
  }
  return wantsCheck(values) && pending > 0 ? 2 : 0;
}

/** `--check` (CI) and `--exit-code` (Terraform's name) both mean: exit 2 when there is drift. */
const wantsCheck = (values: Values) => values['exit-code'] === true || values.check === true;

/** Where a plan reads its desired config from: a directory of per-type files, and the env for `${VAR}`. */
interface ConfigSource {
  dir: string;
  format: Format;
  env: NodeJS.ProcessEnv;
  /** What the user passed (a file or directory as typed); messages name this, never a working directory. */
  label?: string;
}

/**
 * The environment `${VAR}` placeholders resolve against: the process env, then
 * `--secrets-file` (a dotenv file) on top. The file holds credentials, so it
 * must be readable by its owner only (mode 0600 or stricter); anything looser
 * is refused rather than read. POSIX only: Windows has no such mode bits.
 */
export function readSecretsEnv(ctx: RunContext, values: Values): NodeJS.ProcessEnv {
  const file = str(values, 'secrets-file');
  if (!file) return ctx.env;
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch {
    throw new CliError(`--secrets-file not found: ${file}.`);
  }
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    throw new CliError(
      `--secrets-file ${file} is readable by others (mode ${(mode & 0o777).toString(8)}). Run 'chmod 600 ${file}' and try again.`,
    );
  }
  return { ...ctx.env, ...parseDotenv(ctx.readFile(file)) };
}

/** `${VAR}` placeholders still in a planned change (no env value and no --secrets-file entry). */
export function unresolvedPlaceholders(changes: Change[]): string[] {
  const names = new Set<string>();
  for (const c of changes) {
    for (const m of JSON.stringify(c.after ?? null).matchAll(/\$\{([A-Z0-9_]+)\}/g)) names.add(m[1]!);
  }
  return [...names].sort();
}

/** The resource types a single config file may hold, in the order they are applied. */
export function configTypes(): string[] {
  return registry().map((s) => s.type);
}

/**
 * Resolve `atlas plan|apply [<path>]`: a directory of per-type files (as
 * `atlas config export` writes), or ONE file whose top-level keys are resource
 * types (`instance`, `webhook_endpoints`, …), split into a temp directory.
 * `cleanup` removes that temp directory.
 */
/** Config files `atlas plan` / `atlas apply` pick up from the current directory when given no path. */
export const DEFAULT_CONFIG_FILES = ['atlas.config.ts', 'atlas.config.mts', 'atlas.config.mjs', 'atlas.config.js', 'atlas.yaml', 'atlas.yml', 'atlas.json'];
const CODE_EXTS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);

// The CLI compiles to CommonJS, where tsc turns import() into require(), which cannot load ESM or .ts,
// so the real import() is reached through Function. A vm context with no import hook (a test runner)
// cannot run that one, and gets the plain import() the runner itself transforms.
const nativeImport = async (url: string): Promise<unknown> => {
  try {
    return await (new Function('url', 'return import(url)') as (url: string) => Promise<unknown>)(url);
  } catch (err) {
    if ((err as { code?: string }).code !== 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING') throw err;
    return import(url);
  }
};

/**
 * Load an `atlas.config.ts` (or .js/.mjs): its default export is the config
 * object, or a function (sync or async) returning it. A .ts file runs on
 * Node's own type stripping (Node 22.18+ / 23.6+), so it adds no dependency.
 */
export async function loadCodeConfig(path: string): Promise<unknown> {
  let mod: { default?: unknown };
  try {
    mod = (await nativeImport(pathToFileURL(resolve(path)).href)) as { default?: unknown };
  } catch (err) {
    const msg = (err as Error).message;
    if (/\.ts|Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION/.test(msg) && /\.[cm]?ts$/.test(path)) {
      throw new CliError(`${path}: this Node (${process.version}) cannot load TypeScript directly. Use Node 22.18+ (or 23.6+), or rename it to atlas.config.mjs.`);
    }
    throw new CliError(`${path}: ${msg}`);
  }
  const exported = mod.default;
  if (exported === undefined) throw new CliError(`${path} has no default export. Write: export default defineConfig({ ... }).`);
  return typeof exported === 'function' ? await (exported as () => unknown)() : exported;
}

async function resolveSource(ctx: RunContext, args: ParsedArgs): Promise<ConfigSource & { cleanup: () => void }> {
  const path =
    args.positionals[1] ??
    (str(args.values, 'dir') ? resolveDir(args.values) : (DEFAULT_CONFIG_FILES.find((f) => existsSync(f)) ?? resolveDir(args.values)));
  const env = readSecretsEnv(ctx, args.values);
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    throw new CliError(`Config not found: ${path}. Pass a config file (atlas.config.ts / atlas.yaml / atlas.json) or a directory from 'atlas config export'.`);
  }
  if (!isFile) return { dir: path, label: path, format: resolveFormat(args.values), env, cleanup: () => undefined };

  const ext = extname(path).toLowerCase();
  const format: Format = ext === '.yaml' || ext === '.yml' ? 'yaml' : ext === '.json' ? 'json' : resolveFormat(args.values);
  // A round-trip through JSON keeps only plain data (no functions, Dates become strings), like a .json file.
  const doc = CODE_EXTS.has(ext) ? (JSON.parse(JSON.stringify((await loadCodeConfig(path)) ?? null)) as unknown) : deserialize(ctx.readFile(path), format);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new CliError(`${path} must be an object keyed by resource type (${configTypes().join(', ')}).`);
  }
  const known = new Set(configTypes());
  const unknown = Object.keys(doc).filter((k) => !known.has(k));
  if (unknown.length) {
    throw new CliError(`${path}: unknown resource type(s) ${unknown.join(', ')}. Known: ${configTypes().join(', ')}.`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'atlas-apply-'));
  for (const [type, value] of Object.entries(doc)) writeFileSync(join(dir, `${type}.json`), serialize(value, 'json'));
  return { dir, label: path, format: 'json', env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * `atlas plan [<file|dir>]`: the read-only diff of `atlas config plan`, taking
 * a single config file as well. `--check` exits 2 on drift for CI.
 */
export async function planCommand(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const source = await resolveSource(ctx, args);
  try {
    return await planConfig(ctx, args.values, source);
  } finally {
    source.cleanup();
  }
}

/**
 * `atlas apply [<file|dir>]`: plan, show it, confirm, then apply in the fixed
 * resource order (see {@link configTypes}). `--yes` skips the question (needed
 * when there is no terminal); `--check` only plans and exits 2 on drift.
 * Refuses to apply while any `${VAR}` placeholder is unresolved, so a missing
 * secret is never sent as the literal text.
 */
export async function applyCommand(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const values = args.values;
  if (values.check === true || values['exit-code'] === true) return planCommand(ctx, args);
  const source = await resolveSource(ctx, args);
  try {
    const kept = keepingSecrets(requireHttp(ctx, values), str(values, 'out') || productDir(ctx.env, 'atlas'));
    const prune = values.prune === true;
    const plan = await planConfigImport(kept.http, { dir: source.dir, format: source.format, env: source.env, prune, forceHook: values['force-hook'] === true });
    printPlan(ctx, plan.changes, plan.unchanged, plan.skippedDeletes, { dryRun: false, prune });
    if (plan.changes.length === 0) {
      ctx.io.out('No changes to apply.');
      return 0;
    }
    const missing = unresolvedPlaceholders(plan.changes);
    if (missing.length) {
      throw new CliError(`Unresolved placeholder(s): ${missing.map((n) => `\${${n}}`).join(', ')}. Set them in the environment or in --secrets-file.`);
    }
    if (values.yes !== true) {
      const answer = (await ctx.prompt.text(`Apply ${plan.changes.length} change(s)? [y/N]`, { default: 'n' })).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        ctx.io.out('Nothing applied.');
        return 1;
      }
    }
    for (const change of plan.changes) await change.apply();
    ctx.io.out(`Applied ${plan.changes.length} change(s).`);
    for (const path of kept.saved) ctx.io.out(`A new secret was written to ${path} (mode 0600). It is shown only once.`);
    return 0;
  } finally {
    source.cleanup();
  }
}

/**
 * The API, but a create that answers with a one-time secret (a new OAuth
 * client's `client_secret`, a new webhook endpoint's `secret`) writes it to a
 * 0600 dotenv file in `dir` (default `~/.config/atlas`, or `--out`) instead of
 * dropping it. The file names are the hosted-redirect env names.
 */
function keepingSecrets(http: ConfigHttp, dir: string): { http: ConfigHttp; saved: string[] } {
  const saved: string[] = [];
  const wrapped: ConfigHttp = {
    get: <T>(path: string) => http.get<T>(path),
    put: <T>(path: string, body: unknown) => http.put<T>(path, body),
    patch: <T>(path: string, body: unknown) => http.patch<T>(path, body),
    delete: (path: string, body?: unknown) => http.delete(path, body),
    async post<T>(path: string, body: unknown): Promise<T> {
      const res = await http.post<T>(path, body);
      const r = (res ?? {}) as Record<string, unknown>;
      const id = String(r.id ?? r.client_id ?? 'new').replace(/[^A-Za-z0-9_-]/g, '_');
      let entries: Record<string, string> | null = null;
      if (path === '/v1/oauth_clients' && typeof r.client_secret === 'string') {
        entries = { ATLAS_CLIENT_ID: String(r.client_id ?? ''), ATLAS_CLIENT_SECRET: r.client_secret };
      } else if (path === '/v1/webhook_endpoints' && typeof r.secret === 'string') {
        entries = { ATLAS_WEBHOOK_SECRET: r.secret };
      }
      if (entries) {
        const kind = path === '/v1/oauth_clients' ? 'oauth-client' : 'webhook';
        saved.push(writeSecretFile(dir, `${kind}-${id}.env`, entries, { comment: `Written by atlas apply. ${kind} ${id}.` }).path);
      }
      return res;
    },
  };
  return { http: wrapped, saved };
}

export function printPlan(
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
export function interpolate(value: Json, env: NodeJS.ProcessEnv): Json {
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

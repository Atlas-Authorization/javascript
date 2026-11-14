import type { ConfigHttp } from '../../config-http';
import { isSecretKey } from '../../redact';
import type { Json } from '../../serialize';
import type { CollectionSpec, ResourceSpec } from '../config';
import { settingsSpec } from './settings';
import { simpleResourceSpec } from './simple';

type Obj = Record<string, Json>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Group 2: authorization, enterprise provisioning, billing and machine-facing settings.
 * Every collection is `prune: false` (deleted only with `--prune-type <type>`); credentials are
 * write-only or sealed and never reach an export.
 *
 * Not covered, and why: fga models (versioned writes with no stable name), directory_pull_sources
 * (scoped to an organization, so a name is not unique), saml_idp service providers (created only by
 * metadata import), connection_actions (the read API returns a summary, not the definition),
 * ssf streams (no user-chosen name; the poll token is shown once), entitlement_overrides (no update
 * route, keyed by user), per-client exchange policy / token exchange profiles / trusted issuers
 * (nested under a client id), machine and api-key policies and workload identity (no instance-level
 * write route).
 */

/** Billing credentials: PUT per provider; the API never returns a stored secret, so a secret-named file value is sent, never compared. */
const billingProviders: CollectionSpec = {
  kind: 'collection',
  type: 'billing_providers',
  prune: false,
  fileKeys: ['provider', 'environment', 'config'],
  keyOf: (c) => String(isObj(c) ? (c.provider ?? '') : ''),
  async fetchLive(http: ConfigHttp) {
    const res = await http.get<{ data?: Obj[] }>('/v1/billing/providers');
    return (Array.isArray(res?.data) ? res.data : [])
      .filter((row) => row.configured !== false)
      .map((row) => {
        const config: Obj = { provider: row.provider ?? null };
        if (row.environment !== undefined && row.environment !== null) config.environment = row.environment;
        if (isObj(row.config) && Object.keys(row.config).length) config.config = row.config;
        const key = String(row.provider ?? '');
        return { key, id: key, config };
      });
  },
  align(live, desired) {
    const l: Obj = isObj(live) ? { ...live } : {};
    const d: Obj = isObj(desired) ? desired : {};
    if (isObj(d.config)) {
      const cfg: Obj = isObj(l.config) ? { ...l.config } : {};
      for (const [k, v] of Object.entries(d.config)) if (isSecretKey(k)) cfg[k] = v;
      l.config = cfg;
    }
    return l;
  },
  async create(http, config) {
    await put(http, String((isObj(config) ? config.provider : '') ?? ''), config);
  },
  async update(http, live, config) {
    await put(http, live.id, config);
  },
  async remove(http, live) {
    await http.delete(`/v1/billing/providers/${encodeURIComponent(live.id)}`);
  },
};

async function put(http: ConfigHttp, provider: string, config: Json): Promise<void> {
  const c = isObj(config) ? config : {};
  await http.put(`/v1/billing/providers/${encodeURIComponent(provider)}`, {
    ...(c.environment !== undefined ? { environment: c.environment } : {}),
    config: c.config ?? {},
  });
}

/** The bundle routes take `entitlements` and answer `entitlement_ids`; the file uses the answer's name. */
function renameEntitlements(spec: CollectionSpec): CollectionSpec {
  const wrap = (http: ConfigHttp): ConfigHttp => {
    const ren = (b: unknown) => {
      if (!isObj(b) || b.entitlement_ids === undefined) return b;
      const { entitlement_ids, ...rest } = b;
      return { ...rest, entitlements: entitlement_ids };
    };
    return {
      get: (p) => http.get(p),
      post: (p, b) => http.post(p, ren(b)),
      put: (p, b) => http.put(p, b),
      patch: (p, b) => http.patch(p, ren(b)),
      delete: (p, b) => http.delete(p, b),
    };
  };
  return { ...spec, create: (http, c) => spec.create(wrap(http), c), update: (http, l, c) => spec.update!(wrap(http), l, c) };
}

export const authzEnterpriseSpecs: ResourceSpec[] = [
  // ABAC and conditional access
  simpleResourceSpec({ type: 'abac_policies', path: '/v1/abac_policies', idKey: 'id', fileKeys: ['name', 'description', 'enabled', 'source', 'tests'] }),
  settingsSpec({ type: 'abac_schema', path: '/v1/abac_schema', fileKeys: ['schema'], liveOf: (res) => (res.schema ? { schema: res.schema } : null) }),
  simpleResourceSpec({ type: 'access_policies', path: '/v1/access_policies', idKey: 'id', fileKeys: ['name', 'description', 'enabled', 'priority', 'stages', 'conditions', 'grants', 'mode', 'targets'] }),
  // Relationship-based authorization
  simpleResourceSpec({ type: 'fga_stores', path: '/v1/fga/stores', idKey: 'id', fileKeys: ['name'] }),
  settingsSpec({ type: 'fga_settings', path: '/v1/fga/settings', fileKeys: ['cache_ttl_ms', 'default_consistency', 'changelog_retention_days'] }),
  // Groups and application roles
  simpleResourceSpec({ type: 'groups', path: '/v1/groups', nameKey: 'slug', idKey: 'id', fileKeys: ['slug', 'name', 'description', 'attributes', 'app_role_keys', 'include_in_token', 'dynamic_filter', 'sso_match'] }),
  simpleResourceSpec({ type: 'group_rules', path: '/v1/group_rules', idKey: 'id', fileKeys: ['name', 'enabled', 'priority', 'condition', 'actions'] }),
  simpleResourceSpec({ type: 'app_roles', path: '/v1/app_roles', nameKey: 'key', idKey: 'id', fileKeys: ['key', 'name', 'description', 'permissions'], updateKeys: ['name', 'description', 'permissions'] }),
  // Identity governance
  simpleResourceSpec({ type: 'iga_sod_rules', path: '/v1/iga/sod_rules', idKey: 'id', fileKeys: ['name', 'description', 'entitlement_a', 'entitlement_b', 'mode', 'approver', 'enabled'], updateKeys: ['name', 'description', 'mode', 'approver', 'enabled'] }),
  simpleResourceSpec({ type: 'iga_birthright_rules', path: '/v1/iga/birthright_rules', idKey: 'id', fileKeys: ['name', 'match', 'entitlement_ids', 'revoke_on_unmatch', 'enabled'] }),
  renameEntitlements(simpleResourceSpec({ type: 'iga_bundles', path: '/v1/iga/bundles', nameKey: 'key', idKey: 'id', fileKeys: ['key', 'name', 'description', 'catalog', 'entitlement_ids', 'form', 'policy', 'enabled'] })),
  settingsSpec({ type: 'iga_settings', path: '/v1/iga/settings', fileKeys: ['jml_enabled', 'leaver_action', 'leaver_close_grace_seconds'] }),
  // Machines and agents
  settingsSpec({ type: 'agent_registration', path: '/v1/agent_registration', fileKeys: ['enabled', 'allow_anonymous', 'allow_service_auth', 'allow_refresh', 'untrusted_scopes', 'trusted_scopes', 'claim_ttl_seconds', 'auto_approve_rules'] }),
  // Enterprise provisioning and sign-out notification
  simpleResourceSpec({ type: 'scim_provisioning_targets', path: '/v1/scim_provisioning_targets', idKey: 'id', fileKeys: ['name', 'kind', 'base_url', 'bearer_token', 'attribute_mapping', 'deprovision_action', 'enabled', 'connector_config', 'credentials'], writeOnly: ['credentials'], sealed: ['bearer_token'], updateKeys: ['base_url', 'bearer_token', 'attribute_mapping', 'deprovision_action', 'enabled', 'connector_config', 'credentials'] }),
  simpleResourceSpec({ type: 'service_connectors', path: '/v1/service_connectors', idKey: 'id', fileKeys: ['name', 'kind', 'config', 'credentials', 'enabled'], writeOnly: ['credentials'], updateKeys: ['config', 'credentials', 'enabled'] }),
  { ...simpleResourceSpec({ type: 'logout_notify_endpoints', path: '/v1/logout_notify_endpoints', nameKey: 'url', idKey: 'id', fileKeys: ['url', 'oauth_client_id', 'audience', 'description'], updateKeys: ['audience', 'description'] }), defaulted: ['audience'] },
  // Billing
  simpleResourceSpec({ type: 'billing_coupons', path: '/v1/billing/coupons', nameKey: 'code', idKey: 'id', fileKeys: ['code', 'name', 'percent_off', 'amount_off', 'currency', 'duration', 'duration_months', 'max_redemptions', 'plan_ids', 'first_time_only', 'active'], createKeys: ['name', 'percent_off', 'amount_off', 'currency', 'duration', 'duration_months', 'max_redemptions', 'plan_ids', 'first_time_only'], updateKeys: ['active', 'name', 'max_redemptions'] }),
  settingsSpec({ type: 'billing_settings', path: '/v1/billing/settings', fileKeys: ['default_limit_merge', 'limit_merge'] }),
  billingProviders,
  // Identity verification
  settingsSpec({ type: 'identity_verification', path: '/v1/identity_verification/settings', fileKeys: ['enabled', 'connector_id', 'as_challenge', 'verified_attributes'] }),
];

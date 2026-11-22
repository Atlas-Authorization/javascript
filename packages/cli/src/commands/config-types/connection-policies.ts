import type { ConfigHttp } from '../../config-http';
import type { Json } from '../../serialize';
import type { CollectionSpec, ResourceSpec } from '../config';

type Obj = Record<string, Json>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * `connection_provider_policies`: per provider, whether one provider account may be held by one owner only
 * (`unique_external_id`) and the secrets the provider's uninstall notices are verified with (`webhook_secret`:
 * Etsy, Square, Wix, eBay; `dev_id`: eBay). Keyed by provider. Both secrets are write-only: put `${ENV_VAR}`
 * there; they are never exported or compared. Never pruned unless `--prune-type connection_provider_policies`
 * (removing a policy turns `unique_external_id` off).
 */
const KEYS = ['unique_external_id', 'webhook_secret', 'dev_id'] as const;

async function put(http: ConfigHttp, config: Json): Promise<void> {
  const c = isObj(config) ? config : {};
  const body: Obj = {};
  for (const k of KEYS) if (c[k] !== undefined) body[k] = c[k]!;
  await http.put(`/v1/connection_providers/${encodeURIComponent(String(c.provider))}/policy`, body);
}

const CONNECTION_PROVIDER_POLICIES: CollectionSpec = {
  kind: 'collection',
  type: 'connection_provider_policies',
  prune: false,
  fileKeys: ['provider', ...KEYS],
  writeOnly: ['webhook_secret', 'dev_id'],
  defaulted: ['unique_external_id'],
  keyOf: (c) => String(isObj(c) ? (c.provider ?? '') : ''),
  async fetchLive(http) {
    const res = await http.get<{ data?: Obj[] }>('/v1/connection_providers/policies');
    return (Array.isArray(res?.data) ? res.data : []).map((r) => {
      const provider = String(r.provider ?? '');
      return { key: provider, id: provider, config: { provider, unique_external_id: r.unique_external_id === true } };
    });
  },
  create: (http, config) => put(http, config),
  update: (http, _live, config) => put(http, config),
  async remove(http, live) {
    await http.delete(`/v1/connection_providers/${encodeURIComponent(live.id)}/policy`);
  },
  validate(config) {
    const c = isObj(config) ? config : {};
    const out: string[] = [];
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(String(c.provider ?? ''))) out.push('connection_provider_policies: provider must be a short lowercase key.');
    if (c.unique_external_id !== undefined && typeof c.unique_external_id !== 'boolean') out.push(`connection_provider_policies ${String(c.provider)}: unique_external_id must be true or false.`);
    if (c.dev_id !== undefined && c.dev_id !== null && c.provider !== 'ebay' && !/\$\{[A-Z0-9_]+\}/.test(String(c.dev_id))) out.push('connection_provider_policies: dev_id applies to ebay only.');
    return out;
  },
};

export const CONNECTION_POLICY_CONFIG_TYPES: ResourceSpec[] = [CONNECTION_PROVIDER_POLICIES];

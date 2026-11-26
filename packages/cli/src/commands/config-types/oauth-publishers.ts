import type { CollectionSpec, ResourceSpec } from '../config';
import { isNotFound } from '../../config-http';
import type { Json } from '../../serialize';
import { simpleResourceSpec } from './simple';

/**
 * `oauth_publishers`: the verified publisher claims of your OAuth apps, keyed by domain. Which apps belong to a
 * publisher, and whether the domain is verified, are operational (a DNS check, an attach call) and stay out of the
 * file. A publisher is created without `shared_sector` (it needs the verified domain); set it on a later apply.
 * Never pruned unless `--prune-type oauth_publishers`.
 */
export const OAUTH_PUBLISHER_CONFIG_TYPES: ResourceSpec[] = [
  simpleResourceSpec({
    type: 'oauth_publishers',
    path: '/v1/oauth_publishers',
    keyKeys: ['domain'],
    idKey: 'id',
    fileKeys: ['domain', 'name', 'shared_sector', 'skip_consent'],
    createKeys: ['name', 'skip_consent'],
    updateKeys: ['name', 'shared_sector', 'skip_consent'],
  }),
];

const obj = (v: unknown): Record<string, Json> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>) : {});
const enc = encodeURIComponent;

/**
 * `oauth_client_webhooks`: the event webhook of an OAuth client (key = its public client_id): `url` and `enabled_events`.
 * The signing secret is minted on the first apply and written to the secrets file, never into atlas.yaml.
 * Never pruned unless `--prune-type oauth_client_webhooks`.
 */
export const OAUTH_CLIENT_WEBHOOKS_CONFIG_TYPE: CollectionSpec = {
  kind: 'collection',
  type: 'oauth_client_webhooks',
  prune: false,
  fileKeys: ['client_id', 'url', 'enabled_events'],
  keyOf: (c) => String(obj(c).client_id ?? ''),
  async fetchLive(http) {
    const clients = await http.get<{ data?: Array<{ client_id: string }> }>('/v1/oauth_clients');
    const out: Array<{ key: string; id: string; config: Record<string, Json> }> = [];
    for (const c of clients.data ?? []) {
      try {
        const hook = await http.get<{ url: string; enabled_events: string[] }>(`/v1/oauth_clients/${enc(c.client_id)}/webhook`);
        out.push({ key: c.client_id, id: c.client_id, config: { client_id: c.client_id, url: hook.url, enabled_events: hook.enabled_events } });
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
    return out;
  },
  async create(http, config) {
    const c = obj(config);
    await http.put(`/v1/oauth_clients/${enc(String(c.client_id))}/webhook`, { url: c.url, ...(c.enabled_events !== undefined ? { enabled_events: c.enabled_events } : {}) });
  },
  async update(http, live, config) {
    const c = obj(config);
    await http.put(`/v1/oauth_clients/${enc(live.id)}/webhook`, { url: c.url, ...(c.enabled_events !== undefined ? { enabled_events: c.enabled_events } : {}) });
  },
  async remove(http, live) {
    await http.delete(`/v1/oauth_clients/${enc(live.id)}/webhook`);
  },
};

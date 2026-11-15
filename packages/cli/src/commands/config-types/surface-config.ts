import { CliError } from '../../errors';
import type { ConfigHttp } from '../../config-http';
import type { Json } from '../../serialize';
import type { CollectionSpec, ResourceSpec } from '../config';
import { simpleSingletonSpec } from './simple';

const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);
const enc = encodeURIComponent;
const rows = async (http: ConfigHttp, path: string): Promise<Record<string, Json>[]> => {
  const res = await http.get<{ data?: Record<string, Json>[] }>(path);
  return Array.isArray(res?.data) ? res.data : [];
};

/** The policy's id from its key: the audience routes address a policy by id. */
async function policyId(http: ConfigHttp, key: string): Promise<string> {
  const p = (await rows(http, '/v1/policies')).find((r) => r.key === key);
  if (!p) throw new CliError(`policy_audiences: no policy with key '${key}'; create it first (it is not part of atlas.yaml).`);
  return String(p.id);
}

/**
 * `policy_audiences`: who a policy is asked of when it is narrowed to the members of some organizations
 * (key = the policy's key). A policy that is asked of everyone has no entry; deleting one (`--prune-type
 * policy_audiences`) returns the policy to everyone.
 */
const policyAudiences: CollectionSpec = {
  kind: 'collection',
  type: 'policy_audiences',
  prune: false,
  fileKeys: ['policy', 'audience', 'organization_ids'],
  keyOf: (c) => String(isObj(c) ? (c.policy ?? '') : ''),
  async fetchLive(http) {
    const out = [];
    for (const p of (await rows(http, '/v1/policies')).filter((r) => r.audience === 'orgs')) {
      const a = await http.get<Record<string, Json>>(`/v1/policies/${enc(String(p.id))}/audience`);
      out.push({
        key: String(p.key),
        id: String(p.id),
        config: { policy: String(p.key), audience: 'orgs', organization_ids: [...((a.organization_ids as string[]) ?? [])].sort() } as Record<string, Json>,
      });
    }
    return out;
  },
  async create(http, config) {
    const c = isObj(config) ? config : {};
    await http.put(`/v1/policies/${enc(await policyId(http, String(c.policy)))}/audience`, { audience: c.audience ?? 'orgs', organization_ids: c.organization_ids ?? [] });
  },
  async update(http, live, config) {
    const c = isObj(config) ? config : {};
    await http.put(`/v1/policies/${enc(live.id)}/audience`, { audience: c.audience ?? 'orgs', organization_ids: c.organization_ids ?? [] });
  },
  async remove(http, live) {
    await http.put(`/v1/policies/${enc(live.id)}/audience`, { audience: 'everyone' });
  },
  align(live, desired) {
    // the order of organizations carries no meaning
    if (!isObj(live) || !isObj(desired) || !Array.isArray(desired.organization_ids)) return live;
    return { ...live, organization_ids: [...(desired.organization_ids as string[])].sort() };
  },
};

/**
 * `oauth_publisher_clients`: which apps (by public client_id) are attached to a verified publisher (key =
 * `<publisher domain>/<client_id>`). Attaching to a shared-sector publisher changes the subject identifiers of an
 * app that had another sector, so `allow_subject_change` must be set in the file to confirm that.
 */
const publisherClients: CollectionSpec = {
  kind: 'collection',
  type: 'oauth_publisher_clients',
  prune: false,
  fileKeys: ['publisher', 'client_id', 'allow_subject_change'],
  writeOnly: ['allow_subject_change'],
  keyOf: (c) => (isObj(c) ? `${String(c.publisher ?? '')}/${String(c.client_id ?? '')}` : ''),
  async fetchLive(http) {
    return (await rows(http, '/v1/oauth_publishers')).flatMap((p) =>
      ((p.client_ids as string[]) ?? []).map((cid) => ({ key: `${String(p.domain)}/${cid}`, id: `${String(p.id)}/${cid}`, config: { publisher: String(p.domain), client_id: cid } as Record<string, Json> })),
    );
  },
  async create(http, config) {
    const c = isObj(config) ? config : {};
    const pub = (await rows(http, '/v1/oauth_publishers')).find((r) => r.domain === c.publisher);
    if (!pub) throw new CliError(`oauth_publisher_clients: no publisher for domain '${String(c.publisher)}'; add it under oauth_publishers first.`);
    await http.put(`/v1/oauth_publishers/${enc(String(pub.id))}/clients/${enc(String(c.client_id))}`, { allow_subject_change: c.allow_subject_change === true });
  },
  async remove(http, live) {
    const [pid, cid] = live.id.split('/');
    await http.delete(`/v1/oauth_publishers/${enc(pid!)}/clients/${enc(cid!)}`);
  },
};

/** `region`: the failover region and Frontend API origin isolation. Pinning an instance to a region is a one-way action and stays a command (`atlas region pin`). */
const region = simpleSingletonSpec({ type: 'region', path: '/v1/region', fileKeys: ['failover_region', 'fapi_isolation'] });

export const SURFACE_CONFIG_TYPES: ResourceSpec[] = [policyAudiences, publisherClients, region];

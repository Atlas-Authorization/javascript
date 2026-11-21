import type { Json } from '../../serialize';
import type { CollectionSpec, ResourceSpec, SingletonSpec } from '../config';

const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);
const KEYS = ['platform', 'bundle_id', 'team_id', 'package_name', 'sha256_cert_fingerprints', 'callback_urls'] as const;
const PATH = '/v1/native_apps';

/** An app is named by what the stores name it: `ios:<bundle_id>` or `android:<package_name>`. */
const keyOf = (c: unknown): string => {
  const o = isObj(c) ? c : {};
  return `${String(o.platform ?? '')}:${String(o.platform === 'android' ? (o.package_name ?? '') : (o.bundle_id ?? ''))}`;
};

const body = (config: unknown, omit: readonly string[] = []): Record<string, Json> => {
  const o = isObj(config) ? config : {};
  const out: Record<string, Json> = {};
  for (const k of KEYS) if (o[k] !== undefined && !omit.includes(k)) out[k] = o[k]!;
  return out;
};

const norm = (fp: unknown): string => String(fp).replace(/:/g, '').toUpperCase();

/**
 * `native_apps`: the mobile apps (iOS bundle, Android package) that may sign users in, with the callback URLs
 * each accepts (Universal/App Links or a private-use scheme such as `exampleapp://oauth-callback`). Pruned only
 * with `--prune-type native_apps`. The platform of an app cannot change.
 * Routes: GET and POST /v1/native_apps; GET, PATCH and DELETE /v1/native_apps/{id}.
 */
const nativeApps: CollectionSpec = {
  kind: 'collection',
  type: 'native_apps',
  prune: false,
  fileKeys: KEYS,
  keyOf,
  async fetchLive(http) {
    const res = await http.get<{ data?: Record<string, Json>[] }>(PATH);
    return (Array.isArray(res?.data) ? res.data : []).map((row) => {
      const config: Record<string, Json> = {};
      for (const k of KEYS) if (row[k] !== undefined && row[k] !== null) config[k] = row[k]!;
      return { key: keyOf(config), id: String(row.id), config };
    });
  },
  async create(http, config) {
    await http.post(PATH, body(config));
  },
  async update(http, live, config) {
    await http.patch(`${PATH}/${encodeURIComponent(live.id)}`, body(config, ['platform']));
  },
  async remove(http, live) {
    await http.delete(`${PATH}/${encodeURIComponent(live.id)}`);
  },
  align(live, desired) {
    // fingerprints are stored upper-case with colons; a file may write them any way
    if (!isObj(live) || !isObj(desired) || !Array.isArray(live.sha256_cert_fingerprints) || !Array.isArray(desired.sha256_cert_fingerprints)) return live;
    const want = new Map((desired.sha256_cert_fingerprints as string[]).map((f) => [norm(f), f]));
    return { ...live, sha256_cert_fingerprints: (live.sha256_cert_fingerprints as string[]).map((f) => want.get(norm(f)) ?? f) };
  },
  validate(config) {
    const o = isObj(config) ? config : {};
    const out: string[] = [];
    if (o.platform !== 'ios' && o.platform !== 'android') out.push("native_apps: platform must be 'ios' or 'android'.");
    if (o.platform === 'ios' && (!o.bundle_id || !o.team_id)) out.push('native_apps: an ios app needs bundle_id and team_id.');
    if (o.platform === 'android' && (!o.package_name || !Array.isArray(o.sha256_cert_fingerprints) || !o.sha256_cert_fingerprints.length)) out.push('native_apps: an android app needs package_name and sha256_cert_fingerprints.');
    if (!Array.isArray(o.callback_urls) || o.callback_urls.length < 1 || o.callback_urls.length > 10) out.push('native_apps: callback_urls needs 1 to 10 entries.');
    return out;
  },
};

/** Live app ids by `ios:<bundle_id>` / `android:<package_name>`. */
async function appIdsByKey(http: Parameters<CollectionSpec['fetchLive']>[0]): Promise<Map<string, string>> {
  return new Map((await nativeApps.fetchLive(http)).map((e) => [e.key, e.id]));
}

const keysOf = (config: unknown): string[] => {
  const apps = isObj(config) ? config.apps : undefined;
  return Array.isArray(apps) ? apps.map(String) : [];
};

/**
 * `native_apps_publishable_key`: which native apps the publishable key may sign in (`apps: [ios:<bundle_id>, ...]`,
 * named like `native_apps` because app ids differ per instance). An empty list allows every registered app.
 * Applied after `native_apps`, so an app added in the same file can be listed.
 * Routes: GET and PUT /v1/native_apps/publishable_key.
 */
const publishableKeyApps: SingletonSpec = {
  kind: 'singleton',
  type: 'native_apps_publishable_key',
  fileKeys: ['apps'],
  async fetchLive(http) {
    const res = await http.get<{ app_ids?: string[] }>(`${PATH}/publishable_key`);
    const keyById = new Map([...(await appIdsByKey(http))].map(([k, id]) => [id, k]));
    return { apps: (res?.app_ids ?? []).map((id) => keyById.get(id) ?? id) };
  },
  async apply(http, config) {
    const ids = await appIdsByKey(http);
    const unknown = keysOf(config).filter((k) => !ids.has(k));
    if (unknown.length) throw new Error(`native_apps_publishable_key: ${unknown.join(', ')} is not a registered native app (add it under native_apps).`);
    await http.put(`${PATH}/publishable_key`, { app_ids: keysOf(config).map((k) => ids.get(k)!) });
  },
  normalize(config) {
    return { apps: [...new Set(keysOf(config))].sort() };
  },
  validate(config) {
    return keysOf(config).filter((k) => !/^(ios|android):.+/.test(k)).map((k) => `native_apps_publishable_key: ${k} must be ios:<bundle_id> or android:<package_name>.`);
  },
};

export const NATIVE_APP_CONFIG_TYPES: ResourceSpec[] = [nativeApps, publishableKeyApps];

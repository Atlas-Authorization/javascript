import { isNotFound, type ConfigHttp } from '../../config-http';
import { isSecretKey } from '../../redact';
import type { Json } from '../../serialize';
import type { CollectionSpec, SingletonSpec } from '../config';

export interface SimpleResourceOptions {
  /** The atlas.yaml section name. */
  type: string;
  /** The collection route, e.g. `/v1/log_streams`; items live at `<path>/<id>`. */
  path: string;
  /** The field that names an entry in the file and on the server (default `name`). */
  nameKey?: string;
  /** Several fields that together name an entry (joined with `/`); replaces `nameKey` as the key. */
  keyKeys?: readonly string[];
  /** Every key a file may set (include the key fields). */
  fileKeys: readonly string[];
  /** Keys the API accepts but never returns (credentials): `${VAR}` in the file, never exported, never compared. */
  writeOnly?: readonly string[];
  /** Same as `writeOnly` (a credential); kept as a separate word for readers of the specs. */
  sealed?: readonly string[];
  /** The field addressing an item in the URL when it is not the name (default: the name). */
  idKey?: string;
  /** Keys the update route accepts when it takes fewer than create (a strict PATCH); default: every writable key. */
  updateKeys?: readonly string[];
  /** Keys the create route accepts when it takes fewer than the file may set (a strict POST); default: every writable key. */
  createKeys?: readonly string[];
  /** Keys sent on create only: the API cannot change them. A different live value is a warning, not an update. */
  createOnly?: readonly string[];
  /** The verb an update uses (default `patch`). */
  updateMethod?: 'patch' | 'put';
  /** Keep only the listed rows that pass (e.g. the customised ones of a list that also shows defaults). */
  liveFilter?: (row: Record<string, Json>) => boolean;
  /** The list leaves some fields out: read `<path>/<id>` for each row. */
  detail?: boolean;
  /**
   * Keys holding an object the API returns with `has_*` / `*_names` markers in place of its
   * secrets (a sink destination). The markers are never exported; what the file sets inside
   * that the server will not return is carried over, so it is not drift.
   */
  markers?: readonly string[];
}

const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isMarker = (k: string) => k.startsWith('has_') || k.endsWith('_names');

/** `obj` without the server's secret markers. */
function withoutMarkers(v: Json | undefined): Json | undefined {
  return isObj(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => !isMarker(k))) : v;
}

/**
 * A list/create/update/delete resource as a registry spec. Deletes are opt-in per type
 * (`prune: false`: only `--prune-type <type>`), and credentials never reach an export:
 * writeOnly/sealed keys, and any key named like a secret, are dropped from the live side.
 */
export function simpleResourceSpec(o: SimpleResourceOptions): CollectionSpec {
  const keyKeys = o.keyKeys ?? [o.nameKey ?? 'name'];
  const hidden = new Set([...(o.writeOnly ?? []), ...(o.sealed ?? [])]);
  const createOnly = new Set(o.createOnly ?? []);
  const writable = o.fileKeys.filter((k) => !keyKeys.includes(k) && !createOnly.has(k));
  const url = (id: string) => `${o.path}/${encodeURIComponent(id)}`;
  const keyOfRow = (c: Json | undefined) => keyKeys.map((k) => String(isObj(c) ? (c[k] ?? '') : '')).join('/');
  const pickKeys = (src: Record<string, Json>, keys: readonly string[]) => {
    const out: Record<string, Json> = {};
    for (const k of keys) if (src[k] !== undefined) out[k] = src[k]!;
    return out;
  };
  const spec: CollectionSpec = {
    kind: 'collection',
    type: o.type,
    prune: false,
    fileKeys: o.fileKeys,
    writeOnly: [...hidden],
    keyOf: (c) => keyOfRow(c),
    async fetchLive(http: ConfigHttp) {
      const res = await http.get<{ data?: Record<string, Json>[] }>(o.path);
      let rows = (Array.isArray(res?.data) ? res.data : []).filter((r) => (o.liveFilter ? o.liveFilter(r) : true));
      if (o.detail) rows = await Promise.all(rows.map((r) => http.get<Record<string, Json>>(url(String(r[o.idKey ?? keyKeys[0]!] ?? '')))));
      return rows.map((row) => {
        const config: Record<string, Json> = {};
        for (const k of o.fileKeys) {
          if (hidden.has(k) || isSecretKey(k)) continue;
          if (row[k] === undefined || row[k] === null) continue;
          config[k] = o.markers?.includes(k) ? withoutMarkers(row[k])! : row[k]!;
        }
        const key = keyOfRow(row);
        return { key, id: String(row[o.idKey ?? keyKeys[0]!] ?? key), config };
      });
    },
    async create(http, config) {
      const src = isObj(config) ? config : {};
      await http.post(o.path, pickKeys(src, o.createKeys ? [...new Set([...keyKeys, ...o.createKeys])] : o.fileKeys));
    },
    async remove(http, live) {
      await http.delete(url(live.id));
    },
    align(live, desired) {
      if (!isObj(live) || !isObj(desired)) return live;
      const out = { ...live };
      for (const k of createOnly) if (desired[k] !== undefined && out[k] !== undefined) out[k] = desired[k]!;
      for (const k of o.markers ?? []) {
        const l = out[k];
        const d = desired[k];
        if (isObj(l) && isObj(d)) out[k] = { ...Object.fromEntries(Object.entries(d).filter(([dk]) => !(dk in l))), ...l };
      }
      return out;
    },
    warnings(config, live) {
      if (!isObj(config) || !isObj(live)) return [];
      return [...createOnly].filter((k) => config[k] !== undefined && live[k] !== undefined && !same(config[k], live[k])).map(
        (k) => `${o.type} ${keyOfRow(config)}: ${k} cannot be changed in place; delete the entry (--prune-type ${o.type}) and apply again to recreate it`,
      );
    },
  };
  if (writable.length) {
    spec.update = async (http, live, config) => {
      const body = pickKeys(isObj(config) ? config : {}, o.updateKeys ?? writable);
      if (o.updateMethod === 'put') await http.put(url(live.id), body);
      else await http.patch(url(live.id), body);
    };
  }
  return spec;
}

export interface SimpleSingletonOptions {
  type: string;
  path: string;
  fileKeys: readonly string[];
  /** The verb that saves it (default `put`). */
  method?: 'put' | 'patch';
  /** Credentials the API takes but never returns: never exported, never compared. */
  sealed?: readonly string[];
  /** Keys holding an object the API returns with secret markers; see `SimpleResourceOptions.markers`. */
  markers?: readonly string[];
  /** Reshape the GET body into the file's keys (default: pick `fileKeys`). */
  read?: (res: Record<string, Json>) => Record<string, Json>;
  /** Extra keys a file may set that the server never returns (kept out of exports and comparisons). */
  inputOnly?: readonly string[];
}

/** A one-document resource (GET + PUT/PATCH on one route) as a registry spec. */
export function simpleSingletonSpec(o: SimpleSingletonOptions): SingletonSpec {
  const hidden = new Set([...(o.sealed ?? []), ...(o.inputOnly ?? [])]);
  const body = (c: Json) => {
    const src = isObj(c) ? c : {};
    const out: Record<string, Json> = {};
    for (const k of [...o.fileKeys, ...(o.inputOnly ?? [])]) if (src[k] !== undefined) out[k] = src[k]!;
    return out;
  };
  return {
    kind: 'singleton',
    type: o.type,
    fileKeys: [...o.fileKeys, ...(o.inputOnly ?? [])],
    async fetchLive(http) {
      let res: Record<string, Json>;
      try {
        res = await http.get<Record<string, Json>>(o.path);
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
      const row = o.read ? o.read(res ?? {}) : (res ?? {});
      const config: Record<string, Json> = {};
      for (const k of o.fileKeys) {
        if (hidden.has(k) || isSecretKey(k) || row[k] === undefined) continue;
        config[k] = o.markers?.includes(k) ? withoutMarkers(row[k])! : row[k]!;
      }
      return config;
    },
    align(live, desired) {
      if (!isObj(live) || !isObj(desired)) return live;
      const out = { ...live };
      for (const k of o.markers ?? []) {
        const l = out[k];
        const d = desired[k];
        if (isObj(l) && isObj(d)) out[k] = { ...Object.fromEntries(Object.entries(d).filter(([dk]) => !(dk in l))), ...l };
        else if (l === undefined && d !== undefined) out[k] = d;
      }
      for (const k of hidden) if (desired[k] !== undefined) out[k] = desired[k]!;
      return out;
    },
    async apply(http, config) {
      if (o.method === 'patch') await http.patch(o.path, body(config));
      else await http.put(o.path, body(config));
    },
  };
}

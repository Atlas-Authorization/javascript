import type { ConfigHttp } from '../../config-http';
import type { Json } from '../../serialize';
import type { SingletonSpec } from '../config';

const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * An instance-wide settings document read with GET and written with PUT at one path.
 * Keys the file leaves out are not sent (the routes merge), and a key the server does not
 * return is left out of the live side. `liveOf` reshapes an answer that wraps the document
 * (null = nothing set).
 */
export function settingsSpec(o: {
  type: string;
  path: string;
  fileKeys: readonly string[];
  liveOf?: (res: Record<string, Json>) => Record<string, Json> | null;
}): SingletonSpec {
  const pick = (src: Record<string, Json>): Record<string, Json> => {
    const out: Record<string, Json> = {};
    for (const k of o.fileKeys) if (src[k] !== undefined) out[k] = src[k]!;
    return out;
  };
  return {
    kind: 'singleton',
    type: o.type,
    fileKeys: o.fileKeys,
    async fetchLive(http: ConfigHttp) {
      const res = await http.get<Record<string, Json>>(o.path);
      if (!isObj(res)) return null;
      const doc = o.liveOf ? o.liveOf(res) : res;
      return doc ? pick(doc) : null;
    },
    async apply(http, config) {
      await http.put(o.path, pick(isObj(config) ? config : {}));
    },
  };
}

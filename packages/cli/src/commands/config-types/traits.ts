import type { Json } from '../../serialize';
import type { ResourceSpec } from '../config';

const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * `user_traits_schema`: the instance's metadata schema, one JSON Schema per metadata bag, plus
 * the enforcement mode (off | warn | enforce). Maps 1:1 to GET/PUT /v1/instance/user_traits_schema;
 * a PUT replaces the whole `schemas` map, so a bag dropped from the file is dropped on the server.
 */
export const TRAITS_SPECS: ResourceSpec[] = [
  {
    kind: 'singleton',
    type: 'user_traits_schema',
    fileKeys: ['enforcement', 'schemas'],
    async fetchLive(http) {
      const row = await http.get<{ version?: number; enforcement?: string; schemas?: Json }>('/v1/instance/user_traits_schema');
      const schemas = isObj(row.schemas) ? row.schemas : {};
      // Version 0 with nothing stored is "never configured": nothing to export.
      if (!row.version && Object.keys(schemas).length === 0) return null;
      return { enforcement: row.enforcement ?? 'off', schemas };
    },
    async apply(http, config) {
      const c = isObj(config) ? config : {};
      await http.put('/v1/instance/user_traits_schema', {
        ...(c.enforcement !== undefined ? { enforcement: c.enforcement } : {}),
        ...(c.schemas !== undefined ? { schemas: c.schemas } : {}),
      });
    },
  },
];

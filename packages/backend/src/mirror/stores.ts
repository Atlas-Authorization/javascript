import type { ChangeResourceType } from '../client/changes';
import type { ChangeMirrorStore, MirroredRecord } from './types';

/** In-memory store: tests and single-process apps. */
export function memoryMirrorStore(): ChangeMirrorStore {
  const rows = new Map<string, MirroredRecord>();
  let cursor: number | null = null;
  const key = (t: string, id: string) => `${t}\u0000${id}`;
  return {
    async getCursor() {
      return cursor;
    },
    async setCursor(seq) {
      cursor = seq;
    },
    async upsert(record) {
      const held = rows.get(key(record.resource_type, record.resource_id));
      if (held && held.version >= record.version) return false;
      rows.set(key(record.resource_type, record.resource_id), record);
      return true;
    },
    async remove(type, id, version) {
      const held = rows.get(key(type, id));
      if (!held || held.version > version) return false;
      rows.delete(key(type, id));
      return true;
    },
    async get(type, id) {
      return rows.get(key(type, id)) ?? null;
    },
    async list(type) {
      return [...rows.values()].filter((r) => r.resource_type === type);
    },
    async pruneBefore(type, version) {
      const gone: string[] = [];
      for (const [k, r] of rows) {
        if (r.resource_type === type && r.version < version) {
          rows.delete(k);
          gone.push(r.resource_id);
        }
      }
      return gone;
    },
  };
}

/**
 * The slice of an ioredis-style client the Redis store uses. `eval` takes
 * `(script, numKeys, ...keysAndArgs)`; `hget` and `hgetall` return strings.
 */
export interface MirrorRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

// KEYS[1] = hash, ARGV[1] = id, ARGV[2] = version, ARGV[3] = JSON {v, d}. Returns 1 when written.
const UPSERT_LUA = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if cur and cjson.decode(cur).v >= tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1`;
// Delete only when the held version is not above ARGV[2]. Returns 1 when deleted.
const REMOVE_LUA = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if not cur or cjson.decode(cur).v > tonumber(ARGV[2]) then return 0 end
redis.call('HDEL', KEYS[1], ARGV[1])
return 1`;

/** Redis store: one hash per resource type under `prefix`; writes are version-guarded by a Lua script. */
export function redisMirrorStore(redis: MirrorRedisClient, options: { prefix?: string } = {}): ChangeMirrorStore {
  const prefix = options.prefix ?? 'atlas:mirror';
  const hash = (t: ChangeResourceType) => `${prefix}:${t}`;
  const decode = (type: ChangeResourceType, id: string, raw: string): MirroredRecord => {
    const { v, d } = JSON.parse(raw) as { v: number; d: Record<string, unknown> };
    return { resource_type: type, resource_id: id, version: v, data: d };
  };
  return {
    async getCursor() {
      const raw = await redis.get(`${prefix}:cursor`);
      return raw === null ? null : Number(raw);
    },
    async setCursor(seq) {
      await redis.set(`${prefix}:cursor`, String(seq));
    },
    async upsert(r) {
      const res = await redis.eval(UPSERT_LUA, 1, hash(r.resource_type), r.resource_id, String(r.version), JSON.stringify({ v: r.version, d: r.data }));
      return Number(res) === 1;
    },
    async remove(type, id, version) {
      return Number(await redis.eval(REMOVE_LUA, 1, hash(type), id, String(version))) === 1;
    },
    async get(type, id) {
      const raw = await redis.hget(hash(type), id);
      return raw === null ? null : decode(type, id, raw);
    },
    async list(type) {
      return Object.entries(await redis.hgetall(hash(type))).map(([id, raw]) => decode(type, id, raw));
    },
    async pruneBefore(type, version) {
      const gone: string[] = [];
      for (const r of await this.list(type)) {
        if (r.version < version && (await this.remove(type, r.resource_id, version - 1))) gone.push(r.resource_id);
      }
      return gone;
    },
  };
}

/** A `pg`-style query function: `(sql, params) => { rows, rowCount }`. */
export type MirrorQueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;

export interface PostgresMirrorStore extends ChangeMirrorStore {
  /** Idempotent DDL for the two tables. Run it once, or put it in your migrations. */
  migrationSql(): string;
}

/**
 * Postgres store: `<table>` holds the records (primary key resource_type, resource_id; a
 * `version` guard on every write) and `<table>_state` holds the cursor.
 */
export function postgresMirrorStore(query: MirrorQueryFn, options: { table?: string } = {}): PostgresMirrorStore {
  const table = options.table ?? 'atlas_mirror';
  // The name is interpolated into SQL (identifiers cannot be parameters): refuse anything but a plain identifier.
  if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(table)) throw new Error(`postgresMirrorStore: table '${table}' is not a plain identifier.`);
  const state = `${table}_state`;
  const toRecord = (row: any): MirroredRecord => ({
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    version: Number(row.version),
    data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
  });
  return {
    migrationSql: () =>
      `CREATE TABLE IF NOT EXISTS ${table} (
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  version bigint NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (resource_type, resource_id)
);
CREATE TABLE IF NOT EXISTS ${state} (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cursor bigint NOT NULL
);`,
    async getCursor() {
      const res = await query(`SELECT cursor FROM ${state} WHERE id = 1`);
      return res.rows[0] ? Number(res.rows[0].cursor) : null;
    },
    async setCursor(seq) {
      await query(`INSERT INTO ${state} (id, cursor) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET cursor = EXCLUDED.cursor`, [seq]);
    },
    async upsert(r) {
      const res = await query(
        `INSERT INTO ${table} AS t (resource_type, resource_id, version, data) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (resource_type, resource_id) DO UPDATE SET version = EXCLUDED.version, data = EXCLUDED.data
         WHERE t.version < EXCLUDED.version`,
        [r.resource_type, r.resource_id, r.version, JSON.stringify(r.data)],
      );
      return (res.rowCount ?? 0) > 0;
    },
    async remove(type, id, version) {
      const res = await query(`DELETE FROM ${table} WHERE resource_type = $1 AND resource_id = $2 AND version <= $3`, [type, id, version]);
      return (res.rowCount ?? 0) > 0;
    },
    async get(type, id) {
      const res = await query(`SELECT * FROM ${table} WHERE resource_type = $1 AND resource_id = $2`, [type, id]);
      return res.rows[0] ? toRecord(res.rows[0]) : null;
    },
    async list(type) {
      return (await query(`SELECT * FROM ${table} WHERE resource_type = $1 ORDER BY resource_id`, [type])).rows.map(toRecord);
    },
    async pruneBefore(type, version) {
      const res = await query(`DELETE FROM ${table} WHERE resource_type = $1 AND version < $2 RETURNING resource_id`, [type, version]);
      return res.rows.map((r) => r.resource_id as string);
    },
  };
}

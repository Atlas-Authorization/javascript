/**
 * `@atlasauth/backend/mirror/drizzle`: a mirror store that writes into YOUR Drizzle tables
 * (Postgres or SQLite), one table per resource type, through a column map. No dependency on
 * `drizzle-orm`: you pass the module in, so it uses your version.
 */
import type { ChangeResourceType } from '../client/changes';
import type { ChangeMirrorStore, MirroredRecord } from './types';

/** The operators of `drizzle-orm` the store uses: pass `import * as orm from 'drizzle-orm'`. */
export interface DrizzleOperators {
  and: (...c: any[]) => any;
  or: (...c: any[]) => any;
  eq: (col: any, v: unknown) => any;
  lt: (col: any, v: unknown) => any;
  lte: (col: any, v: unknown) => any;
  isNull: (col: any) => any;
}

export interface DrizzleMirrorTable {
  /** The Drizzle table object. */
  table: any;
  /** Property names on the table. `version` is a number column; leave it NULL on rows you own so the mirror never touches them. */
  columns: { id: string; version: string; deletedAt?: string };
  /** Atlas resource (webhook shape) to your row, keyed by property name. Do not return the id or version columns. */
  map: (data: Record<string, unknown>) => Record<string, unknown>;
  /** `soft` (needs `columns.deletedAt`) sets it instead of deleting the row. Default `hard`. */
  onDelete?: 'hard' | 'soft';
  /** The value written to `deletedAt`. Default `new Date()`. */
  deletedValue?: () => unknown;
}

export interface DrizzleMirrorOptions {
  /** A Drizzle database (`pg`, `postgres-js`, `node-postgres`, `better-sqlite3` ...). */
  db: any;
  orm: DrizzleOperators;
  tables: Partial<Record<ChangeResourceType, DrizzleMirrorTable>>;
  /** Where the feed position lives (one row in a table of yours). */
  cursor: { get(db: any): Promise<number | null>; set(db: any, seq: number): Promise<void> };
}

export function drizzleMirrorStore(options: DrizzleMirrorOptions): ChangeMirrorStore {
  const { orm, tables } = options;
  const cfg = (type: ChangeResourceType): DrizzleMirrorTable => {
    const t = tables[type];
    if (!t) throw new Error(`drizzleMirrorStore: no table configured for '${type}'.`);
    if (t.onDelete === 'soft' && !t.columns.deletedAt) throw new Error(`drizzleMirrorStore: '${type}' uses soft delete but has no columns.deletedAt.`);
    return t;
  };

  const build = (db: any): ChangeMirrorStore => {
    const live = (t: DrizzleMirrorTable) => (t.onDelete === 'soft' ? [orm.isNull(t.table[t.columns.deletedAt!])] : []);
    const toRecord = (type: ChangeResourceType, t: DrizzleMirrorTable, row: any): MirroredRecord => ({
      resource_type: type,
      resource_id: String(row[t.columns.id]),
      version: Number(row[t.columns.version]),
      data: row,
    });
    /** Delete (hard) or mark (soft) rows matching `where`; returns the ids. */
    const retire = async (t: DrizzleMirrorTable, where: any, version?: number): Promise<string[]> => {
      const idCol = t.table[t.columns.id];
      const rows =
        t.onDelete === 'soft'
          ? await db
              .update(t.table)
              .set({ [t.columns.deletedAt!]: (t.deletedValue ?? (() => new Date()))(), ...(version === undefined ? {} : { [t.columns.version]: version }) })
              .where(where)
              .returning({ id: idCol })
          : await db.delete(t.table).where(where).returning({ id: idCol });
      return rows.map((r: { id: unknown }) => String(r.id));
    };

    return {
      async getCursor() {
        return options.cursor.get(db);
      },
      async setCursor(seq) {
        await options.cursor.set(db, seq);
      },
      async upsert(r) {
        const t = cfg(r.resource_type);
        const mapped = {
          ...t.map(r.data),
          [t.columns.version]: r.version,
          // A re-created resource is live again.
          ...(t.onDelete === 'soft' ? { [t.columns.deletedAt!]: null } : {}),
        };
        const idCol = t.table[t.columns.id];
        const verCol = t.table[t.columns.version];
        const rows = await db
          .insert(t.table)
          .values({ ...mapped, [t.columns.id]: r.resource_id })
          .onConflictDoUpdate({ target: idCol, set: mapped, setWhere: orm.or(orm.isNull(verCol), orm.lt(verCol, r.version)) })
          .returning({ id: idCol });
        return rows.length > 0;
      },
      async remove(type, id, version) {
        const t = cfg(type);
        const where = orm.and(orm.eq(t.table[t.columns.id], id), orm.lte(t.table[t.columns.version], version), ...live(t));
        return (await retire(t, where, version)).length > 0;
      },
      async get(type, id) {
        const t = cfg(type);
        const rows = await db
          .select()
          .from(t.table)
          .where(orm.and(orm.eq(t.table[t.columns.id], id), ...live(t)));
        return rows[0] ? toRecord(type, t, rows[0]) : null;
      },
      async list(type) {
        const t = cfg(type);
        const rows = await db
          .select()
          .from(t.table)
          .where(orm.and(...live(t)));
        return rows.map((row: any) => toRecord(type, t, row));
      },
      async pruneBefore(type, version) {
        const t = cfg(type);
        return retire(t, orm.and(orm.lt(t.table[t.columns.version], version), ...live(t)));
      },
      async transaction(fn) {
        return db.transaction((tx: any) => fn(build(tx)));
      },
    };
  };
  return build(options.db);
}

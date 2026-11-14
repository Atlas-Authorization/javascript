/**
 * `@atlasauth/backend/mirror/prisma`: a mirror store that writes into YOUR Prisma models, one
 * model per resource type, through a field map. No dependency on `@prisma/client`.
 */
import type { ChangeResourceType } from '../client/changes';
import type { ChangeMirrorStore, MirroredRecord } from './types';

export interface PrismaMirrorModel {
  /** The model's delegate name on the client, e.g. `'atlasUser'` for `prisma.atlasUser`. */
  model: string;
  /** Field names. `id` must be unique; `version` is an Int/BigInt field, left NULL on rows you own so the mirror never touches them. */
  fields: { id: string; version: string; deletedAt?: string };
  /** Atlas resource (webhook shape) to your fields. Do not return the id or version fields. */
  map: (data: Record<string, unknown>) => Record<string, unknown>;
  /** `soft` (needs `fields.deletedAt`) sets it instead of deleting the row. Default `hard`. */
  onDelete?: 'hard' | 'soft';
  /** The value written to `deletedAt`. Default `new Date()`. */
  deletedValue?: () => unknown;
}

export interface PrismaMirrorOptions {
  /** A `PrismaClient`. Its `$transaction(fn)` form is used for atomic pages. */
  prisma: any;
  models: Partial<Record<ChangeResourceType, PrismaMirrorModel>>;
  /** Where the feed position lives (one row in a model of yours). */
  cursor: { get(client: any): Promise<number | null>; set(client: any, seq: number): Promise<void> };
}

export function prismaMirrorStore(options: PrismaMirrorOptions): ChangeMirrorStore {
  const cfg = (type: ChangeResourceType): PrismaMirrorModel => {
    const m = options.models[type];
    if (!m) throw new Error(`prismaMirrorStore: no model configured for '${type}'.`);
    if (m.onDelete === 'soft' && !m.fields.deletedAt) throw new Error(`prismaMirrorStore: '${type}' uses soft delete but has no fields.deletedAt.`);
    return m;
  };

  const build = (client: any): ChangeMirrorStore => {
    const live = (m: PrismaMirrorModel) => (m.onDelete === 'soft' ? { [m.fields.deletedAt!]: null } : {});
    const toRecord = (type: ChangeResourceType, m: PrismaMirrorModel, row: any): MirroredRecord => ({
      resource_type: type,
      resource_id: String(row[m.fields.id]),
      version: Number(row[m.fields.version]),
      data: row,
    });
    const retire = async (m: PrismaMirrorModel, where: Record<string, unknown>, version?: number): Promise<number> => {
      const d = client[m.model];
      if (m.onDelete === 'soft') {
        const data = { [m.fields.deletedAt!]: (m.deletedValue ?? (() => new Date()))(), ...(version === undefined ? {} : { [m.fields.version]: version }) };
        return (await d.updateMany({ where, data })).count;
      }
      return (await d.deleteMany({ where })).count;
    };

    return {
      async getCursor() {
        return options.cursor.get(client);
      },
      async setCursor(seq) {
        await options.cursor.set(client, seq);
      },
      async upsert(r) {
        const m = cfg(r.resource_type);
        const d = client[m.model];
        const data = { ...m.map(r.data), [m.fields.version]: r.version, ...(m.onDelete === 'soft' ? { [m.fields.deletedAt!]: null } : {}) };
        // Update only when the held version is lower (or the row is one you own, version NULL).
        const updated = await d.updateMany({
          where: { [m.fields.id]: r.resource_id, OR: [{ [m.fields.version]: null }, { [m.fields.version]: { lt: r.version } }] },
          data,
        });
        if (updated.count > 0) return true;
        if (await d.findUnique({ where: { [m.fields.id]: r.resource_id }, select: { [m.fields.id]: true } })) return false;
        await d.create({ data: { ...data, [m.fields.id]: r.resource_id } });
        return true;
      },
      async remove(type, id, version) {
        const m = cfg(type);
        return (await retire(m, { [m.fields.id]: id, [m.fields.version]: { lte: version }, ...live(m) }, version)) > 0;
      },
      async get(type, id) {
        const m = cfg(type);
        const row = await client[m.model].findFirst({ where: { [m.fields.id]: id, ...live(m) } });
        return row ? toRecord(type, m, row) : null;
      },
      async list(type) {
        const m = cfg(type);
        const rows = await client[m.model].findMany({ where: { ...live(m) } });
        return rows.map((row: any) => toRecord(type, m, row));
      },
      async pruneBefore(type, version) {
        const m = cfg(type);
        const where = { [m.fields.version]: { lt: version }, ...live(m) };
        const rows = await client[m.model].findMany({ where, select: { [m.fields.id]: true } });
        const ids = rows.map((row: any) => String(row[m.fields.id]));
        if (ids.length > 0) await retire(m, { ...where, [m.fields.id]: { in: ids } });
        return ids;
      },
      async transaction(fn) {
        return client.$transaction((tx: any) => fn(build(tx)));
      },
    };
  };
  return build(options.prisma);
}

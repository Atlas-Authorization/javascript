import { AtlasApiError } from '../client/error';
import type { ChangeResourceType } from '../client/changes';
import type { ChangeMirrorStore, Mirror, MirrorChange, MirrorOptions, SyncResult } from './types';

const MAX_RESNAPSHOTS = 3;

/**
 * Keep a copy of Atlas resources in your own store, from `GET /v1/changes` and the
 * snapshot endpoint. `sync()` reads the feed from the stored position and applies each
 * entry by (resource, id, version = seq): an entry not above the held version is dropped,
 * a delete (or an update whose resource is already gone) removes the record. When the
 * position was trimmed (410 `RESYNC_REQUIRED`) or the store has never synced, the mirror
 * rebuilds from snapshots and then follows the feed from the snapshot position.
 */
export function createMirror(options: MirrorOptions): Mirror {
  const { client, store, onChange, onStale, onError } = options;
  const resources = [...new Set(options.resources)];
  if (resources.length === 0) throw new Error('createMirror: resources must name at least one resource type.');
  const now = options.now ?? Date.now;
  const pollMs = options.pollIntervalMs ?? 5000;
  const pageSize = options.pageSize ?? 200;

  let lastSyncAt: number | null = null;
  let inflight: Promise<SyncResult> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let lastCursor: number | null = null;

  const inTx = <T>(fn: (s: ChangeMirrorStore) => Promise<T>): Promise<T> => (store.transaction ? store.transaction(fn) : fn(store));

  const isStale = () => lastSyncAt === null || (options.maxStalenessMs !== undefined && now() - lastSyncAt > options.maxStalenessMs);
  const checkStale = () => {
    if (options.maxStalenessMs !== undefined && isStale()) onStale?.({ reason: 'max_staleness', last_sync_at: lastSyncAt });
  };

  /** Rebuild every watched type from snapshots; returns the feed position to follow from. */
  async function resnapshot(): Promise<{ cursor: number; applied: number }> {
    let cursor = Number.POSITIVE_INFINITY;
    let applied = 0;
    for (const type of resources) {
      let attempt = 0;
      for (;;) {
        try {
          const done = await snapshotType(type);
          cursor = Math.min(cursor, done.snapshotSeq);
          applied += done.applied;
          break;
        } catch (e) {
          // The snapshot position was trimmed mid-walk: start that type over.
          if (e instanceof AtlasApiError && e.status === 410 && ++attempt < MAX_RESNAPSHOTS) continue;
          throw e;
        }
      }
    }
    await store.setCursor(cursor);
    return { cursor, applied };
  }

  async function snapshotType(type: ChangeResourceType): Promise<{ snapshotSeq: number; applied: number }> {
    let cursor: string | undefined;
    let snapshotSeq = 0;
    let applied = 0;
    do {
      const page = await client.changes.snapshot(type, { ...(cursor ? { cursor } : {}), limit: 200 });
      snapshotSeq = page.snapshot_seq;
      await inTx(async (tx) => {
        for (const row of page.data) {
          const id = row.id;
          if (typeof id !== 'string') throw new Error(`createMirror: a ${type} snapshot row has no string id.`);
          if (await tx.upsert({ resource_type: type, resource_id: id, version: snapshotSeq, data: row })) {
            applied++;
            await onChange?.({ resource_type: type, resource_id: id, op: 'snapshot', seq: snapshotSeq, data: row });
          }
        }
      });
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    // Whatever the snapshot did not mention was deleted while we were away.
    const gone = await inTx(async (tx) => {
      const ids = await tx.pruneBefore(type, snapshotSeq);
      for (const id of ids) await onChange?.({ resource_type: type, resource_id: id, op: 'delete', seq: snapshotSeq, data: null });
      return ids;
    });
    applied += gone.length;
    return { snapshotSeq, applied };
  }

  async function run(): Promise<SyncResult> {
    let applied = 0;
    let resnapshotted = false;
    let cursor = await store.getCursor();
    if (cursor === null) {
      ({ cursor, applied } = await resnapshot());
      resnapshotted = true;
    }
    for (;;) {
      let page;
      try {
        page = await client.changes.list({ after: cursor, types: resources, limit: pageSize });
      } catch (e) {
        if (e instanceof AtlasApiError && e.status === 410) {
          onStale?.({ reason: 'resync_required', last_sync_at: lastSyncAt });
          const r = await resnapshot();
          cursor = r.cursor;
          applied += r.applied;
          resnapshotted = true;
          continue;
        }
        throw e;
      }
      const next = page.next_after;
      await inTx(async (tx) => {
        for (const change of page.data) {
          if (!resources.includes(change.resource_type)) continue;
          const gone = change.op === 'delete' || change.data === null;
          const wrote = gone
            ? await tx.remove(change.resource_type, change.resource_id, change.version)
            : await tx.upsert({ resource_type: change.resource_type, resource_id: change.resource_id, version: change.version, data: change.data! });
          if (!wrote) continue;
          applied++;
          const event: MirrorChange = {
            resource_type: change.resource_type,
            resource_id: change.resource_id,
            op: gone ? 'delete' : change.op,
            seq: change.seq,
            data: gone ? null : change.data,
          };
          await onChange?.(event);
        }
        await tx.setCursor(next);
      });
      cursor = next;
      if (!page.has_more) break;
    }
    lastSyncAt = now();
    lastCursor = cursor;
    if (options.consumer) {
      // Best effort: the local cursor is the source of truth; the server copy only makes lag visible.
      try {
        await client.changes.ack(options.consumer, cursor);
      } catch (e) {
        onError?.(e);
      }
    }
    return { applied, resnapshotted, cursor };
  }

  function sync(): Promise<SyncResult> {
    inflight ??= run().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function schedule(delay = pollMs) {
    if (!running) return;
    timer = setTimeout(async () => {
      try {
        await sync();
      } catch (e) {
        onError?.(e);
        checkStale();
      }
      schedule();
    }, delay);
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    sync,
    start() {
      if (running) return;
      running = true;
      schedule(0);
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      await inflight?.catch(() => undefined);
    },
    get: (type, id) => store.get(type, id),
    list: (type) => store.list(type),
    isStale,
    status: () => ({ cursor: lastCursor, last_sync_at: lastSyncAt, stale: isStale() }),
    migrationSql() {
      const sql = (store as { migrationSql?: () => string }).migrationSql;
      if (!sql) throw new Error('migrationSql: this store has no SQL. Use postgresMirrorStore.');
      return sql.call(store);
    },
  };
}

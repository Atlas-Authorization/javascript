import { describe, expect, it, vi } from 'vitest';
import { AtlasApiError } from '../client/error';
import type { Change, ChangeResourceType } from '../client/changes';
import { createMirror } from './create-mirror';
import { memoryMirrorStore, postgresMirrorStore } from './stores';
import type { MirrorChange, MirrorClient } from './types';

const user = (id: string, extra: Record<string, unknown> = {}) => ({ object: 'user', id, ...extra });
const change = (seq: number, id: string, op: Change['op'], data: Record<string, unknown> | null, type: ChangeResourceType = 'user'): Change => ({
  object: 'change',
  seq,
  resource_type: type,
  resource_id: id,
  op,
  version: seq,
  occurred_at: 0,
  data,
});

/** A scripted feed: `pages` answer successive list calls; `snapshots` answer by type. */
function fakeClient(opts: { pages?: Array<Change[] | Error>; snapshots?: Partial<Record<ChangeResourceType, Array<Record<string, unknown>>>>; snapshotSeq?: number }) {
  const pages = [...(opts.pages ?? [])];
  const listCalls: Array<{ after?: number; types?: ChangeResourceType[] }> = [];
  const acks: Array<[string, number]> = [];
  const client: MirrorClient = {
    changes: {
      async list(p) {
        listCalls.push({ after: p?.after, types: p?.types });
        const next = pages.shift() ?? [];
        if (next instanceof Error) throw next;
        const last = next[next.length - 1];
        return { data: next, has_more: pages.length > 0 && !(pages[0] instanceof Error), next_after: last?.seq ?? p?.after ?? 0, head_seq: last?.seq ?? 0 };
      },
      async snapshot(type) {
        return { data: opts.snapshots?.[type] ?? [], next_cursor: null, snapshot_seq: opts.snapshotSeq ?? 10 };
      },
      async ack(name, seq) {
        acks.push([name, seq]);
      },
    },
  };
  return { client, listCalls, acks };
}

const gone410 = () => new AtlasApiError(410, [{ code: 'RESYNC_REQUIRED', message: 'trimmed' }]);

describe('createMirror', () => {
  it('rejects an empty resource list', () => {
    expect(() => createMirror({ client: fakeClient({}).client, resources: [], store: memoryMirrorStore() })).toThrow(/resources/);
  });

  it('snapshots first, then follows the feed from the snapshot position', async () => {
    const f = fakeClient({ snapshots: { user: [user('u1'), user('u2')] }, snapshotSeq: 10, pages: [[change(11, 'u3', 'create', user('u3'))]] });
    const store = memoryMirrorStore();
    const seen: MirrorChange[] = [];
    const m = createMirror({ client: f.client, resources: ['user'], store, onChange: (c) => void seen.push(c) });
    const r = await m.sync();
    expect(r).toEqual({ applied: 3, resnapshotted: true, cursor: 11 });
    expect(f.listCalls[0]).toEqual({ after: 10, types: ['user'] });
    expect((await m.list('user')).map((x) => x.resource_id).sort()).toEqual(['u1', 'u2', 'u3']);
    expect(seen.map((c) => c.op)).toEqual(['snapshot', 'snapshot', 'create']);
    expect(await store.getCursor()).toBe(11);
  });

  it('applies updates and deletes; a stale entry is dropped and not reported', async () => {
    const f = fakeClient({
      snapshots: { user: [user('u1', { v: 'snap' })] },
      snapshotSeq: 10,
      pages: [[change(9, 'u1', 'update', user('u1', { v: 'old' })), change(12, 'u1', 'update', user('u1', { v: 'new' })), change(13, 'u1', 'delete', null)]],
    });
    const seen: MirrorChange[] = [];
    const m = createMirror({ client: f.client, resources: ['user'], store: memoryMirrorStore(), onChange: (c) => void seen.push(c) });
    await m.sync();
    expect(await m.get('user', 'u1')).toBeNull();
    expect(seen.map((c) => `${c.op}:${c.seq}`)).toEqual(['snapshot:10', 'update:12', 'delete:13']);
  });

  it('treats an update whose resource is gone (null data) as a delete', async () => {
    const f = fakeClient({ snapshots: { user: [user('u1')] }, snapshotSeq: 5, pages: [[change(6, 'u1', 'update', null)]] });
    const m = createMirror({ client: f.client, resources: ['user'], store: memoryMirrorStore() });
    await m.sync();
    expect(await m.get('user', 'u1')).toBeNull();
  });

  it('re-snapshots on 410, drops rows the snapshot no longer has, and calls onStale', async () => {
    const store = memoryMirrorStore();
    await store.upsert({ resource_type: 'user', resource_id: 'old', version: 3, data: user('old') });
    await store.upsert({ resource_type: 'user', resource_id: 'kept', version: 3, data: user('kept') });
    await store.setCursor(4);
    const f = fakeClient({ pages: [gone410()], snapshots: { user: [user('kept')] }, snapshotSeq: 50 });
    const onStale = vi.fn();
    const seen: MirrorChange[] = [];
    const m = createMirror({ client: f.client, resources: ['user'], store, onStale, onChange: (c) => void seen.push(c) });
    const r = await m.sync();
    expect(r.resnapshotted).toBe(true);
    expect(onStale).toHaveBeenCalledWith({ reason: 'resync_required', last_sync_at: null });
    expect(await m.get('user', 'old')).toBeNull();
    expect((await m.get('user', 'kept'))!.version).toBe(50);
    expect(seen.some((c) => c.resource_id === 'old' && c.op === 'delete')).toBe(true);
    expect(await store.getCursor()).toBe(50);
  });

  it('acks the server-held position when a consumer name is set, and survives an ack failure', async () => {
    const f = fakeClient({ snapshots: { user: [] }, snapshotSeq: 7, pages: [[change(8, 'u1', 'create', user('u1'))]] });
    const onError = vi.fn();
    const m = createMirror({ client: f.client, resources: ['user'], store: memoryMirrorStore(), consumer: 'billing-db', onError });
    await m.sync();
    expect(f.acks).toEqual([['billing-db', 8]]);
    f.client.changes.ack = async () => {
      throw new Error('down');
    };
    await m.sync();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('a throwing onChange inside a transactional store rolls the page back and keeps the cursor', async () => {
    const base = memoryMirrorStore();
    let committed = 0;
    const store = {
      ...base,
      // A fake transaction: snapshot the cursor and rows are not needed, count commits only.
      async transaction<T>(fn: (tx: typeof base) => Promise<T>) {
        const out = await fn(base);
        committed++;
        return out;
      },
    };
    await base.setCursor(0);
    const f = fakeClient({ pages: [[change(1, 'u1', 'create', user('u1'))]] });
    const m = createMirror({
      client: f.client,
      resources: ['user'],
      store,
      onChange: () => {
        throw new Error('boom');
      },
    });
    await expect(m.sync()).rejects.toThrow('boom');
    expect(committed).toBe(0);
    expect(await base.getCursor()).toBe(0);
  });

  it('reports staleness after maxStalenessMs and clears it on a good sync', async () => {
    let t = 1000;
    const f = fakeClient({ snapshots: { user: [] }, snapshotSeq: 1 });
    const m = createMirror({ client: f.client, resources: ['user'], store: memoryMirrorStore(), maxStalenessMs: 500, now: () => t });
    expect(m.isStale()).toBe(true);
    await m.sync();
    expect(m.isStale()).toBe(false);
    t += 501;
    expect(m.isStale()).toBe(true);
    await m.sync();
    expect(m.status()).toMatchObject({ stale: false, last_sync_at: 1501 });
  });

  it('concurrent sync calls share one run', async () => {
    const f = fakeClient({ snapshots: { user: [] } });
    const spy = vi.spyOn(f.client.changes, 'snapshot');
    const m = createMirror({ client: f.client, resources: ['user'], store: memoryMirrorStore() });
    await Promise.all([m.sync(), m.sync()]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('migrationSql throws for a store without SQL and returns DDL for postgres', () => {
    const f = fakeClient({});
    expect(() => createMirror({ client: f.client, resources: ['user'], store: memoryMirrorStore() }).migrationSql()).toThrow(/postgresMirrorStore/);
    const pg = postgresMirrorStore(async () => ({ rows: [] }));
    expect(createMirror({ client: f.client, resources: ['user'], store: pg }).migrationSql()).toContain('CREATE TABLE IF NOT EXISTS atlas_mirror');
  });
});

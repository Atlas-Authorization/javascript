import type { Change, ChangeResourceType } from '../client/changes';

/** One resource as the mirror holds it. */
export interface MirroredRecord {
  resource_type: ChangeResourceType;
  resource_id: string;
  /** The feed position this copy was taken at (a snapshot row carries the snapshot position). */
  version: number;
  data: Record<string, unknown>;
}

/**
 * Where a mirror keeps its copy. Every write is guarded by `version`, so replaying a
 * page, or applying two pages out of order, never moves a record backwards.
 */
export interface ChangeMirrorStore {
  /** The last feed position fully applied; null on a store that has never synced. */
  getCursor(): Promise<number | null>;
  setCursor(seq: number): Promise<void>;
  /** Write the record only when `version` is above the held one. Returns whether it was written. */
  upsert(record: MirroredRecord): Promise<boolean>;
  /** Delete the record only when `version` is at or above the held one. Returns whether a row was deleted. */
  remove(type: ChangeResourceType, id: string, version: number): Promise<boolean>;
  get(type: ChangeResourceType, id: string): Promise<MirroredRecord | null>;
  list(type: ChangeResourceType): Promise<MirroredRecord[]>;
  /** Delete every record of a type held below `version` (the sweep after a snapshot); returns their ids. */
  pruneBefore(type: ChangeResourceType, version: number): Promise<string[]>;
  /**
   * Optional. Run `fn` against a store bound to one database transaction; commit when it
   * resolves, roll back when it throws. The mirror applies each page of changes, its
   * `onChange` calls and the new cursor in one, and each snapshot page in one.
   */
  transaction?<T>(fn: (tx: ChangeMirrorStore) => Promise<T>): Promise<T>;
}

/** What `onChange` receives: a feed entry, or a row seen during a snapshot. */
export interface MirrorChange {
  resource_type: ChangeResourceType;
  resource_id: string;
  op: 'create' | 'update' | 'delete' | 'snapshot';
  seq: number;
  /** The resource as it is now; null for a delete. */
  data: Record<string, unknown> | null;
}

export type MirrorStaleReason = 'resync_required' | 'max_staleness';

export interface MirrorStaleEvent {
  reason: MirrorStaleReason;
  /** Epoch ms of the last successful sync; null before the first. */
  last_sync_at: number | null;
}

/** The part of the backend client the mirror uses. `atlas.changes`-shaped, so a fake is small. */
export interface MirrorClient {
  changes: {
    list(params?: { after?: number; types?: ChangeResourceType[]; limit?: number }): Promise<{
      data: Change[];
      has_more: boolean;
      next_after: number;
      head_seq: number;
    }>;
    snapshot(
      type: ChangeResourceType,
      params?: { cursor?: string; limit?: number },
    ): Promise<{ data: Array<Record<string, unknown>>; next_cursor: string | null; snapshot_seq: number }>;
    ack(name: string, seq: number): Promise<unknown>;
  };
}

export interface MirrorOptions {
  client: MirrorClient;
  /** The resource types to keep. Only these are read from the feed and snapshotted. */
  resources: ChangeResourceType[];
  store: ChangeMirrorStore;
  /** Called once per applied change (never for a change the store already had). A throw fails the sync and the page is retried, so make it idempotent. */
  onChange?: (change: MirrorChange) => void | Promise<void>;
  /** Called when the mirror fell behind: the feed position was trimmed (it re-snapshots by itself) or no sync succeeded within `maxStalenessMs`. */
  onStale?: (event: MirrorStaleEvent) => void;
  /** Called with errors from background polling and from the best-effort server-side ack. */
  onError?: (error: unknown) => void;
  /** Report stale when the last successful sync is older than this. Unset = never. */
  maxStalenessMs?: number;
  /** Background poll interval for `start()`. Default 5000. */
  pollIntervalMs?: number;
  /** Also record the position on the server under this consumer name (`PUT /v1/changes/consumers/{name}/ack`) so lag is visible there. */
  consumer?: string;
  /** Entries per feed page, up to 500. Default 200. */
  pageSize?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export interface SyncResult {
  /** Changes written to the store (a snapshot row counts). */
  applied: number;
  /** True when this run (re)built the copy from a snapshot. */
  resnapshotted: boolean;
  /** The feed position the store is now at. */
  cursor: number | null;
}

export interface Mirror {
  /** Catch up to the head of the feed once. Calls overlap safely (one runs, the others wait for it). */
  sync(): Promise<SyncResult>;
  /** Poll in the background every `pollIntervalMs`. Idempotent. */
  start(): void;
  /** Stop polling and wait for a sync in flight. */
  stop(): Promise<void>;
  get(type: ChangeResourceType, id: string): Promise<MirroredRecord | null>;
  list(type: ChangeResourceType): Promise<MirroredRecord[]>;
  /** True when the last successful sync is older than `maxStalenessMs`, or none has succeeded yet. */
  isStale(): boolean;
  status(): { cursor: number | null; last_sync_at: number | null; stale: boolean };
  /** The DDL for a Postgres-backed store; throws for a store that has none. */
  migrationSql(): string;
}

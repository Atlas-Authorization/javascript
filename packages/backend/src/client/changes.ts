import { type RequestFn } from './request';

/** The resource types the change feed records. */
export type ChangeResourceType =
  | 'user'
  | 'organization'
  | 'membership'
  | 'invitation'
  | 'role_assignment'
  | 'api_key'
  | 'machine'
  | 'machine_grant';

/** One entry of the change feed. */
export interface Change {
  object: 'change';
  /** Position in the instance feed: strictly increasing in commit order, no gaps. */
  seq: number;
  resource_type: ChangeResourceType;
  resource_id: string;
  op: 'create' | 'update' | 'delete';
  /** Equal to `seq`. Drop an entry whose version is not above the one you hold. */
  version: number;
  /** Occurred (epoch ms). */
  occurred_at: number;
  /** The resource as it is now, in the webhook shape; null for a delete or a resource that is gone. */
  data: Record<string, unknown> | null;
}

export interface ListChangesParams {
  /** Return entries after this position. Default 0. */
  after?: number;
  /** Only these resource types. */
  types?: ChangeResourceType[];
  /** Entries per page, up to 500. Default 100. */
  limit?: number;
}

export interface ChangesPage {
  object: 'list';
  data: Change[];
  has_more: boolean;
  /** Pass as `after` to continue. */
  next_after: number;
  head_seq: number;
  /** The highest trimmed position. A cursor below it fails with 410 `RESYNC_REQUIRED`. */
  retention_floor_seq: number;
}

export interface ChangeSnapshotParams {
  cursor?: string;
  /** Resources per page, up to 200. Default 100. */
  limit?: number;
}

export interface ChangeSnapshotPage {
  object: 'list';
  resource_type: ChangeResourceType;
  data: Array<Record<string, unknown>>;
  has_more: boolean;
  next_cursor: string | null;
  /** The feed position the walk is pinned to: follow the feed after it. */
  snapshot_seq: number;
  head_seq: number;
  retention_floor_seq: number;
}

export interface ChangeConsumer {
  object: 'change_consumer';
  name: string;
  /** The last acknowledged position; null until the first ack. */
  seq: number | null;
  updated_at: number | null;
  head_seq: number;
  lag: number;
}

export function changesResource(request: RequestFn) {
  return {
    /** Entries after a position, oldest first. Throws a 410 `RESYNC_REQUIRED` error when the position was trimmed. */
    list(params: ListChangesParams = {}): Promise<ChangesPage> {
      const { types, ...rest } = params;
      return request({ method: 'GET', path: '/v1/changes', query: { ...rest, ...(types?.length ? { types: types.join(',') } : {}) } });
    },
    /** One page of the full list of a resource type, pinned to a feed position. */
    snapshot(resourceType: ChangeResourceType, params: ChangeSnapshotParams = {}): Promise<ChangeSnapshotPage> {
      return request({ method: 'GET', path: `/v1/changes/snapshot/${encodeURIComponent(resourceType)}`, query: { ...params } });
    },
    consumers: {
      /** Every named consumer of the instance across keys, behind-most first. */
      list(): Promise<{ object: 'list'; data: Array<ChangeConsumer & { key_id: string }>; has_more: boolean }> {
        return request({ method: 'GET', path: '/v1/changes/consumers' });
      },
      /** A named consumer's server-held position and lag. */
      get(name: string): Promise<ChangeConsumer> {
        return request({ method: 'GET', path: `/v1/changes/consumers/${encodeURIComponent(name)}` });
      },
    },
    /** Acknowledge a position for a named consumer. It only moves forward; a lower seq is a no-op. */
    ack(name: string, seq: number): Promise<ChangeConsumer> {
      return request({ method: 'PUT', path: `/v1/changes/consumers/${encodeURIComponent(name)}/ack`, body: { seq } });
    },
  };
}

import type { Engine } from './engine';
import type { Obj } from './openapi';

export const FEED_RESOURCES = ['user', 'organization', 'membership', 'invitation', 'role_assignment', 'api_key', 'machine', 'machine_grant'] as const;
export type FeedResource = (typeof FEED_RESOURCES)[number];

export interface ChangeEntry {
  seq: number;
  resource_type: FeedResource;
  resource_id: string;
  op: 'create' | 'update' | 'delete';
  occurred_at: number;
}

/**
 * The change feed: one ordered entry per committed mutation of a feed resource. Like the real feed,
 * an entry names the resource and carries its CURRENT state (null once it is gone), not a snapshot
 * as of the entry. `version` equals `seq`.
 */
export class ChangeFeed {
  readonly entries: ChangeEntry[] = [];
  /** Entries at or below this position were trimmed; `GET /v1/changes?after=<below>` answers 410. */
  retentionFloorSeq = 0;
  private seq = 0;

  constructor(private readonly engine: Engine) {}

  get head(): number {
    return this.seq;
  }

  append(resource: FeedResource, id: string, op: ChangeEntry['op']): ChangeEntry {
    const e: ChangeEntry = { seq: ++this.seq, resource_type: resource, resource_id: id, op, occurred_at: this.engine.clock.now() };
    this.entries.push(e);
    return e;
  }

  /** Drop entries up to and including `seq`, as retention would, and raise the floor. */
  trim(seq: number): void {
    const keep = this.entries.filter((e) => e.seq > seq);
    this.entries.length = 0;
    this.entries.push(...keep);
    this.retentionFloorSeq = Math.max(this.retentionFloorSeq, seq);
  }

  present(e: ChangeEntry): Obj {
    const data = e.op === 'delete' ? null : (this.engine.presenters.get(e.resource_type)?.one(e.resource_id) ?? null);
    return { object: 'change', seq: e.seq, resource_type: e.resource_type, resource_id: e.resource_id, op: e.op, version: e.seq, occurred_at: e.occurred_at, data };
  }

  clear(): void {
    this.entries.length = 0;
    this.seq = 0;
    this.retentionFloorSeq = 0;
  }
}

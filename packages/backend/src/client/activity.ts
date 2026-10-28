import { type RequestFn } from './request';
import type { CursorPage, CursorParams } from './types';

/** One entry of the product activity feed — the same envelope a webhook carries. */
export interface ActivityEvent {
  object: 'event';
  id: string;
  type: string;
  payload: {
    id: string;
    type: string;
    /** Emitted (epoch ms). */
    timestamp: number;
    instance_id: string;
    data: unknown;
  };
  /** Occurred (epoch ms). */
  created_at: number;
}

export interface ListActivityEventsParams extends CursorParams {
  /** Only this event type, e.g. `user.created`. */
  type?: string;
  /** Lower time bound: epoch ms or an ISO-8601 date. */
  from?: number | string;
  /** Upper time bound: epoch ms or an ISO-8601 date. */
  to?: number | string;
}

export interface ActivityEventsPage extends CursorPage<ActivityEvent> {
  object: 'list';
  /** Event types this instance has actually emitted. */
  available_types?: string[];
}

export interface UsageMetric {
  metric: string;
  label: string;
  description: string;
  /** False for metrics with no meaningful sum (active users). */
  additive: boolean;
  points: unknown[];
  peak: unknown;
  total: number | null;
  /** Change versus the previous window. */
  trend: number | null;
}

export interface UsageReport {
  object: 'usage';
  window: { from: string; to: string; days: number };
  previous_window?: { from: string; to: string };
  metrics: UsageMetric[];
  monthly_active_users?: { value: number | null; window_days: number; trend: number | null };
}

/** One config change: who changed what, when, with a before/after where recorded. */
export interface ConfigChangelogEntry {
  id: string;
  /** Occurred (epoch ms). */
  at: number;
  actor: { type: string; id: string | null };
  action: string;
  ip?: string | null;
  /** The object that changed, e.g. `{ type: 'oauth_client', id }`. */
  target?: { type: string; id: string | null } | null;
  /**
   * Always present: one entry per changed field. On an older entry that recorded
   * only field names, `values_recorded` is false and before/after are null.
   */
  changes: Array<{ section: string; before: unknown; after: unknown; values_recorded: boolean }>;
  /** True when the write changed nothing. */
  no_op: boolean;
  /** What the source recorded: before/after values, field names only, or nothing. */
  recorded: 'diff' | 'fields' | 'none';
  /** @deprecated read `changes[].section`. */
  fields?: string[];
}

export interface ListConfigChangelogParams extends CursorParams {
  /** Only this config action. */
  action?: string;
  /** Only changes at or after this ISO-8601 date. */
  since?: string;
  /** false = leave out writes that changed nothing. */
  include_no_op?: boolean;
}

export function eventsResource(request: RequestFn) {
  return {
    /** The activity feed, newest first, cursor-paginated (limit up to 100). */
    list(params: ListActivityEventsParams = {}): Promise<ActivityEventsPage> {
      return request({ method: 'GET', path: '/v1/events', query: { ...params } });
    },
  };
}

export function usageResource(request: RequestFn) {
  return {
    /** Daily sign-in / active-user series over the last `days`, plus monthly active users. */
    get(params: { days?: number } = {}): Promise<UsageReport> {
      return request({ method: 'GET', path: '/v1/usage', query: { ...params } });
    },
  };
}

export function configChangelogResource(request: RequestFn) {
  return {
    list(
      params: ListConfigChangelogParams = {},
    ): Promise<{
      object: 'config_changelog';
      data: ConfigChangelogEntry[];
      has_more: boolean;
      next_cursor: string | null;
    }> {
      return request({ method: 'GET', path: '/v1/config_changelog', query: { ...params } });
    },
  };
}

import { type RequestFn } from './request';

/** The four write budgets of an instance. */
export type WriteBudgetName = 'writes' | 'counter_writes' | 'events' | 'webhook_fanout';

export interface WriteBudget {
  object: 'write_budget';
  /** `observe` counts and reports only; `enforce` answers requests over budget with 429 + Retry-After. */
  mode: 'observe' | 'enforce';
  window_seconds: number;
  budgets: Record<WriteBudgetName, { limit: number; default: number; custom: boolean; used_on_this_node: number }>;
  exceeded_in_window: WriteBudgetName[];
  resets_in_seconds: number;
  last_exceeded_at: number | null;
  last_exceeded_budget: string | null;
  exceeded_total: number;
  updated_at: number | null;
}

export interface UpdateWriteBudgetBody {
  mode?: 'observe' | 'enforce';
  /** Integer 1 to 10,000,000, or null for the default. */
  writes_per_minute?: number | null;
  counter_writes_per_minute?: number | null;
  events_per_minute?: number | null;
  webhook_fanout_per_minute?: number | null;
}

export interface ApiDeprecation {
  object: 'api_deprecation';
  id: string;
  kind: 'route' | 'field';
  method: string;
  path: string;
  field: string | null;
  replacement: string | null;
  announced: string;
  sunset: string;
  days_until_sunset: number;
  /** Present on the per-instance list: whether this instance's integration still uses it. */
  in_use?: boolean;
  first_seen_at?: number | null;
}

export interface DeprecationList {
  object: 'list';
  data: ApiDeprecation[];
  has_more: false;
  in_use?: number;
  policy: { window_months: number; headers: string[] };
}

export interface DataKeyDrill {
  object: 'data_key_drill';
  id: string;
  ok: boolean;
  data_keys: number;
  vault_versions: number;
  vault_versions_not_examined: number;
  failed: number;
  failure_reason: string | null;
  used_previous: boolean;
  items: Array<{ kind: 'data_key' | 'vault_version'; id: string; ok: boolean; reason: string | null }>;
  created_at: number;
}

export function writeBudgetResource(request: RequestFn) {
  return {
    get(): Promise<WriteBudget> {
      return request({ method: 'GET', path: '/v1/instance/write_budget' });
    },
    update(body: UpdateWriteBudgetBody): Promise<WriteBudget> {
      return request({ method: 'PUT', path: '/v1/instance/write_budget', body });
    },
    /** Back to the defaults, observe mode. */
    reset(): Promise<WriteBudget> {
      return request({ method: 'DELETE', path: '/v1/instance/write_budget' });
    },
  };
}

export function deprecationsResource(request: RequestFn) {
  return {
    /** Every deprecated route and body field with its sunset date, each saying whether this instance still uses it. */
    list(): Promise<DeprecationList> {
      return request({ method: 'GET', path: '/v1/instance/deprecations' });
    },
    /** The public list (no instance usage). */
    listPublic(): Promise<DeprecationList> {
      return request({ method: 'GET', path: '/v1/deprecations' });
    },
  };
}

/** Rotation drills for the customer-managed data key: the re-wrap as a dry run. */
export function dataKeyDrillsResource(request: RequestFn) {
  return {
    run(body: { previous?: { provider: string; config: Record<string, unknown>; credentials: Record<string, unknown> } } = {}): Promise<DataKeyDrill> {
      return request({ method: 'POST', path: '/v1/instance/data_key_provider/rotation_drill', body });
    },
    list(): Promise<{ object: 'list'; data: DataKeyDrill[]; has_more: false }> {
      return request({ method: 'GET', path: '/v1/instance/data_key_provider/rotation_drills' });
    },
    get(id: string): Promise<DataKeyDrill> {
      return request({ method: 'GET', path: `/v1/instance/data_key_provider/rotation_drills/${encodeURIComponent(id)}` });
    },
  };
}

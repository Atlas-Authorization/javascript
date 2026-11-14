import { enc, type RequestFn } from './request';

/**
 * Effective access: explain a decision across every authorization engine, replay recorded decisions against a
 * candidate change (what-if), run a role-based permission check that lands in the decision log, and follow the
 * authorization event feed. Also the managed sync that writes memberships, org roles and groups as FGA tuples.
 */

export type ExplainLayer = 'rbac' | 'org_roles' | 'groups' | 'resource_roles' | 'abac' | 'access_policies' | 'fga';
export type AuthzEffect = 'allow' | 'deny' | 'step_up' | 'none';

export interface ExplainRequest {
  subject: { type?: 'user'; id: string };
  /** A permission key for roles, an action id for ABAC, a relation for FGA (override with `fga.relation`). */
  action: string;
  resource?: { type?: string; id?: string; resource_id?: string; external_id?: string; organization_id?: string };
  /** Extra group ids the subject belongs to in an outside directory (resource roles). */
  groups?: string[];
  context?: Record<string, unknown>;
  abac?: { principal_type?: string; resource_type?: string; principal_attributes?: Record<string, unknown>; resource_attributes?: Record<string, unknown> };
  fga?: { store_id?: string; relation?: string; user_type?: string };
  access?: { application_id?: string; ip?: string };
  /** Only these layers. Default all. */
  layers?: ExplainLayer[];
}

export interface ExplainContribution {
  layer: ExplainLayer;
  effect: AuthzEffect;
  /** Whether the rule applied. A listed rule with `matched: false` says why not in `reason`. */
  matched: boolean;
  rule: { type: string; id: string | null; name: string | null };
  reason: string;
  evidence?: string[];
  via?: Array<{ kind: 'org_role' | 'app_role' | 'delegated_role' | 'member_permission'; role_key?: string; organization_id?: string }>;
}

export interface ExplainLayerResult {
  status: 'evaluated' | 'skipped' | 'error';
  decision: 'allow' | 'deny' | 'step_up' | 'no_match';
  reason?: string;
  contributions: ExplainContribution[];
}

export interface AuthzExplanation {
  object: 'authz_explanation';
  decision: 'allow' | 'deny' | 'step_up';
  /** An explicit deny from any layer wins; otherwise one allow is needed; a step-up access policy turns an allow into `step_up`. */
  combination: 'deny_overrides';
  summary: string;
  subject: { type: 'user'; id: string };
  action: string;
  resource: Record<string, unknown>;
  layers: Partial<Record<ExplainLayer, ExplainLayerResult>>;
  /** The rules that decided it. Empty for a default deny. */
  deciding: ExplainContribution[];
  contributions: ExplainContribution[];
}

export interface AuthzRoleEdit {
  type: 'org_role' | 'app_role';
  key: string;
  organization_id?: string;
  add_permissions?: string[];
  remove_permissions?: string[];
}

export interface WhatIfTuple {
  user: string;
  relation: string;
  object: string;
}

export interface WhatIfRequest {
  name?: string;
  /** Epoch ms or ISO 8601. Default: `days` before `until`. */
  since?: number | string;
  until?: number | string;
  /** 1–30; default 7. */
  days?: number;
  /** 1–10000; default 2000. Newest decisions first. */
  limit?: number;
  /** Keep the run for later reading (default true). */
  save?: boolean;
  candidate: {
    abac?: { add?: Array<{ name: string; source: string }>; replace?: Array<{ name: string; source: string }>; remove?: string[]; fga_store_id?: string };
    rbac?: { roles: AuthzRoleEdit[] };
    fga?: { store_id: string; writes?: WhatIfTuple[]; deletes?: WhatIfTuple[] };
    access_policy?: { draft: Record<string, unknown>; days?: number };
  };
}

export interface WhatIfSourceStats {
  replayed: number;
  unchanged: number;
  allow_to_deny: number;
  deny_to_allow: number;
  /** Replays whose result under the current policies differs from what was recorded: the input was too thin to reproduce the decision. */
  baseline_mismatch: number;
}

export interface AuthzWhatIf {
  object: 'authz_what_if';
  id?: string;
  name: string | null;
  window: { since: number; until: number };
  evaluated: number;
  replayed: number;
  truncated: boolean;
  skipped: Record<string, number>;
  by_source: Record<string, WhatIfSourceStats>;
  totals: { unchanged: number; allow_to_deny: number; deny_to_allow: number };
  affected_principals: number;
  samples: Array<{ decision_id: string; source: string; principal: string | null; action: string | null; resource: string | null; before: 'allow' | 'deny'; after: 'allow' | 'deny'; at: number }>;
  access_policy?: Record<string, unknown>;
  created_at?: number;
}

export interface AuthzWhatIfRun {
  object: 'authz_what_if_run';
  id: string;
  name: string | null;
  candidate: Record<string, unknown>;
  window: { since: number; until: number };
  summary: Record<string, unknown>;
  /** Only when reading one run. */
  result?: AuthzWhatIf;
  created_by: string | null;
  created_at: number;
}

export interface RbacCheckResult {
  object: 'rbac_check';
  allowed: boolean;
  decision: 'allow' | 'deny';
  grants: Array<Record<string, unknown>>;
  rules: ExplainContribution[];
}

export type AuthzEventKind = 'tuples_written' | 'tuples_deleted' | 'model_written' | 'sync_run';

export interface AuthzEvent {
  object: 'authz_event';
  id: string;
  seq: number;
  kind: AuthzEventKind;
  store_id: string | null;
  store_revision: number | null;
  source: 'api' | 'sync';
  data: Record<string, unknown>;
  created_at: number;
}

export interface AuthzEventPage {
  object: 'list';
  data: AuthzEvent[];
  has_more: boolean;
  next_after: number;
}

export interface ListAuthzEventsParams {
  /** A `seq` from this feed, or `latest`. */
  after?: number | 'latest';
  limit?: number;
  store_id?: string;
  kinds?: AuthzEventKind[];
  /** Hold the request open up to this long (max 25000) when nothing is new. */
  wait_ms?: number;
}

export interface FgaSyncSettings {
  enabled?: boolean;
  store_id?: string | null;
  sync_memberships?: boolean;
  sync_org_roles?: boolean;
  sync_groups?: boolean;
  user_type?: string;
  org_type?: string;
  group_type?: string;
  member_relation?: string;
  role_relation_prefix?: string;
  group_key?: 'slug' | 'id';
}

export interface FgaSyncRun {
  object: 'fga_sync_run';
  id: string;
  kind: 'backfill' | 'incremental';
  status: 'queued' | 'running' | 'completed' | 'failed';
  store_id: string | null;
  repair: boolean;
  subjects: number;
  written: number;
  deleted: number;
  skipped: number;
  skipped_reasons: Record<string, number>;
  error: string | null;
  requested_by: string | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
}

export interface FgaSync extends Required<Omit<FgaSyncSettings, 'store_id'>> {
  object: 'fga.sync';
  store_id: string | null;
  last_synced_at: number | null;
  last_error: string | null;
  managed: { total: number; by_kind: Record<string, number> };
  backfill: FgaSyncRun | null;
  last_run: FgaSyncRun | null;
}

export function authzExplainResource(request: RequestFn) {
  return {
    /** Why does this subject have, or not have, this access? Every engine is asked and each contributing rule is returned. */
    explain(body: ExplainRequest): Promise<AuthzExplanation> {
      return request({ method: 'POST', path: '/v1/authz/explain', body });
    },
    /** A role-based permission check, written to the decision log (source `rbac`). */
    rbacCheck(body: { subject: { id: string }; permission: string; organization_id?: string }): Promise<RbacCheckResult> {
      return request({ method: 'POST', path: '/v1/authz/rbac/check', body });
    },
    /** Replay recorded decisions with a candidate change applied; nothing is changed. */
    whatIf: {
      run(body: WhatIfRequest): Promise<AuthzWhatIf> {
        return request({ method: 'POST', path: '/v1/authz/what_if', body });
      },
      list(params: { limit?: number; starting_after?: string } = {}): Promise<{ object: 'list'; data: AuthzWhatIfRun[]; has_more: boolean }> {
        return request({ method: 'GET', path: '/v1/authz/what_if', query: { ...params } });
      },
      get(id: string): Promise<AuthzWhatIfRun> {
        return request({ method: 'GET', path: `/v1/authz/what_if/${enc(id)}` });
      },
      delete(id: string): Promise<{ object: 'authz_what_if_run'; id: string; deleted: boolean }> {
        return request({ method: 'DELETE', path: `/v1/authz/what_if/${enc(id)}` });
      },
    },
    /** The authorization event feed: tuple writes and deletes, model versions, sync runs. At-least-once; dedupe on `id`. */
    events: {
      list(params: ListAuthzEventsParams = {}): Promise<AuthzEventPage> {
        const { kinds, ...rest } = params;
        return request({ method: 'GET', path: '/v1/authz/events', query: { ...rest, ...(kinds ? { kinds: kinds.join(',') } : {}) } });
      },
      /** Follow the feed forever, long-polling; stop by breaking out of the loop or aborting `signal`. */
      async *watch(params: Omit<ListAuthzEventsParams, 'after' | 'wait_ms'> & { after?: number | 'latest'; signal?: AbortSignal } = {}): AsyncGenerator<AuthzEvent> {
        const { signal, ...rest } = params;
        let after: number | 'latest' = rest.after ?? 'latest';
        while (!signal?.aborted) {
          const page: AuthzEventPage = await this.list({ ...rest, after, wait_ms: 25_000 });
          yield* page.data;
          after = page.next_after;
        }
      },
    },
  };
}

/** Managed sync of memberships, org roles and groups into FGA tuples (`atlas.fga.sync`). */
export function fgaSyncResource(request: RequestFn) {
  return {
    sync: {
      get(): Promise<FgaSync> {
        return request({ method: 'GET', path: '/v1/fga/sync' });
      },
      /** Fields you omit keep their value. Enabling needs `store_id` and queues a backfill. */
      update(body: FgaSyncSettings): Promise<FgaSync> {
        return request({ method: 'PUT', path: '/v1/fga/sync', body });
      },
      /** Queue a backfill (one at a time). `repair: true` rewrites every desired tuple. */
      backfill(body: { repair?: boolean } = {}, opts: { idempotencyKey?: string } = {}): Promise<FgaSyncRun> {
        return request({ method: 'POST', path: '/v1/fga/sync/backfill', body, idempotencyKey: opts.idempotencyKey });
      },
      runs: {
        list(params: { limit?: number; starting_after?: string } = {}): Promise<{ object: 'list'; data: FgaSyncRun[]; has_more: boolean }> {
          return request({ method: 'GET', path: '/v1/fga/sync/runs', query: { ...params } });
        },
        get(id: string): Promise<FgaSyncRun> {
          return request({ method: 'GET', path: `/v1/fga/sync/runs/${enc(id)}` });
        },
      },
      /** Remove the tuples the sync wrote (never one that existed before). Disable the sync first. */
      purge(): Promise<{ object: 'fga.sync_purge'; store_id: string; deleted: number; released: number }> {
        return request({ method: 'POST', path: '/v1/fga/sync/purge', body: { confirm: true } });
      },
    },
  };
}

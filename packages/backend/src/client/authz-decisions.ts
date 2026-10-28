import { enc, type RequestFn } from './request';

/**
 * The authorization decision log: every ABAC, AuthZEN, FGA-check and
 * access-policy decision can be recorded with its (redacted) input, result, the
 * policy revision in force and latency — sampled, shipped as `authz.decision`
 * events to your log streams, and queryable here.
 */

export type DecisionSource = 'abac' | 'authzen' | 'fga' | 'access_policy' | 'mcp_gateway';

export interface AuthzDecision {
  object: 'authz_decision';
  id: string;
  source: DecisionSource;
  decision: 'allow' | 'deny';
  /** `Type::id` (ABAC / AuthZEN), the FGA user, or the user id (access policies). */
  principal: string | null;
  /** The action, the FGA relation, or the access-policy stage. */
  action: string | null;
  resource: string | null;
  /** The request as kept by `input_mode`; null when capture keeps none. */
  input: Record<string, unknown> | null;
  /** Reasons (policy names), matched policies, error counts, FGA `allowed` / `cached`. */
  result: Record<string, unknown>;
  /** The signed-bundle revision in force (`rev_…`); access policies carry an `ap_…` digest. */
  policy_revision: string | null;
  /** The exact policy versions or FGA model that evaluated. */
  policy_version: Record<string, unknown> | null;
  latency_ms: number;
  /** The probability this decision was kept at; divide counts by it for the true volume. */
  sample_rate: number;
  actor_id: string | null;
  created_at: number;
}

export interface ListAuthzDecisionsParams {
  source?: DecisionSource;
  decision?: 'allow' | 'deny';
  principal?: string;
  action?: string;
  resource?: string;
  policy_revision?: string;
  /** ISO 8601 or epoch milliseconds. */
  since?: string | number;
  until?: string | number;
  /** 1–200; default 50. */
  limit?: number;
  starting_after?: string;
}

export interface AuthzDecisionPage {
  object: 'list';
  data: AuthzDecision[];
  has_more: boolean;
  /** Pass as `starting_after` for the next page. */
  next_cursor: string | null;
}

export interface AuthzDecisionStats {
  object: 'authz_decision_stats';
  since: number;
  until: number;
  recorded: number;
  /** Recorded decisions scaled back up by their sample rates. */
  estimated_total: number;
  by_source: Record<string, { allow: number; deny: number; estimated_allow: number; estimated_deny: number }>;
  latency_ms: { p50: number | null; p95: number | null; p99: number | null; max: number | null };
}

export interface AuthzDecisionSettings {
  object: 'authz_decision_settings';
  /** Record decisions. Off by default. */
  enabled: boolean;
  /** Probability (0–1) an allow is recorded. */
  sample_rate_allow: number;
  /** Probability (0–1) a deny is recorded. */
  sample_rate_deny: number;
  /** `ids` keeps identifiers only; `full` keeps the request minus `redact`; `none` keeps no input. */
  input_mode: 'ids' | 'full' | 'none';
  /** Dotted paths blanked in `full` mode; `*` matches one segment. */
  redact: string[];
  /** Also emit each recorded decision as an `authz.decision` event. */
  ship_to_events: boolean;
  /** Days to keep decisions; null keeps them. */
  retention_days: number | null;
}

export type UpdateAuthzDecisionSettingsBody = Partial<Omit<AuthzDecisionSettings, 'object'>>;

export function authzDecisionsResource(request: RequestFn) {
  return {
    /** Query the decision log, newest first. */
    list(params: ListAuthzDecisionsParams = {}): Promise<AuthzDecisionPage> {
      return request({ method: 'GET', path: '/v1/authz_decisions', query: { ...params } });
    },
    /** Follow `next_cursor` and yield every matching decision. */
    async *iterate(params: Omit<ListAuthzDecisionsParams, 'starting_after'> = {}): AsyncGenerator<AuthzDecision> {
      let after: string | undefined;
      for (;;) {
        const page = await this.list({ ...params, starting_after: after });
        yield* page.data;
        if (!page.has_more || !page.next_cursor) return;
        after = page.next_cursor;
      }
    },
    get(id: string): Promise<AuthzDecision> {
      return request({ method: 'GET', path: `/v1/authz_decisions/${enc(id)}` });
    },
    /** Counts per engine and outcome, sampling-corrected, with latency percentiles (the last 24 hours by default). */
    stats(params: { since?: string | number; until?: string | number } = {}): Promise<AuthzDecisionStats> {
      return request({ method: 'GET', path: '/v1/authz_decisions/stats', query: { ...params } });
    },
    /** A local PDP ships a batch of decisions (max 500) and checks in; also its heartbeat. */
    ingest(body: { pdp: { id: string; name?: string; version?: string; bundle_revision?: string }; decisions?: Array<{ decision: 'allow' | 'deny'; principal?: string; action?: string; resource?: string; input?: Record<string, unknown>; result?: Record<string, unknown>; latency_ms?: number }> }): Promise<{ object: 'authz_decision_ingest'; accepted: number; enabled: boolean; pdp: AuthzPdp }> {
      return request({ method: 'POST', path: '/v1/authz_decisions/ingest', body });
    },
    /** The fleet of local PDPs that have checked in. */
    pdps: {
      list(): Promise<{ object: 'list'; data: AuthzPdp[]; has_more: boolean }> {
        return request({ method: 'GET', path: '/v1/authz_pdps' });
      },
      remove(id: string): Promise<{ object: 'authz_pdp'; id: string; deleted: boolean }> {
        return request({ method: 'DELETE', path: `/v1/authz_pdps/${enc(id)}` });
      },
    },
    settings: {
      get(): Promise<AuthzDecisionSettings> {
        return request({ method: 'GET', path: '/v1/authz_decision_settings' });
      },
      /** Fields you omit keep their value. */
      update(body: UpdateAuthzDecisionSettingsBody): Promise<AuthzDecisionSettings> {
        return request({ method: 'PUT', path: '/v1/authz_decision_settings', body });
      },
    },
  };
}

export interface AuthzPdp {
  object: 'authz_pdp';
  id: string;
  name: string | null;
  version: string | null;
  bundle_revision: string | null;
  decisions_total: number;
  first_seen_at: number;
  last_seen_at: number;
}

import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/** The fixed point in the auth pipeline an action runs at. */
export type ActionTrigger =
  | 'post_login'
  | 'pre_user_registration'
  | 'post_user_registration'
  | 'pre_organization_create'
  | 'pre_member_add'
  | 'pre_invitation_create'
  | 'pre_authentication'
  | 'pre_token'
  | 'post_token_exchange'
  | 'custom_token_exchange'
  | 'pre_user_update'
  | 'mfa_verification_attempt'
  | 'password_verification_attempt'
  | 'account_link_decision'
  | 'billing_plan_selected'
  | 'post_change_password'
  | 'post_password_reset'
  | 'post_user_update'
  | 'post_email_verified'
  | 'post_mfa_enroll'
  | 'post_mfa_remove'
  | 'post_logout'
  | 'org_membership_changed'
  // EXT-04 custom challenge factor handlers (gates).
  | 'custom_challenge_create'
  | 'custom_challenge_verify'
  | 'workflow_step';

/**
 * Tenant code run in the hardened isolate at a trigger. Secret VALUES are
 * write-only and never returned — a read reports only `secret_names`. Timestamps
 * are epoch milliseconds.
 */
export interface Action {
  object: 'action';
  id: string;
  name: string;
  trigger: ActionTrigger;
  /** The JavaScript of a `node` Action; empty for an `http` one. */
  code: string;
  /** `node` runs `code` in the sandbox; `http` calls `http_target.url`. */
  runtime: 'node' | 'http' | (string & {});
  /** An `http` Action's endpoint; null for a `node` one. */
  http_target: ActionHttpTarget | null;
  enabled: boolean;
  secret_names: string[];
  created_at: number;
  updated_at: number;
}

/** Where an `http` Action sends the event. Timestamps are epoch milliseconds. */
export interface ActionHttpTarget {
  url: string;
  /** 500 to 5000; default 3000. */
  timeout_ms: number;
  /** What a failed call does: `closed` (default) refuses a gate, `open` carries on. */
  failure_mode: 'open' | 'closed';
}

export interface CreateActionBody {
  name: string;
  trigger: ActionTrigger;
  /** Required for a `node` Action; an `http` Action has none. */
  code?: string;
  /** `node` (default) or `http`: call your own HTTPS endpoint instead of running code. */
  runtime?: 'node' | 'http';
  /** Required when `runtime` is `http`. */
  http_target?: { url: string; timeout_ms?: number; failure_mode?: 'open' | 'closed' };
  /** `http` only: your own 16 to 512 character secret. Omit it and Atlas generates one, returned once. */
  signing_secret?: string;
  enabled?: boolean;
  /** Write-only, encrypted at rest, never read back. */
  secrets?: Record<string, string>;
}

/** The create/update response of an `http` Action carries a generated signing secret once. */
export type ActionWithSecret = Action & { signing_secret?: string };

export interface UpdateActionBody {
  name?: string;
  code?: string;
  /** `http` only; omitted settings keep their value. */
  http_target?: { url?: string; timeout_ms?: number; failure_mode?: 'open' | 'closed' };
  /** `http` only: replace the signing secret with your own. */
  signing_secret?: string;
  /** `http` only: generate a new signing secret, returned once on the response. */
  rotate_signing_secret?: boolean;
  enabled?: boolean;
  secrets?: Record<string, string>;
}

/** One call to an `http` Action's endpoint. */
export interface ActionHttpCall {
  object: 'action_http_call';
  id: string;
  action_id: string;
  trigger: ActionTrigger;
  user_id: string | null;
  /** A dry-run test call; kept out of the stats. */
  test: boolean;
  status: 'ok' | 'denied' | 'timeout' | 'error' | 'invalid_response';
  http_status: number | null;
  latency_ms: number | null;
  error: string | null;
  /** What the endpoint answered with, reduced to the names it set. */
  answer: Record<string, unknown> | null;
  created_at: number;
}

export interface ActionHttpCallList {
  object: 'list';
  data: ActionHttpCall[];
  has_more: boolean;
  next_cursor: string | null;
  /** Real (non-test) calls in the last 24 hours. */
  stats: {
    calls_24h: number;
    denied_24h: number;
    failed_24h: number;
    timeouts_24h: number;
    p95_latency_ms: number | null;
    last_failed_at: number | null;
  };
}

/** The sample event a dry-run runs against; every field has a stand-in default. */
export interface ActionTestEvent {
  user?: {
    id?: string;
    email?: string;
    emailVerified?: boolean;
    metadata?: Record<string, unknown>;
    /** The user's organization memberships, as `event.user.organizations`. */
    organizations?: Array<{ id: string; slug: string; name: string; role: string }>;
  };
  connection?: { strategy?: string; method?: string };
  /** `country` is the ISO code `event.request.country` should carry. */
  request?: { ip?: string; user_agent?: string; country?: string };
  /** The per-trigger `event.context` (token type, changed fields, MFA result, …). */
  context?: Record<string, unknown>;
  /** Registration triggers: the typed sign-up field values (`event.signUpFields`). */
  sign_up_fields?: Record<string, string>;
  /** Organization triggers: `event.organization`. */
  organization?: { id?: string | null; name?: string; slug?: string };
}

/** An outbound request the code queued with `api.http` (a dry run sends nothing). */
export interface ActionTestHttpRequest {
  method: 'GET' | 'POST';
  /** Query values are masked. */
  url: string;
  /** Header names only; values are never echoed. */
  header_names: string[];
  has_body: boolean;
  save_response_as: string | null;
}

/** Edits to the user an Action asked for. */
export interface ActionUserEdits {
  banned?: { value: boolean; reason: string | null };
  emailVerified?: boolean;
  firstName?: string | null;
  lastName?: string | null;
  imageUrl?: string | null;
}

/** What an action produced against a sample event — no real data is touched. */
export interface ActionTestResult {
  object: 'action_test_result';
  id: string;
  denied: boolean;
  deny_reason: string | null;
  access_token_claims: Record<string, unknown>;
  id_token_claims: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
  /** Set when the code called `api.access.lock()`; a real run locks the account for 15 minutes. */
  lock_reason?: string | null;
  challenge?: { prompt: string; hint: string | null; state: unknown } | null;
  challenge_accepted?: { amr: string[] } | null;
  /** `pre_token`: the claims the code asked to remove. */
  suppressed_access_claims?: string[];
  suppressed_id_claims?: string[];
  /** An `http` Action only: how the endpoint call went (the test really calls it, flagged `test`). */
  http_call?: { status: string; http_status: number | null; latency_ms: number | null; error: string | null };
  /** `api.user.setBanned/setEmailVerified/setName/setImage`, as a real run would apply them. */
  user_edits?: ActionUserEdits;
  /** Registration triggers: `api.signUp.prefill` and `modify`. */
  sign_up_prefill?: Record<string, string>;
  sign_up_modify?: Record<string, string>;
  logs: string[];
  /** What the code queued with `api.http`; sent only on a real run of a post_login or side-effect trigger. */
  http_requests?: ActionTestHttpRequest[];
  error: string | null;
}

/** The ordered binding list for a trigger, replaced atomically as a set. */
export interface ActionBindingList {
  object: 'action_binding_list';
  trigger: ActionTrigger;
  action_ids: string[];
}

export function actionsResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<Action>> {
      return request({ method: 'GET', path: '/v1/actions' });
    },
    create(body: CreateActionBody, idempotencyKey?: string): Promise<ActionWithSecret> {
      return request({ method: 'POST', path: '/v1/actions', body, idempotencyKey });
    },
    get(id: string): Promise<Action> {
      return request({ method: 'GET', path: `/v1/actions/${enc(id)}` });
    },
    update(id: string, body: UpdateActionBody): Promise<ActionWithSecret> {
      return request({ method: 'PATCH', path: `/v1/actions/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'action'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/actions/${enc(id)}` });
    },
    /** Dry-run against a sample event in the sandbox; nothing is persisted. */
    test(id: string, event: ActionTestEvent = {}): Promise<ActionTestResult> {
      return request({ method: 'POST', path: `/v1/actions/${enc(id)}/test`, body: { event } });
    },
    /** The call log of an `http` Action, newest first, with 24 hour stats. */
    calls(
      id: string,
      query: { limit?: number; status?: 'ok' | 'denied' | 'failed' | 'timeout' | 'error' | 'invalid_response'; test?: boolean; starting_after?: string } = {},
    ): Promise<ActionHttpCallList> {
      return request({ method: 'GET', path: `/v1/actions/${enc(id)}/calls`, query });
    },
    /** The actions bound to a trigger, in run order. */
    getBindings(trigger: ActionTrigger): Promise<ActionBindingList> {
      return request({ method: 'GET', path: `/v1/actions/bindings/${enc(trigger)}` });
    },
    /** Replace a trigger's ordered binding set. */
    setBindings(trigger: ActionTrigger, actionIds: string[]): Promise<ActionBindingList> {
      return request({
        method: 'PUT',
        path: `/v1/actions/bindings/${enc(trigger)}`,
        body: { action_ids: actionIds },
      });
    },
  };
}

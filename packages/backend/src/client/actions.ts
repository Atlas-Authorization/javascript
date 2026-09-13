import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/** The fixed point in the auth pipeline an action runs at. */
export type ActionTrigger = 'post_login' | 'pre_user_registration' | 'post_user_registration';

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
  code: string;
  runtime: string;
  enabled: boolean;
  secret_names: string[];
  created_at: number;
  updated_at: number;
}

export interface CreateActionBody {
  name: string;
  trigger: ActionTrigger;
  code: string;
  enabled?: boolean;
  /** Write-only, encrypted at rest, never read back. */
  secrets?: Record<string, string>;
}

export interface UpdateActionBody {
  name?: string;
  code?: string;
  enabled?: boolean;
  secrets?: Record<string, string>;
}

/** The sample event a dry-run runs against; every field has a stand-in default. */
export interface ActionTestEvent {
  user?: {
    id?: string;
    email?: string;
    emailVerified?: boolean;
    metadata?: Record<string, unknown>;
  };
  connection?: { strategy?: string };
  request?: { ip?: string; user_agent?: string };
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
  logs: string[];
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
    create(body: CreateActionBody, idempotencyKey?: string): Promise<Action> {
      return request({ method: 'POST', path: '/v1/actions', body, idempotencyKey });
    },
    get(id: string): Promise<Action> {
      return request({ method: 'GET', path: `/v1/actions/${enc(id)}` });
    },
    update(id: string, body: UpdateActionBody): Promise<Action> {
      return request({ method: 'PATCH', path: `/v1/actions/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'action'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/actions/${enc(id)}` });
    },
    /** Dry-run against a sample event in the sandbox; nothing is persisted. */
    test(id: string, event: ActionTestEvent = {}): Promise<ActionTestResult> {
      return request({ method: 'POST', path: `/v1/actions/${enc(id)}/test`, body: { event } });
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

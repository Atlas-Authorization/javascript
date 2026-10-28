import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/** What starts a workflow run. */
export type WorkflowTrigger =
  | { type: 'cron'; cron: string }
  | { type: 'user_created'; after_minutes?: number }
  | { type: 'inactive'; days: number }
  | { type: 'membership_age'; days: number; organization_id?: string }
  | { type: 'trial_end'; days_before?: number }
  | { type: 'webhook_event'; event_type: string; filter?: string }
  /** Started by `invoke` with an input object. */
  | { type: 'manual' };

/** Fields every step may carry. */
export interface WorkflowStepBase {
  /** Names the output: `steps.<id>.output` in later expressions. */
  id?: string;
  retry?: { max: number; backoff_seconds?: number };
  on_error?: 'fail' | 'continue';
}

/** Control flow and integration steps. Expressions: `{{ user.email }}`, `event.*`, `input.*`, `vars.*`, `steps.<id>.output`. */
export type WorkflowGraphStep = WorkflowStepBase &
  (
    | { type: 'if'; condition: string; then: WorkflowStep[]; else?: WorkflowStep[] }
    | { type: 'switch'; value: string; cases: Array<{ equals: string | number | boolean; steps: WorkflowStep[] }>; default?: WorkflowStep[] }
    | { type: 'for_each'; items: string; as?: string; steps: WorkflowStep[]; max_iterations?: number }
    | { type: 'wait'; seconds?: number; until?: string }
    | { type: 'set_variable'; name: string; value: unknown }
    | { type: 'http_request'; method?: 'GET' | 'POST'; url: string; headers?: Record<string, string>; secret_headers?: Record<string, string>; body?: unknown }
    | { type: 'call_connector'; connector: string; operation: string; input?: Record<string, unknown> }
    | { type: 'create_ticket'; connector: string; summary: string; description?: string; fields?: Record<string, unknown> }
    | { type: 'create_iga_request'; entitlement: string; justification?: string; duration_seconds?: number }
    | { type: 'start_campaign'; campaign_id: string }
    | { type: 'revoke_grant'; entitlement: string; reason?: string }
    | { type: 'approval'; approvers: { type: 'users' | 'manager' | 'group'; ids?: string[] }; message: string; timeout_seconds?: number; on_deny?: 'fail' | 'continue'; on_timeout?: 'fail' | 'continue' | 'approve' }
    | { type: 'kv'; op: 'get' | 'set' | 'delete' | 'incr'; key: string; value?: unknown }
  );

/** One step. A step that acts on an organization takes `organization_id`, or uses the membership's own for `membership_age`. */
export type WorkflowStep =
  | WorkflowGraphStep
  | { type: 'notify'; subject: string; body: string; to?: string }
  | { type: 'disable'; reason?: string }
  | { type: 'delete' }
  | { type: 'invite'; role: string; organization_id?: string }
  | { type: 'add_to_org'; role: string; organization_id?: string }
  | { type: 'remove_from_org'; organization_id?: string }
  | { type: 'add_to_team'; team_id: string; organization_id?: string }
  | { type: 'remove_from_team'; team_id: string; organization_id?: string }
  | { type: 'add_to_group'; group: string }
  | { type: 'remove_from_group'; group: string }
  | { type: 'call_action'; action_id: string };

export interface WorkflowTriggerInfo {
  object: 'workflow_trigger';
  name: string;
  description: string;
  subject: 'user' | 'none';
  payload: string[];
  emitter: string;
}
export interface WorkflowTemplate {
  object: 'workflow_template';
  key: string;
  name: string;
  description: string;
  parameters: Array<{ key: string; label: string; type: 'string' | 'number'; default?: string | number }>;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
}
export interface WorkflowApproval {
  object: 'workflow_approval';
  id: string;
  workflow_id: string;
  run_id: string;
  approver_user_ids: string[];
  message: string;
  status: 'pending' | 'approved' | 'denied' | 'timed_out';
  decided_by: string | null;
  comment: string | null;
  expires_at: number | null;
  decided_at: number | null;
  created_at: number;
}

export interface Workflow {
  object: 'workflow';
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  /** A cron workflow's next slot (Unix ms); null for other triggers. */
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface WorkflowRunStep {
  index: number;
  type: string;
  status: 'ok' | 'failed' | 'would_run' | 'skipped' | 'retrying' | 'waiting';
  /** Position in the step tree, e.g. `2.then.0`. */
  path?: string;
  attempt?: number;
  at?: number;
  detail?: string;
  output?: unknown;
}

export interface WorkflowRun {
  object: 'workflow_run';
  id: string;
  workflow_id: string;
  subject: string;
  user_id: string | null;
  dry_run: boolean;
  status: 'running' | 'waiting' | 'succeeded' | 'failed';
  /** While waiting on a timer or retry: when the run continues (Unix ms). */
  resume_at?: number | null;
  /** While waiting on people: `approval:<id>`. */
  waiting_on?: string | null;
  steps: WorkflowRunStep[];
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

export interface CreateWorkflowBody {
  name: string;
  description?: string | null;
  enabled?: boolean;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
}

export type UpdateWorkflowBody = Partial<CreateWorkflowBody>;

export function workflowsResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<Workflow>> {
      return request({ method: 'GET', path: '/v1/workflows' });
    },
    create(body: CreateWorkflowBody, idempotencyKey?: string): Promise<Workflow> {
      return request({ method: 'POST', path: '/v1/workflows', body, idempotencyKey });
    },
    get(id: string): Promise<Workflow> {
      return request({ method: 'GET', path: `/v1/workflows/${enc(id)}` });
    },
    update(id: string, body: UpdateWorkflowBody): Promise<Workflow> {
      return request({ method: 'PATCH', path: `/v1/workflows/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'workflow'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/workflows/${enc(id)}` });
    },
    /** Validate every step against live data for a user (none for cron) and report what would happen; changes nothing. */
    dryRun(id: string, target: { user_id?: string; organization_id?: string } = {}): Promise<WorkflowRun> {
      return request({ method: 'POST', path: `/v1/workflows/${enc(id)}/dry_run`, body: target });
    },
    /** Run now for one user (none for cron), outside the trigger. */
    run(id: string, target: { user_id?: string; organization_id?: string } = {}, idempotencyKey?: string): Promise<WorkflowRun> {
      return request({ method: 'POST', path: `/v1/workflows/${enc(id)}/run`, body: target, idempotencyKey });
    },
    /** Run history, newest first. */
    runs(id: string, query: { limit?: number; starting_after?: string } = {}): Promise<ListPage<WorkflowRun> & { next_cursor: string | null }> {
      return request({ method: 'GET', path: `/v1/workflows/${enc(id)}/runs`, query });
    },
    /** One run with its per-step log. */
    getRun(id: string, runId: string): Promise<WorkflowRun> {
      return request({ method: 'GET', path: `/v1/workflows/${enc(id)}/runs/${enc(runId)}` });
    },
    /** Start a `manual` workflow with an input object. */
    invoke(id: string, body: { user_id?: string; organization_id?: string; input?: Record<string, unknown> } = {}, idempotencyKey?: string): Promise<WorkflowRun> {
      return request({ method: 'POST', path: `/v1/workflows/${enc(id)}/invoke`, body, idempotencyKey });
    },
    /** Retry a failed run from the step that failed. */
    resume(id: string, runId: string): Promise<WorkflowRun> {
      return request({ method: 'POST', path: `/v1/workflows/${enc(id)}/runs/${enc(runId)}/resume`, body: {} });
    },
    /** The events a workflow can start on. */
    triggers(): Promise<ListPage<WorkflowTriggerInfo>> {
      return request({ method: 'GET', path: '/v1/workflow_triggers' });
    },
    templates(): Promise<ListPage<WorkflowTemplate>> {
      return request({ method: 'GET', path: '/v1/workflow_templates' });
    },
    createFromTemplate(body: { template: string; parameters?: Record<string, unknown>; name?: string; enabled?: boolean }, idempotencyKey?: string): Promise<Workflow> {
      return request({ method: 'POST', path: '/v1/workflows/from_template', body, idempotencyKey });
    },
    approvals(query: { status?: WorkflowApproval['status'] } = {}): Promise<ListPage<WorkflowApproval>> {
      return request({ method: 'GET', path: '/v1/workflow_approvals', query });
    },
    decideApproval(id: string, body: { decision: 'approve' | 'deny'; comment?: string; user_id?: string }, idempotencyKey?: string): Promise<WorkflowApproval> {
      return request({ method: 'POST', path: `/v1/workflow_approvals/${enc(id)}/decide`, body, idempotencyKey });
    },
    /** The workflow's key-value table. */
    kv: {
      list: (id: string): Promise<ListPage<{ object: 'workflow_kv'; key: string; value: unknown }>> => request({ method: 'GET', path: `/v1/workflows/${enc(id)}/kv` }),
      set: (id: string, key: string, value: unknown): Promise<{ object: 'workflow_kv'; key: string; value: unknown }> => request({ method: 'PUT', path: `/v1/workflows/${enc(id)}/kv/${enc(key)}`, body: { value } }),
      delete: (id: string, key: string): Promise<{ object: 'workflow_kv'; key: string; deleted: true }> => request({ method: 'DELETE', path: `/v1/workflows/${enc(id)}/kv/${enc(key)}` }),
    },
  };
}

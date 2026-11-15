import { enc, type RequestFn } from './request';

export type JourneyStepType = 'require_method' | 'require_mfa' | 'required_action' | 'profile_prompt' | 'policy_acceptance' | 'action' | 'set_claim' | 'redirect' | 'deny' | 'form' | 'subflow' | 'branch' | 'delay' | 'send_message';

/** Where a step runs: when an existing account signs in, or right after an account is created. */
export type JourneyStage = 'sign_in' | 'sign_up';

/** Copy by locale tag (`fr`, `pt-BR`): the request's language picks one (exact tag, then its language). */
export interface JourneyStepCopy {
  title?: string;
  intro?: string;
  message?: string;
}
export interface JourneyFieldCopy {
  label?: string;
  placeholder?: string;
  help?: string;
  link_text?: string;
  /** Option value to the label shown. */
  options?: Record<string, string>;
}

/**
 * A field of a form step; its value is saved to the user's public metadata under `key` (`phone` as E.164, `multi_select`
 * as a list, `checkbox` as a boolean, `file` as a reference: an upload id or an https URL, never the bytes).
 */
export interface JourneyFormField {
  key: string;
  label: string;
  type: 'text' | 'email' | 'number' | 'date' | 'select' | 'multi_select' | 'phone' | 'checkbox' | 'textarea' | 'file';
  required?: boolean;
  placeholder?: string;
  help?: string;
  /** select and multi_select: the allowed values (no commas). */
  options?: string[];
  /** checkbox: a link inside its label (https). */
  link?: { text: string; url: string };
  /** file: the types the picker offers and the size limit. */
  accept?: string[];
  max_bytes?: number;
  i18n?: Record<string, JourneyFieldCopy>;
}

export interface JourneyStep {
  id: string;
  type: JourneyStepType;
  /** Access-policy conditions: applications, userIds, groups, orgs, roles, networkZones, countries, riskLevels, deviceTrust, authMethods, timeWindow. */
  when?: Record<string, unknown>;
  methods?: string[];
  action?: 'update_password' | 'verify_email' | 'configure_mfa' | 'update_profile' | 'accept_policy' | 'identity_verification' | 'custom';
  url?: string;
  action_id?: string;
  claim?: string;
  value?: unknown;
  message?: string;
  /** Where the step runs. Default `['sign_in']`. A redirect step is sign_in only. */
  on?: JourneyStage[];
  /** Locale-keyed title, intro and refusal message. */
  i18n?: Record<string, JourneyStepCopy>;
  /** form */
  title?: string;
  intro?: string;
  fields?: JourneyFormField[];
  once?: boolean;
  /** subflow: the journey to run here. */
  flow_id?: string;
  /** branch: the conditions (same language as `when`) picking the `then` steps; when they do not match the `else` steps run. Branches nest at most three deep and every nested step counts toward the 50-step limit. */
  if?: Record<string, unknown>;
  then?: JourneyStep[];
  else?: JourneyStep[];
  /** delay: seconds every send_message after it on the same path waits (all waits on a path add up, at most 30 days). */
  delay_seconds?: number;
  /** send_message: the email, sent once per user to their verified primary address through your own email provider. `{{first_name}}`, `{{last_name}}`, `{{email}}` and `{{user_id}}` are filled in. */
  subject?: string;
  body?: string;
  channel?: 'email';
  /** send_message: also text the user (at most 320 characters, same placeholders) to a verified phone number through your own SMS provider, once per user per step. */
  sms_body?: string;
}

export interface JourneyDefinition {
  steps: JourneyStep[];
}

export interface SignInJourney {
  object: 'sign_in_journey';
  id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  applications: string[];
  enabled: boolean;
  /** Hours a started run may sit untouched before `journey.abandoned` is sent; null = 72. */
  abandon_after_hours: number | null;
  active_version: number | null;
  latest_version: number;
  definition?: JourneyDefinition | null;
  created_at: number;
  updated_at: number;
}

export interface JourneyBody {
  name?: string;
  description?: string | null;
  is_default?: boolean;
  applications?: string[];
  enabled?: boolean;
  definition?: JourneyDefinition;
  activate?: boolean;
  abandon_after_hours?: number | null;
}

export interface JourneySimulation {
  object: 'sign_in_journey_simulation';
  journey_id: string;
  version: number;
  outcome: 'allowed' | 'held' | 'refused';
  effects: Array<Record<string, unknown>>;
  trace: Array<{ step: string; type: JourneyStepType; matched: boolean; outcome: 'skipped' | 'passed' | 'effect' | 'stopped'; branch?: 'then' | 'else' }>;
}

/** A user's run through a journey: started when a step was first held for them, completed when every held step was finished, abandoned when untouched past the journey's window. */
export interface JourneyRun {
  object: 'journey_run';
  id: string;
  journey_id: string;
  user_id: string;
  stage: JourneyStage;
  status: 'in_progress' | 'completed' | 'abandoned';
  open_steps: string[];
  completed_steps: string[];
  /** What the user saved so far, by step (user reads only; absent from a journey's run list). */
  draft?: Record<string, Record<string, unknown>>;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
  abandoned_at: number | null;
}

export interface JourneyExperimentVariant {
  /** 1-32 lowercase letters, digits, _ or -. */
  key: string;
  /** A saved version of the journey. */
  version: number;
  /** Percent of users; all weights add up to 100. */
  weight: number;
}

/** An A/B experiment on a journey. Draft, then running (users are split between the variants), then stopped. */
export interface JourneyExperiment {
  object: 'journey_experiment';
  id: string;
  journey_id: string;
  name: string;
  hypothesis: string | null;
  status: 'draft' | 'running' | 'stopped';
  variants: JourneyExperimentVariant[];
  promoted_variant: string | null;
  started_at: number | null;
  stopped_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface JourneyExperimentReadout {
  object: 'journey_experiment_readout';
  experiment_id: string;
  journey_id: string;
  status: 'draft' | 'running' | 'stopped';
  metric: 'completion';
  /** The first variant, which the others are compared with. */
  control: string | null;
  significance_level: number;
  started_at: number | null;
  stopped_at: number | null;
  variants: Array<{
    key: string;
    version: number | null;
    weight: number | null;
    /** Users who reached the journey while the experiment ran. */
    assigned: number;
    /** Of those, how many the journey held (a run started). Completion is measured among them. */
    started: number;
    completed: number;
    abandoned: number;
    in_progress: number;
    completion_rate: number | null;
    abandon_rate: number | null;
    avg_duration_ms: number | null;
    /** 95% interval of the completion rate. */
    completion_interval: [number, number] | null;
    /** Relative change against the control (0.2 = 20% higher). */
    lift: number | null;
    /** Two-sided p-value of a two-proportion z-test against the control. */
    p_value: number | null;
    significant: boolean;
  }>;
}

/** A message a journey's `send_message` step scheduled for a user. The text is not returned. */
export interface JourneyMessage {
  object: 'journey_message';
  id: string;
  journey_id: string;
  step: string;
  user_id: string;
  channel: 'email' | 'sms';
  subject: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'canceled';
  send_at: number;
  attempts: number;
  last_error: string | null;
  sent_at: number | null;
  created_at: number;
}

/** Sign-in and sign-up journeys (`/v1/flows`): versioned steps run before a session is issued. */
export function journeysResource(request: RequestFn) {
  return {
    list(): Promise<{ object: 'list'; data: SignInJourney[]; has_more: boolean }> {
      return request({ method: 'GET', path: '/v1/flows' });
    },
    get(id: string): Promise<SignInJourney> {
      return request({ method: 'GET', path: `/v1/flows/${enc(id)}` });
    },
    create(body: JourneyBody & { name: string; definition: JourneyDefinition }, idempotencyKey?: string): Promise<SignInJourney> {
      return request({ method: 'POST', path: '/v1/flows', body, idempotencyKey });
    },
    /** A `definition` becomes the next version (active unless `activate: false`). */
    update(id: string, body: JourneyBody, idempotencyKey?: string): Promise<SignInJourney> {
      return request({ method: 'PATCH', path: `/v1/flows/${enc(id)}`, body, idempotencyKey });
    },
    delete(id: string): Promise<{ object: 'sign_in_journey'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/flows/${enc(id)}` });
    },
    versions(id: string): Promise<{ object: 'list'; data: Array<{ version: number; definition: JourneyDefinition; created_by: string | null; created_at: number }> }> {
      return request({ method: 'GET', path: `/v1/flows/${enc(id)}/versions` });
    },
    activate(id: string, version: number): Promise<SignInJourney> {
      return request({ method: 'POST', path: `/v1/flows/${enc(id)}/activate`, body: { version } });
    },
    simulate(id: string, body: { user_id: string; method?: string; mfa_verified?: boolean; ip?: string; application_id?: string; version?: number; stage?: JourneyStage }): Promise<JourneySimulation> {
      return request({ method: 'POST', path: `/v1/flows/${enc(id)}/simulate`, body });
    },
     /** Users' runs through one journey, newest first. */
    runs(id: string, params: { status?: JourneyRun['status']; limit?: number } = {}): Promise<{ object: 'list'; data: JourneyRun[]; has_more: boolean }> {
      return request({ method: 'GET', path: `/v1/flows/${enc(id)}/runs`, query: params });
    },
    /** A/B experiments on a journey: `create` a draft, `start` it, read the `readout`, `stop` it (optionally promoting a variant). */
    experiments: {
      list(id: string): Promise<{ object: 'list'; data: JourneyExperiment[]; has_more: boolean }> {
        return request({ method: 'GET', path: `/v1/flows/${enc(id)}/experiments` });
      },
      create(id: string, body: { name: string; hypothesis?: string | null; variants: JourneyExperimentVariant[] }, idempotencyKey?: string): Promise<JourneyExperiment> {
        return request({ method: 'POST', path: `/v1/flows/${enc(id)}/experiments`, body, idempotencyKey });
      },
      get(id: string, experimentId: string): Promise<JourneyExperiment> {
        return request({ method: 'GET', path: `/v1/flows/${enc(id)}/experiments/${enc(experimentId)}` });
      },
      /** A draft only; a started experiment keeps its variants so nobody is moved. */
      update(id: string, experimentId: string, body: { name?: string; hypothesis?: string | null; variants?: JourneyExperimentVariant[] }, idempotencyKey?: string): Promise<JourneyExperiment> {
        return request({ method: 'PATCH', path: `/v1/flows/${enc(id)}/experiments/${enc(experimentId)}`, body, idempotencyKey });
      },
      delete(id: string, experimentId: string): Promise<{ object: 'journey_experiment'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/flows/${enc(id)}/experiments/${enc(experimentId)}` });
      },
      /** One experiment runs per journey at a time. */
      start(id: string, experimentId: string, idempotencyKey?: string): Promise<JourneyExperiment> {
        return request({ method: 'POST', path: `/v1/flows/${enc(id)}/experiments/${enc(experimentId)}/start`, idempotencyKey });
      },
      /** `promoteVariant` makes that variant's version the journey's active version. */
      stop(id: string, experimentId: string, opts: { promoteVariant?: string | null } = {}, idempotencyKey?: string): Promise<JourneyExperiment> {
        return request({ method: 'POST', path: `/v1/flows/${enc(id)}/experiments/${enc(experimentId)}/stop`, body: { promote_variant: opts.promoteVariant ?? null }, idempotencyKey });
      },
      readout(id: string, experimentId: string): Promise<JourneyExperimentReadout> {
        return request({ method: 'GET', path: `/v1/flows/${enc(id)}/experiments/${enc(experimentId)}/readout` });
      },
    },
    /** The messages a journey's `send_message` steps scheduled. */
    messages: {
      list(id: string, params: { status?: JourneyMessage['status']; user_id?: string; limit?: number } = {}): Promise<{ object: 'list'; data: JourneyMessage[]; has_more: boolean }> {
        return request({ method: 'GET', path: `/v1/flows/${enc(id)}/messages`, query: params });
      },
      /** Cancel one that has not gone out (pending or failed). */
      cancel(id: string, messageId: string): Promise<JourneyMessage> {
        return request({ method: 'POST', path: `/v1/flows/${enc(id)}/messages/${enc(messageId)}/cancel` });
      },
    },
    /** One user's journey runs with what they saved so far. */
    userRuns(userId: string): Promise<{ object: 'list'; data: JourneyRun[]; has_more: boolean }> {
      return request({ method: 'GET', path: `/v1/users/${enc(userId)}/journeys` });
    },
    /** Start a user's onboarding over: drops their runs and the open steps those journeys asked of them. `journeyId` limits it to one. */
    resetUser(userId: string, journeyId?: string): Promise<{ object: 'journey_reset'; user_id: string; journey_id: string | null; runs_removed: number; steps_cleared: number }> {
      return request({ method: 'DELETE', path: `/v1/users/${enc(userId)}/journeys`, query: journeyId ? { journey_id: journeyId } : undefined });
    },
  };
}

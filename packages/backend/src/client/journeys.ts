import { enc, type RequestFn } from './request';

export type JourneyStepType = 'require_method' | 'require_mfa' | 'required_action' | 'profile_prompt' | 'policy_acceptance' | 'action' | 'set_claim' | 'redirect' | 'deny' | 'form' | 'subflow';

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
  trace: Array<{ step: string; type: JourneyStepType; matched: boolean; outcome: 'skipped' | 'passed' | 'effect' | 'stopped' }>;
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

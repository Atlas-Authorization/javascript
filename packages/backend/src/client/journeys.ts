import { enc, type RequestFn } from './request';

export type JourneyStepType = 'require_method' | 'require_mfa' | 'required_action' | 'profile_prompt' | 'policy_acceptance' | 'action' | 'set_claim' | 'redirect' | 'deny' | 'form' | 'subflow';

/** A field of a form step; its value is saved to the user's public metadata under `key`. */
export interface JourneyFormField {
  key: string;
  label: string;
  type: 'text' | 'email' | 'number' | 'date' | 'select' | 'checkbox' | 'textarea';
  required?: boolean;
  placeholder?: string;
  options?: string[];
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
}

export interface JourneySimulation {
  object: 'sign_in_journey_simulation';
  journey_id: string;
  version: number;
  outcome: 'allowed' | 'held' | 'refused';
  effects: Array<Record<string, unknown>>;
  trace: Array<{ step: string; type: JourneyStepType; matched: boolean; outcome: 'skipped' | 'passed' | 'effect' | 'stopped' }>;
}

/** Sign-in journeys (`/v1/flows`): versioned steps run before a session is issued. */
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
    simulate(id: string, body: { user_id: string; method?: string; mfa_verified?: boolean; ip?: string; application_id?: string; version?: number }): Promise<JourneySimulation> {
      return request({ method: 'POST', path: `/v1/flows/${enc(id)}/simulate`, body });
    },
  };
}

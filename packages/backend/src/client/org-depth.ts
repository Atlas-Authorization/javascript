import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export interface OrgRoleSet {
  object: 'org_role_set';
  id: string;
  key: string;
  name: string;
  description: string | null;
  role_keys: string[];
  default_role_key: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateOrgRoleSetBody {
  key: string;
  name: string;
  description?: string | null;
  /** Instance-wide roles an organization using the set may assign. `org:admin` is always allowed. */
  role_keys?: string[];
  default_role_key?: string | null;
}

export type UpdateOrgRoleSetBody = Partial<Omit<CreateOrgRoleSetBody, 'key'>>;

export interface OrgTemplateRole {
  key: string;
  name: string;
  description?: string | null;
  permissions?: string[];
}

export interface OrgTemplate {
  object: 'org_template';
  id: string;
  key: string;
  name: string;
  description: string | null;
  roles: OrgTemplateRole[];
  policy: Record<string, unknown>;
  role_set: string | null;
  default_role: string | null;
  max_allowed_memberships: number | null;
  seat_warn_percent: number | null;
  public_metadata: Record<string, unknown>;
  private_metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export interface CreateOrgTemplateBody {
  key: string;
  name: string;
  description?: string | null;
  roles?: OrgTemplateRole[];
  /** As `PATCH /v1/organizations/{id}/policy` takes it. */
  policy?: Record<string, unknown>;
  role_set?: string | null;
  default_role?: string | null;
  max_allowed_memberships?: number | null;
  seat_warn_percent?: number | null;
  public_metadata?: Record<string, unknown>;
  private_metadata?: Record<string, unknown>;
}

export type UpdateOrgTemplateBody = Partial<Omit<CreateOrgTemplateBody, 'key'>>;

export interface OrgFromTemplateBody {
  name: string;
  slug?: string | null;
  external_id?: string | null;
  /** A user id to seat as the creator; omit for a backend-created organization with nobody seated. */
  created_by?: string | null;
  max_allowed_memberships?: number | null;
  /** Merged over the template's. */
  public_metadata?: Record<string, unknown>;
  private_metadata?: Record<string, unknown>;
}

export interface AbuseSignal {
  object: 'abuse_signal';
  id: string;
  kind: 'sign_up' | 'recovery';
  outcome: 'allowed' | 'scored' | 'blocked';
  ip: string | null;
  asn: number | null;
  /** The sign-up attempt this decision led to. */
  attempt_id: string | null;
  /** 0 to 100, for a sign-up. */
  risk_score: number | null;
  reasons: string[];
  created_at: number;
}

export interface AbuseSignalSummary {
  object: 'abuse_signal_summary';
  days: number;
  counts: Array<{ kind: string; outcome: string; n: number }>;
}

export function orgRoleSetsResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<OrgRoleSet>> {
      return request({ method: 'GET', path: '/v1/org_role_sets' });
    },
    create(body: CreateOrgRoleSetBody, idempotencyKey?: string): Promise<OrgRoleSet> {
      return request({ method: 'POST', path: '/v1/org_role_sets', body, idempotencyKey });
    },
    /** By id or key. */
    get(idOrKey: string): Promise<OrgRoleSet> {
      return request({ method: 'GET', path: `/v1/org_role_sets/${enc(idOrKey)}` });
    },
    update(idOrKey: string, body: UpdateOrgRoleSetBody): Promise<OrgRoleSet> {
      return request({ method: 'PATCH', path: `/v1/org_role_sets/${enc(idOrKey)}`, body });
    },
    /** Refused with 409 while an organization still uses the set. */
    delete(idOrKey: string): Promise<{ object: 'org_role_set'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/org_role_sets/${enc(idOrKey)}` });
    },
  };
}

export function orgTemplatesResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<OrgTemplate>> {
      return request({ method: 'GET', path: '/v1/org_templates' });
    },
    create(body: CreateOrgTemplateBody, idempotencyKey?: string): Promise<OrgTemplate> {
      return request({ method: 'POST', path: '/v1/org_templates', body, idempotencyKey });
    },
    get(idOrKey: string): Promise<OrgTemplate> {
      return request({ method: 'GET', path: `/v1/org_templates/${enc(idOrKey)}` });
    },
    update(idOrKey: string, body: UpdateOrgTemplateBody): Promise<OrgTemplate> {
      return request({ method: 'PATCH', path: `/v1/org_templates/${enc(idOrKey)}`, body });
    },
    delete(idOrKey: string): Promise<{ object: 'org_template'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/org_templates/${enc(idOrKey)}` });
    },
    /** Create an organization from a template: its roles, policy, role policy, seats and metadata come with it. */
    createOrganization(idOrKey: string, body: OrgFromTemplateBody, idempotencyKey?: string): Promise<{ object: 'organization'; id: string; name: string; slug: string }> {
      return request({ method: 'POST', path: `/v1/org_templates/${enc(idOrKey)}/organizations`, body, idempotencyKey });
    },
  };
}

export function abuseSignalsResource(request: RequestFn) {
  return {
    list(params: { kind?: 'sign_up' | 'recovery'; outcome?: 'allowed' | 'scored' | 'blocked'; attempt_id?: string; limit?: number; starting_after?: string } = {}): Promise<ListPage<AbuseSignal> & { next_cursor?: string | null }> {
      return request({ method: 'GET', path: '/v1/abuse_signals', query: { ...params } });
    },
    summary(params: { days?: number } = {}): Promise<AbuseSignalSummary> {
      return request({ method: 'GET', path: '/v1/abuse_signals/summary', query: { ...params } });
    },
  };
}

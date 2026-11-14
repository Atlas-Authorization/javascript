import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export type MfaCampaignFactor = 'totp' | 'sms' | 'passkey' | 'push';
export type MfaCampaignTarget = 'all' | 'group' | 'org' | 'role';

export interface MfaCampaignMetrics {
  /** Users the campaign reaches (group targets count direct members). */
  targeted: number;
  /** Of those, users holding a second factor now. */
  enrolled: number;
  nagged: number;
  exempt: number;
}

export interface MfaCampaign {
  object: 'mfa_campaign';
  id: string;
  name: string;
  target_type: MfaCampaignTarget;
  /** The group slug, organization id or organization role key; null for `all`. */
  target_value: string | null;
  /** The factor classes asked for. Empty: any second factor. */
  required_factors: MfaCampaignFactor[];
  starts_at: number;
  /** The deadline. Before it users are only nagged. */
  grace_until: number | null;
  nag_interval_days: number;
  /** After the deadline (or at once with no deadline) sign-in requires a second factor. */
  enforce: boolean;
  status: 'active' | 'ended';
  ended_at: number | null;
  created_at: number;
  updated_at: number;
  metrics?: MfaCampaignMetrics;
}

export interface MfaCampaignInput {
  name: string;
  target_type?: MfaCampaignTarget;
  /** Required for group (slug), org (id) and role (key). */
  target_value?: string;
  required_factors?: MfaCampaignFactor[];
  starts_at?: number;
  grace_until?: number | null;
  nag_interval_days?: number;
  enforce?: boolean;
}

export interface MfaCampaignUser {
  object: 'mfa_campaign_user';
  campaign_id: string;
  user_id: string;
  /** This user's own required factors; null: the campaign's. */
  required_factors: MfaCampaignFactor[] | null;
  exempt_until: number | null;
  nag_count: number;
  last_nagged_at: number | null;
  dismissed_at: number | null;
  enrolled_at: number | null;
  targeted?: boolean;
  effective?: { phase: 'exempt' | 'satisfied' | 'nag' | 'enforcing'; required_factors: string[]; satisfied: boolean; days_left: number | null };
}

/** MFA rollout campaigns (`/v1/mfa_campaigns`). */
export function mfaCampaignsResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<MfaCampaign>> {
      return request({ method: 'GET', path: '/v1/mfa_campaigns' });
    },
    create(body: MfaCampaignInput, options: { idempotencyKey?: string } = {}): Promise<MfaCampaign> {
      return request({ method: 'POST', path: '/v1/mfa_campaigns', body, idempotencyKey: options.idempotencyKey });
    },
    get(id: string): Promise<MfaCampaign> {
      return request({ method: 'GET', path: `/v1/mfa_campaigns/${enc(id)}` });
    },
    /** The target is fixed; end the campaign and start another to change who it reaches. */
    update(id: string, body: Partial<Pick<MfaCampaignInput, 'name' | 'required_factors' | 'grace_until' | 'nag_interval_days' | 'enforce'>>): Promise<MfaCampaign> {
      return request({ method: 'PATCH', path: `/v1/mfa_campaigns/${enc(id)}`, body });
    },
    /** Ends the campaign now; its numbers stay readable. */
    end(id: string): Promise<MfaCampaign> {
      return request({ method: 'DELETE', path: `/v1/mfa_campaigns/${enc(id)}` });
    },
    users(id: string, query: { limit?: number } = {}): Promise<ListPage<MfaCampaignUser>> {
      return request({ method: 'GET', path: `/v1/mfa_campaigns/${enc(id)}/users`, query });
    },
    /** One user's standing: their own required factors and exemption, nag history and what they still owe. */
    user(id: string, userId: string): Promise<MfaCampaignUser> {
      return request({ method: 'GET', path: `/v1/mfa_campaigns/${enc(id)}/users/${enc(userId)}` });
    },
    /** Set one user's own required factors and/or an exemption until a date. `null` clears either. */
    setUser(id: string, userId: string, body: { required_factors?: MfaCampaignFactor[] | null; exempt_until?: number | null }): Promise<MfaCampaignUser> {
      return request({ method: 'PUT', path: `/v1/mfa_campaigns/${enc(id)}/users/${enc(userId)}`, body });
    },
  };
}

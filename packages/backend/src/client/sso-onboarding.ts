import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/**
 * A self-service SSO onboarding profile — the WorkOS Admin Portal / Auth0
 * self-service-profiles model. It fixes which protocols an end-customer may
 * configure and either binds an org or promises to name one at ticket issue.
 */
export interface SsoOnboardingProfile {
  object: 'sso_onboarding_profile';
  id: string;
  name: string;
  allowed_connection_types: string[];
  /** Set = every ticket targets this org; null = the ticket names its org. */
  organization_id: string | null;
  company_name: string | null;
  allow_scim: boolean;
  created_at: number;
  updated_at: number;
}

/**
 * A one-time, expiring ticket for a specific end-customer org. Its opaque token
 * (and the hosted setup URL carrying it) are revealed exactly once — see
 * {@link IssuedSsoOnboardingTicket}.
 */
export interface SsoOnboardingTicket {
  object: 'sso_onboarding_ticket';
  id: string;
  profile_id: string;
  organization_id: string;
  sso_connection_id: string | null;
  status: string;
  expires_at: number;
  created_at: number;
  completed_at: number | null;
}

/** The create response: the ticket plus the once-only token and hosted URL. */
export interface IssuedSsoOnboardingTicket extends SsoOnboardingTicket {
  /** Revealed exactly once; only its hash is stored. */
  token: string;
  /** The hosted URL the end-customer's IT admin opens (no dashboard account). */
  url: string;
  expires_in: number;
}

export interface CreateSsoOnboardingProfileBody {
  name: string;
  /** Defaults to both `oidc` and `saml`. */
  allowed_connection_types?: Array<'oidc' | 'saml'>;
  /** Bind the profile to an org in this instance; omit for a per-ticket org. */
  organization_id?: string | null;
  company_name?: string | null;
  allow_scim?: boolean;
}

export interface CreateSsoOnboardingTicketBody {
  /** Required for an unbound profile; must match (or be omitted) for a bound one. */
  organization_id?: string | null;
  /** Clamped to a 5-minute…30-day band; defaults to 3 days. */
  expires_in_seconds?: number;
}

export function ssoOnboardingResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<SsoOnboardingProfile>> {
      return request({ method: 'GET', path: '/v1/sso_onboarding_profiles' });
    },
    get(id: string): Promise<SsoOnboardingProfile> {
      return request({ method: 'GET', path: `/v1/sso_onboarding_profiles/${enc(id)}` });
    },
    create(
      body: CreateSsoOnboardingProfileBody,
      idempotencyKey?: string,
    ): Promise<SsoOnboardingProfile> {
      return request({
        method: 'POST',
        path: '/v1/sso_onboarding_profiles',
        body,
        idempotencyKey,
      });
    },
    delete(id: string): Promise<{ object: 'sso_onboarding_profile'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/sso_onboarding_profiles/${enc(id)}` });
    },
    /** Issue a one-time ticket for a profile. The token is returned once, here. */
    createTicket(
      profileId: string,
      body: CreateSsoOnboardingTicketBody = {},
      idempotencyKey?: string,
    ): Promise<IssuedSsoOnboardingTicket> {
      return request({
        method: 'POST',
        path: `/v1/sso_onboarding_profiles/${enc(profileId)}/tickets`,
        body,
        idempotencyKey,
      });
    },
    /** Kill a still-live ticket. 404 once it is used, expired, or already revoked. */
    revokeTicket(
      ticketId: string,
    ): Promise<{ object: 'sso_onboarding_ticket'; id: string; revoked: true }> {
      return request({
        method: 'POST',
        path: `/v1/sso_onboarding_tickets/${enc(ticketId)}/revoke`,
      });
    },
  };
}

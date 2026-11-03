import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/**
 * A self-service SSO onboarding profile — the WorkOS Admin Portal / Auth0
 * self-service-profiles model. It fixes which protocols an end-customer may
 * configure and either binds an org or promises to name one at ticket issue.
 */
/** An Admin Portal task a ticket may perform for its organization. */
export type SsoPortalIntent =
  | 'sso'
  | 'directory_sync'
  | 'domain_verification'
  | 'log_stream'
  | 'audit_log'
  | 'certificate_renewal'
  | 'api_keys'
  | 'webhooks';

export interface SsoOnboardingProfile {
  object: 'sso_onboarding_profile';
  id: string;
  name: string;
  allowed_connection_types: string[];
  /** Set = every ticket targets this org; null = the ticket names its org. */
  organization_id: string | null;
  company_name: string | null;
  allow_scim: boolean;
  /** The Admin Portal tasks this profile's tickets may perform. */
  intents: SsoPortalIntent[];
  /** Where "Finish" on the hosted setup page sends the admin. */
  return_url: string | null;
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
  /** This ticket's return_url (null = the profile's applies). */
  return_url: string | null;
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
  /** Where "Finish" will send the admin: the ticket's return_url, else the profile's. */
  effective_return_url: string | null;
}

export interface CreateSsoOnboardingProfileBody {
  name: string;
  /** Defaults to both `oidc` and `saml`. */
  allowed_connection_types?: Array<'oidc' | 'saml'>;
  /** Bind the profile to an org in this instance; omit for a per-ticket org. */
  organization_id?: string | null;
  company_name?: string | null;
  allow_scim?: boolean;
  /** Admin Portal tasks to grant; omit for the classic SSO (+ domain) profile. */
  intents?: SsoPortalIntent[];
  /** https, on one of your allowed origins. */
  return_url?: string | null;
}

export interface CreateSsoOnboardingTicketBody {
  /** Required for an unbound profile; must match (or be omitted) for a bound one. */
  organization_id?: string | null;
  /** Clamped to a 5-minute…30-day band; defaults to 3 days. */
  expires_in_seconds?: number;
  /** Overrides the profile's return_url for this ticket. */
  return_url?: string | null;
}

export function ssoOnboardingResource(request: RequestFn) {
  return {
    /** With `name`, only the profiles with exactly that name ("find or create"). */
    list(params: { name?: string } = {}): Promise<ListPage<SsoOnboardingProfile>> {
      return request({ method: 'GET', path: '/v1/sso_onboarding_profiles', query: { ...params } });
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
    /**
     * Create the profile with this name, or update it if it exists
     * (`PUT /v1/sso_onboarding_profiles/by_name/{name}`). Parallel calls for one
     * name create one profile.
     */
    upsertByName(name: string, body: Omit<CreateSsoOnboardingProfileBody, 'name'>): Promise<SsoOnboardingProfile> {
      return request({ method: 'PUT', path: `/v1/sso_onboarding_profiles/by_name/${enc(name)}`, body });
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

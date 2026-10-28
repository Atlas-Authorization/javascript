import { metadataQuery, type ProvisioningFields, type ProvisioningInput, type ProvisioningMetadata } from './compliance';
import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export interface TrustedIssuer {
  object: 'oauth_trusted_issuer';
  id: string;
  client_id: string;
  issuer: string;
  jwks: { keys: unknown[] } | null;
  jwks_uri: string | null;
  subject_mapping: 'user_id' | 'external_id' | 'email';
  workload_kind: 'generic' | 'spiffe' | 'kubernetes' | 'github_actions' | 'gcp' | 'azure';
  purpose: 'user_assertion' | 'client_auth' | 'both';
  subject_pattern: string | null;
  required_claims: Record<string, string> | null;
  audiences: string[] | null;
  created_at: number;
}

export interface TrustedIssuerInput {
  issuer?: string;
  jwks?: { keys: unknown[] };
  jwks_uri?: string;
  subject_mapping?: 'user_id' | 'external_id' | 'email';
  workload_kind?: TrustedIssuer['workload_kind'];
  tenant_id?: string;
  purpose?: TrustedIssuer['purpose'];
  subject_pattern?: string;
  required_claims?: Record<string, string>;
  audiences?: string[];
}

export interface WorkloadPreset {
  object: 'workload_identity_preset';
  kind: string;
  title: string;
  issuer: string | null;
  jwks_uri: string | null;
  subject_example: string;
  notes: string;
}

export interface OAuthClient extends ProvisioningFields {
  object: 'oauth_client';
  id: string;
  client_id: string;
  name: string;
  logo_url: string | null;
  redirect_uris: string[];
  allowed_scopes: string[];
  grant_types: string[];
  token_endpoint_auth_method: 'client_secret_basic' | 'client_secret_post' | 'none' | 'private_key_jwt' | 'workload_jwt';
  secret_prefix: string | null;
  /**
   * After a rotation with overlap: when the previous secret stops working (epoch
   * ms). Null when only the current secret is accepted.
   */
  previous_secret_expires_at?: number | null;
  is_public: boolean;
  first_party: boolean;
  /** Where the client may send users after an RP-initiated logout. */
  post_logout_redirect_uris: string[];
  /** UMA 2.0 claims-gathering redirect allowlist (exact match). */
  claims_redirect_uris: string[];
  /** Back-channel logout endpoint Atlas POSTs a `logout_token` to, or null. */
  backchannel_logout_uri: string | null;
  /** Whether the back-channel `logout_token` must carry `sid`. */
  backchannel_logout_session_required: boolean;
  /** Front-channel logout URL Atlas loads in an iframe on sign-out, or null. */
  frontchannel_logout_uri: string | null;
  /** Whether `iss` and `sid` are appended to the front-channel logout URL. */
  frontchannel_logout_session_required: boolean;
  /**
   * RP-initiated logout with this client's `client_id` and an exactly registered
   * `post_logout_redirect_uri` ends the session and redirects straight back,
   * with no "Sign out?" page. First-party clients only.
   */
  skip_logout_confirmation?: boolean;
  /** Refused at every OAuth endpoint while true (kept, not deleted). */
  disabled?: boolean;
  /** PKCE required even though the client is confidential. */
  require_pkce?: boolean;
  /** OIDC Core §8: `pairwise` clients see a per-sector `sub` instead of the user id. */
  subject_type?: 'public' | 'pairwise';
  sector_identifier_uri?: string | null;
  /** When the current secret stops authenticating (epoch ms); null = never. */
  client_secret_expires_at?: number | null;
  /** `jwt` or `opaque` access tokens for this client; null = inherited from the API / instance. */
  access_token_format?: AccessTokenFormat | null;
  /** This client's token lifetime overrides (seconds); a null field is inherited. */
  token_lifetimes?: OAuthTokenLifetimes;
  created_at: number;
  updated_at: number;
}

/** Signed JWT access tokens, or opaque references validated by introspection. */
export type AccessTokenFormat = 'jwt' | 'opaque';

/**
 * Token lifetimes in seconds. A field left out (or null) inherits the API's,
 * then the instance's, then Atlas's default. Bounds: access / id token 60–86400;
 * refresh token 300–31536000 (idle ≤ absolute); authorization code 10–600;
 * device code 60–1800.
 */
export interface OAuthTokenLifetimes {
  access_token_ttl_seconds?: number | null;
  id_token_ttl_seconds?: number | null;
  refresh_token_absolute_ttl_seconds?: number | null;
  refresh_token_idle_ttl_seconds?: number | null;
  authorization_code_ttl_seconds?: number | null;
  device_code_ttl_seconds?: number | null;
}

/** Access-token format and lifetimes, accepted on create and update. */
export interface OAuthClientTokenFields {
  /** `jwt` or `opaque`; null inherits. */
  access_token_format?: AccessTokenFormat | null;
  /** Replaces the overrides; null clears them all. */
  token_lifetimes?: OAuthTokenLifetimes | null;
}

/** OIDC Core §8 subject settings, accepted on create and update. */
export interface OAuthClientSubjectFields {
  /** `public` (default): the user id. `pairwise`: a per-sector identifier. */
  subject_type?: 'public' | 'pairwise';
  /** https URL serving a JSON array of every redirect URI; its host is the sector. `null` clears it. */
  sector_identifier_uri?: string | null;
}

/** An RFC 7591 §3 initial access token for dynamic client registration. */
export interface OAuthInitialAccessToken {
  object: 'oauth_initial_access_token';
  id: string;
  token_prefix: string;
  description: string | null;
  status: 'active' | 'expired' | 'used_up' | 'revoked';
  max_uses: number | null;
  use_count: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  created_at: number;
}

export interface CreateInitialAccessTokenBody {
  description?: string;
  /** Lifetime in seconds (60 – 31536000); omit for no expiry. */
  expires_in_seconds?: number;
  /** Registrations allowed (1 – 1000000); omit for unlimited. */
  max_uses?: number;
}

/**
 * OIDC logout registration (RP-Initiated, Back-Channel and Front-Channel
 * Logout), accepted on create and update. On update, `null` clears a URI and
 * `[]` clears the post-logout redirect list.
 */
export interface OAuthClientLogoutFields {
  post_logout_redirect_uris?: string[];
  /** UMA 2.0 claims-gathering redirect allowlist (exact match). */
  claims_redirect_uris?: string[];
  backchannel_logout_uri?: string | null;
  backchannel_logout_session_required?: boolean;
  frontchannel_logout_uri?: string | null;
  frontchannel_logout_session_required?: boolean;
  /** Skip the logout confirmation page. First-party clients only (`422` otherwise). */
  skip_logout_confirmation?: boolean;
}

/** Create/rotate reveal the secret exactly once, alongside the client. */
export interface OAuthClientWithSecret extends OAuthClient {
  client_secret?: string;
  /** With a `secretRecipient`: the client secret sealed to it (then `client_secret` is absent). */
  sealed_client_secret?: string;
  secrets_sealed?: { algorithm: string; recipient: string; fields: string[] };
  note: string;
}

export interface RotateOAuthClientSecretBody {
  /**
   * How long the previous secret keeps working, in seconds. Default 86400 (24
   * hours); 0 revokes it now (after a leak); at most 604800 (7 days).
   */
  overlap_seconds?: number;
  /** How long the NEW secret authenticates, in seconds; omit for no expiry. */
  secret_expires_in_seconds?: number;
}

/** The rotate response: the new secret (shown once) and when the old one stops working. */
export interface OAuthClientSecretRotation extends OAuthClientWithSecret {
  client_secret: string;
  /** The overlap applied, in seconds. */
  overlap_seconds: number;
  /** When the previous secret stops working (epoch ms), or null when it already has. */
  previous_secret_expires_at: number | null;
}

export interface ClientGrant {
  object: 'client_grant';
  id: string;
  /** The internal OAuthClient.id (not the public client_id). */
  client_id: string;
  resource_server_id: string;
  scopes: string[];
  created_at: number;
  updated_at: number;
}

export interface CreateOAuthClientBody extends ProvisioningInput, OAuthClientLogoutFields, OAuthClientSubjectFields, OAuthClientTokenFields {
  name: string;
  redirect_uris: string[];
  allowed_scopes?: string[];
  grant_types?: string[];
  token_endpoint_auth_method?: 'client_secret_basic' | 'client_secret_post' | 'none' | 'workload_jwt';
  logo_url?: string;
  first_party?: boolean;
  /** How long the issued secret authenticates, in seconds; omit for no expiry. */
  secret_expires_in_seconds?: number;
  /** Require PKCE. New clients default to true (confidential ones included); send false to opt out. */
  require_pkce?: boolean;
}

export interface UpdateOAuthClientBody extends OAuthClientLogoutFields, OAuthClientSubjectFields, OAuthClientTokenFields {
  /** Replaces the provisioning metadata. */
  metadata?: ProvisioningMetadata;
  name?: string;
  redirect_uris?: string[];
  allowed_scopes?: string[];
  token_endpoint_auth_method?: 'client_secret_basic' | 'client_secret_post' | 'none' | 'workload_jwt';
  logo_url?: string | null;
  first_party?: boolean;
  /** Refuse every OAuth flow for this client without deleting it. */
  disabled?: boolean;
  /** Require PKCE for this confidential client too. */
  require_pkce?: boolean;
}

/** One client in a migration import. Idempotent per `client_id`. */
export interface ImportOAuthClientEntry {
  /** Preserve the existing client_id. */
  client_id: string;
  name: string;
  redirect_uris: string[];
  /** Plaintext secret; hashed on import. Write-only. */
  client_secret?: string;
  /** A pre-computed secret hash imported verbatim (instead of `client_secret`). */
  client_secret_hash?: string;
  allowed_scopes?: string[];
  grant_types?: string[];
  token_endpoint_auth_method?: string;
}

/** An imported client as returned by `import`. */
export interface ImportedOAuthClient extends OAuthClient {
  client_secret?: string;
}

/**
 * One back-channel logout attempt to a client's `backchannel_logout_uri`.
 * Atlas never follows redirects: a 3xx fails with
 * `error: 'backchannel_redirect_not_followed'` and the `location` it pointed at.
 */
export interface BackchannelLogoutDelivery {
  object: 'backchannel_logout_delivery';
  id: string;
  oauth_client_id: string | null;
  /** The ended session (`sid_test_…` for a test); null for "sign out everywhere". */
  sid: string | null;
  /** Sent by `testBackchannelLogout`; never retried. */
  test: boolean;
  status: 'pending' | 'success' | 'failed';
  attempt_number: number;
  max_attempts: number;
  http_status: number | null;
  latency_ms: number | null;
  /**
   * `backchannel_redirect_not_followed`, `backchannel_http_error`,
   * `backchannel_timeout`, `backchannel_network_error` or `backchannel_url_blocked`.
   */
  error: string | null;
  location: string | null;
  response_snippet: string | null;
  next_retry_at: number | null;
  attempted_at: number | null;
  delivered_at: number | null;
  created_at: number;
}

/** A page of {@link BackchannelLogoutDelivery}, newest first. */
export interface BackchannelLogoutDeliveryPage extends ListPage<BackchannelLogoutDelivery> {
  has_more: boolean;
  /** Pass as `starting_after` for the next page. */
  next_cursor: string | null;
}

/** Paging for a delivery log. */
export interface BackchannelDeliveriesQuery {
  limit?: number;
  starting_after?: string;
}

/** The result of a test back-channel logout (a signed token for `sid_test_…` with `atlas_test: true`). */
export interface BackchannelLogoutTest {
  object: 'backchannel_logout_test';
  delivery_id: string;
  /** True when the receiver answered 2xx. */
  ok: boolean;
  sid: string;
  status: number | null;
  latency_ms: number | null;
  error: string | null;
  location: string | null;
  /** Set when nothing was sent because the URI points at a private, loopback or non-https address. */
  blocked_reason: string | null;
  /** First 512 characters of the response body. */
  body_excerpt: string | null;
}

export function oauthClientsResource(request: RequestFn) {
  return {
    /** Bulk-import OAuth clients for a migration, optionally with pre-hashed secrets. */
    import(
      body: { clients: ImportOAuthClientEntry[] },
      idempotencyKey?: string,
    ): Promise<ListPage<ImportedOAuthClient>> {
      return request({ method: 'POST', path: '/v1/oauth_clients/import', body, idempotencyKey });
    },
    /** `metadata` filters on provisioning tags (`?metadata[key]=value`). */
    list(params: { metadata?: ProvisioningMetadata } = {}): Promise<ListPage<OAuthClient>> {
      return request({ method: 'GET', path: '/v1/oauth_clients', query: metadataQuery(params.metadata) });
    },
    get(id: string): Promise<OAuthClient> {
      return request({ method: 'GET', path: `/v1/oauth_clients/${enc(id)}` });
    },
    create(body: CreateOAuthClientBody, idempotencyKey?: string): Promise<OAuthClientWithSecret> {
      return request({ method: 'POST', path: '/v1/oauth_clients', body, idempotencyKey });
    },
    update(id: string, body: UpdateOAuthClientBody): Promise<OAuthClient> {
      return request({ method: 'PATCH', path: `/v1/oauth_clients/${enc(id)}`, body });
    },
    /**
     * Mint a new secret. The previous one keeps working for `overlap_seconds`
     * (default 24 hours, max 7 days; 0 = revoke it now).
     */
    rotateSecret(
      id: string,
      body: RotateOAuthClientSecretBody = {},
      idempotencyKey?: string,
    ): Promise<OAuthClientSecretRotation> {
      return request({
        method: 'POST',
        path: `/v1/oauth_clients/${enc(id)}/rotate_secret`,
        body,
        idempotencyKey,
      });
    },
    delete(id: string): Promise<{ object: 'oauth_client'; id: string; deleted: true; note: string }> {
      return request({ method: 'DELETE', path: `/v1/oauth_clients/${enc(id)}` });
    },
    /**
     * Per-application settings: allowed sign-in methods, hosted-page branding,
     * the user-claim allow-list for ID tokens and userinfo, and writable traits.
     */
    appSettings: {
      /** `GET /v1/oauth_clients/:id/app_settings` */
      get(id: string): Promise<OAuthClientAppSettings> {
        return request({ method: 'GET', path: `/v1/oauth_clients/${enc(id)}/app_settings` });
      },
      /** `PATCH /v1/oauth_clients/:id/app_settings` — fields sent replace the stored ones; null clears. */
      update(id: string, body: OAuthClientAppSettingsPatch): Promise<OAuthClientAppSettings> {
        return request({ method: 'PATCH', path: `/v1/oauth_clients/${enc(id)}/app_settings`, body });
      },
    },
    /** The client's back-channel logout delivery log, newest first. */
    listBackchannelDeliveries(
      id: string,
      query: BackchannelDeliveriesQuery = {},
    ): Promise<BackchannelLogoutDeliveryPage> {
      return request({
        method: 'GET',
        path: `/v1/oauth_clients/${enc(id)}/backchannel_deliveries`,
        query: { ...query },
      });
    },
    /** Send a test back-channel logout now and return what the receiver answered. */
    testBackchannelLogout(id: string): Promise<BackchannelLogoutTest> {
      return request({ method: 'POST', path: `/v1/oauth_clients/${enc(id)}/backchannel_logout/test` });
    },

    /** Set (or clear with null) the URLs of your own sign-in and consent pages for a client. */
    setDelegatedUi(
      id: string,
      body: { login_url?: string | null; consent_url?: string | null },
    ): Promise<{ object: 'oauth_client_delegated_ui'; client_id: string; login_url: string | null; consent_url: string | null }> {
      return request({ method: 'PUT', path: `/v1/oauth_clients/${enc(id)}/delegated_ui`, body });
    },
    /** Delegated login: read, accept or reject the `login_challenge` your sign-in page received. */
    loginRequests: {
      get(loginChallenge: string): Promise<DelegatedLoginRequest> {
        return request({ method: 'GET', path: '/v1/oauth_login_requests', query: { login_challenge: loginChallenge } });
      },
      accept(
        loginChallenge: string,
        body: { subject: string; remember?: boolean; amr?: string[]; acr?: string },
      ): Promise<DelegatedRedirect> {
        return request({ method: 'PUT', path: '/v1/oauth_login_requests/accept', query: { login_challenge: loginChallenge }, body });
      },
      reject(loginChallenge: string, body: DelegatedReject = {}): Promise<DelegatedRedirect> {
        return request({ method: 'PUT', path: '/v1/oauth_login_requests/reject', query: { login_challenge: loginChallenge }, body });
      },
    },
    /** Delegated consent: read, accept or reject the `consent_challenge` your consent page received. */
    consentRequests: {
      get(consentChallenge: string): Promise<DelegatedConsentRequest> {
        return request({ method: 'GET', path: '/v1/oauth_consent_requests', query: { consent_challenge: consentChallenge } });
      },
      accept(consentChallenge: string, body: { grant_scope?: string[]; remember?: boolean } = {}): Promise<DelegatedRedirect> {
        return request({ method: 'PUT', path: '/v1/oauth_consent_requests/accept', query: { consent_challenge: consentChallenge }, body });
      },
      reject(consentChallenge: string, body: DelegatedReject = {}): Promise<DelegatedRedirect> {
        return request({ method: 'PUT', path: '/v1/oauth_consent_requests/reject', query: { consent_challenge: consentChallenge }, body });
      },
    },

    /** RFC 7591 §3 initial access tokens for dynamic client registration. */
    initialAccessTokens: {
      list(): Promise<ListPage<OAuthInitialAccessToken>> {
        return request({ method: 'GET', path: '/v1/oauth_initial_access_tokens' });
      },
      /** The `token` is in this response only. */
      create(body: CreateInitialAccessTokenBody = {}): Promise<OAuthInitialAccessToken & { token: string; note: string }> {
        return request({ method: 'POST', path: '/v1/oauth_initial_access_tokens', body });
      },
      revoke(id: string): Promise<OAuthInitialAccessToken> {
        return request({ method: 'DELETE', path: `/v1/oauth_initial_access_tokens/${enc(id)}` });
      },
    },

    /** Issuers whose signed tokens this client accepts (jwt-bearer grant, workload identity). */
    trustedIssuers: {
      list(clientId: string): Promise<ListPage<TrustedIssuer>> {
        return request({ method: 'GET', path: `/v1/oauth_clients/${enc(clientId)}/trusted_issuers` });
      },
      create(clientId: string, body: TrustedIssuerInput): Promise<TrustedIssuer> {
        return request({ method: 'POST', path: `/v1/oauth_clients/${enc(clientId)}/trusted_issuers`, body });
      },
      delete(clientId: string, issuerId: string): Promise<{ object: 'oauth_trusted_issuer'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/oauth_clients/${enc(clientId)}/trusted_issuers/${enc(issuerId)}` });
      },
    },

    /** Workload identity federation helpers (SPIFFE, Kubernetes, GitHub Actions, GCP, Azure). */
    workloadIdentity: {
      presets(): Promise<ListPage<WorkloadPreset>> {
        return request({ method: 'GET', path: '/v1/workload_identity/presets' });
      },
      cloudTrust(query: { provider: 'aws' | 'gcp' | 'azure'; audience: string; subject: string; tenant_id?: string }): Promise<Record<string, unknown>> {
        const qs = new URLSearchParams(query as Record<string, string>).toString();
        return request({ method: 'GET', path: `/v1/workload_identity/cloud_trust?${qs}` });
      },
    },

    grants: {
      list(clientId: string): Promise<ListPage<ClientGrant>> {
        return request({ method: 'GET', path: `/v1/oauth_clients/${enc(clientId)}/grants` });
      },
      create(
        clientId: string,
        body: { resource_server_id: string; scopes?: string[] },
      ): Promise<ClientGrant> {
        return request({
          method: 'POST',
          path: `/v1/oauth_clients/${enc(clientId)}/grants`,
          body,
        });
      },
      delete(
        clientId: string,
        grantId: string,
      ): Promise<{ object: 'client_grant'; id: string; deleted: true }> {
        return request({
          method: 'DELETE',
          path: `/v1/oauth_clients/${enc(clientId)}/grants/${enc(grantId)}`,
        });
      },
    },
  };
}

export interface OAuthClientAppBranding {
  heading?: string | null;
  subheading?: string | null;
  logo_url?: string | null;
  primary_color?: string | null;
}

export interface OAuthClientAppSettingsPatch {
  /** Method names (password, passkey, oauth_google, ...) or the families oauth and enterprise_sso. */
  allowed_sign_in_methods?: string[] | null;
  branding?: OAuthClientAppBranding | null;
  /** User claims the app receives in ID tokens and userinfo; protocol claims always pass. */
  claims_allowlist?: string[] | null;
  /** Traits a session from this app may change. */
  writable_traits?: string[] | null;
  /** Overrides of the instance's risk-based MFA for sign-ins to this app. */
  risk?: OAuthClientAppRisk | null;
}

export type OAuthClientRiskLevelAction = 'default' | 'allow' | 'notify' | 'mfa' | 'block';
export interface OAuthClientAppRisk {
  enabled?: boolean | null;
  mode?: 'enforce' | 'audit' | null;
  step_up_threshold?: 'low' | 'medium' | 'high' | null;
  on_high_risk_no_factor?: 'allow' | 'block' | 'require_enroll' | null;
  level_actions?: { medium?: OAuthClientRiskLevelAction | null; high?: OAuthClientRiskLevelAction | null } | null;
  /** The refresh-time check for sessions that came from this app. */
  mid_session?: { enabled?: boolean | null; action?: 'revoke' | 'notify' | 'audit' | null } | null;
}

export interface OAuthClientAppSettings {
  object: 'app_settings';
  client_id: string;
  allowed_sign_in_methods: string[] | null;
  branding: Required<OAuthClientAppBranding> | null;
  claims_allowlist: string[] | null;
  writable_traits: string[] | null;
  risk: OAuthClientAppRisk | null;
}

export interface DelegatedClientRef {
  id: string;
  client_id: string;
  name: string;
  first_party?: boolean;
}
export interface DelegatedLoginRequest {
  object: 'oauth_login_request';
  client: DelegatedClientRef;
  requested_scope: string[];
  audience: string | null;
  page: 'sign-in' | 'sign-up';
  /** The Atlas user already signed in on this browser, if any. */
  session_subject: string | null;
  ui_locales: string | null;
  login_hint: string | null;
  expires_at: number;
}
export interface DelegatedConsentRequest {
  object: 'oauth_consent_request';
  subject: string;
  client: DelegatedClientRef;
  requested_scope: string[];
  audience: string | null;
  authorization_details: unknown[];
  organization_id: string | null;
  redirect_uri: string;
  expires_at: number;
}
export interface DelegatedRedirect {
  object: 'oauth_login_redirect' | 'oauth_consent_redirect';
  /** Send the end user's browser here next. */
  redirect_to: string;
}
export interface DelegatedReject {
  error?:
    | 'access_denied'
    | 'login_required'
    | 'interaction_required'
    | 'consent_required'
    | 'account_selection_required'
    | 'unauthorized_client'
    | 'temporarily_unavailable'
    | 'server_error';
  error_description?: string;
}

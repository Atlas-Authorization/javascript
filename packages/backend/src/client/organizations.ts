import { enc, type RequestFn } from './request';
import { paginate } from './paginate';
import type { WebhookBulkResult, WebhookDelivery, WebhookDeliveryQueued, WebhookEndpoint, WebhookEndpointWithSecret, WebhookTestResult, WebhookWindow } from './webhooks';
import type { CursorPage, CursorParams, DataList, DeletedObject, ListPage, Metadata } from './types';

export interface Organization {
  object: 'organization';
  id: string;
  name: string;
  slug: string;
  image_url: string | null;
  public_metadata: Metadata;
  max_allowed_memberships: number;
  /** null when your backend created the organization without a creator. */
  created_by: string | null;
  /** Your own id for this customer; unique per instance. */
  external_id: string | null;
  /** Role key → your product's name for it (echoed as the `org_role_mapped` token claim). */
  role_mappings: Record<string, string> | null;
  /** On create with `owner_email` only: the invitation sent to that address. */
  owner_invitation?: {
    object: 'organization_invitation';
    id: string;
    email: string;
    role: string;
    status: string;
    expires_at: number | null;
  };
  created_at: number;
  updated_at: number;
}

/** GET /v1/organizations/{id}: the organization plus its SSO setup. */
export interface OrganizationDetail extends Organization {
  sso?: {
    connections: { id: string; type: string; status: 'draft' | 'active' | 'disabled' }[];
    /** The SCIM 2.0 base URL to give this organization's identity provider. */
    scim_base_url: string;
  };
}

/** GET /v1/organizations/by_domain/{domain}: the owning organization and the matched domain. */
export interface OrganizationByDomain extends Organization {
  domain: { object: 'org_domain'; id: string; domain: string; status: OrgDomainStatus; verified_at: number | null };
}

export type OrgDomainStatus = 'pending' | 'verified' | 'failed';
export type OrgDomainVerificationMethod = 'dns_txt' | 'well_known' | 'email';

export interface ListOrganizationsParams extends CursorParams {
  /** Only the organization with this external_id. */
  external_id?: string;
  /** public_metadata equality filters, sent as ?metadata[key]=value (AND). */
  metadata?: Record<string, string>;
}

export interface OrganizationMembership {
  object: 'organization_membership';
  id: string;
  organization_id: string;
  user_id: string;
  role: string;
  /**
   * Who manages the role: `scim`, `sso:<connection id>` or `ldap:<connection id>`
   * (the identity provider keeps it in step), `directory_sync`, `manual` (set
   * through the API or dashboard), or null (joined by invitation, or older rows).
   */
  role_source?: string | null;
  /** Readable by the application; set from the invitation on accept or with `update`. Also in `{{org.membership.public_metadata.*}}` JWT template variables. */
  public_metadata?: Record<string, unknown>;
  /** Backend only: never in a token or a client response, and in a webhook only for an instance-owned endpoint that set `include_private_membership`. */
  private_metadata?: Record<string, unknown>;
  /** Permission keys this member holds on top of the role; they join `org_permissions` in the session token. */
  permissions?: string[];
  /** Sign-in methods whose sessions mint with this organization's claims; null = any. */
  allowed_sign_in_methods?: string[] | null;
  /** When the seat ends (epoch ms); it is then removed and `organization_membership.expired` is sent. Null = never. */
  expires_at?: number | null;
  created_at: number;
}

/** An end date for a seat: ISO 8601 or epoch ms in the future; null clears it. */
export interface OrganizationSeatExpiry {
  expires_at?: string | number | null;
}

/** The grants a membership or an invitation carries beyond its role. */
export interface OrganizationSeatGrants {
  public_metadata?: Record<string, unknown>;
  private_metadata?: Record<string, unknown>;
  /** Permission keys that exist in the instance; added to the role's permissions in `org_permissions`. */
  permissions?: string[];
  /** e.g. `["passkey", "oauth:google"]`; null (or []) = any method. */
  allowed_sign_in_methods?: string[] | null;
}

/** An invitation row for `invitations.import`. */
export interface OrganizationInvitationImportRow extends OrganizationSeatGrants {
  email: string;
  role: string;
  /** The 64-character hex SHA-256 of the accept token already issued. Never the token. */
  token_sha256: string;
  /** Epoch milliseconds or ISO 8601; defaults to the instance's invitation TTL. */
  expires_at?: number | string;
  inviter_user_id?: string | null;
  accept_by?: 'link' | 'verified_email';
}

/** `POST /v1/organizations/:id/invitations/import`. */
export interface OrganizationInvitationImport {
  object: 'organization_invitation_import';
  organization_id: string;
  dry_run: boolean;
  created: number;
  unchanged: number;
  invalid: number;
  data: Array<
    | { index: number; status: 'created' | 'unchanged' | 'would_create'; id?: string }
    | { index: number; status: 'invalid_row'; code: string; message: string; param?: string }
  >;
}

/** `GET /v1/organizations/:id/mfa_status`: does a session meet one organization's MFA policy. */
export interface OrganizationMfaStatus {
  object: 'organization_mfa_status';
  organization_id: string;
  user_id: string;
  session_id: string;
  /** The session user belongs to the organization (an ancestor seat counts when role inheritance is on). */
  member: boolean;
  /** The organization requires MFA. */
  required: boolean;
  /** A member whose session meets the policy (true when MFA is not required). Gate on this. */
  ok: boolean;
  enforcement: 'withhold_claims' | 'require_step_up';
  reasons?: string[];
  max_age_seconds?: number;
  /** Seconds since the session last passed a second factor; absent when it never has. */
  mfa_age_seconds?: number;
  allowed_factors?: string[];
}

export interface OrganizationInvitation {
  object: 'organization_invitation';
  id: string;
  organization_id: string;
  email: string;
  role: string;
  status: string;
  inviter_user_id: string | null;
  /** `email`: your app sends it. `link`: nothing is sent; the accept link is the delivery. */
  delivery?: 'email' | 'link';
  /** Who may accept by link: `link` (whoever holds it, signed in) or `verified_email`; null = the instance setting `organizations.invitationAccept`. */
  accept_by?: 'link' | 'verified_email' | null;
  public_metadata?: Record<string, unknown>;
  private_metadata?: Record<string, unknown>;
  permissions?: string[];
  allowed_sign_in_methods?: string[] | null;
  accepted_by_user_id?: string | null;
  /** The verified address of the user who accepted, when it differs from `email`. */
  accepted_email_address?: string | null;
  expires_at: number;
  created_at: number;
  /** Link delivery, on create and resend only, shown once: the single-use token (only its SHA-256 is stored). */
  accept_token?: string;
  /** Link delivery with `redirect_url`, on create only, shown once: that URL with `?invitation_token=` appended. */
  accept_url?: string | null;
  /** With the instance setting `organizations.invitationEmail: "atlas"` on an email invitation: whether Atlas mailed it (false: no email provider could deliver; a resend tries again). */
  email_sent?: boolean;
}

export interface OrgDomain {
  object: 'org_domain';
  id: string;
  organization_id: string;
  domain: string;
  status: OrgDomainStatus;
  auto_join: boolean;
  default_role_id: string | null;
  verification: {
    record_name: string;
    record_type: 'TXT';
    record_value: string;
  };
  /** Every way to prove the domain. */
  verification_methods: {
    dns_txt: { record_name: string; record_type: 'TXT'; record_value: string };
    well_known: { url: string; body: string; content_type: string };
    email: { addresses: string[]; sent_to: string | null; expires_at: number | null };
  };
  verification_method: OrgDomainVerificationMethod | null;
  verified_at: number | null;
  last_checked_at: number | null;
  created_at: number;
}

/** Whether an organization runs an end-user (reader) pool beside its staff members. */
export interface OrganizationEndUserPoolPolicy {
  enabled: boolean;
  /** New readers start `pending` until approved. */
  requireApproval?: boolean;
  /** Readers may sign up on the hosted pages. */
  allowHostedSignup?: boolean;
}

/** Tighten-only password rules an org layers over the instance policy. */
export interface OrgPasswordPolicyOverride {
  minLength?: number;
  checkBreaches?: true;
  requireUppercase?: true;
  requireLowercase?: true;
  requireNumber?: true;
  requireSymbol?: true;
  bannedPasswords?: string[];
}

/**
 * The organization's security policy overrides. Keys are camelCase on this
 * route, and only overrides that are set appear. Unknown keys from a newer API
 * version are kept in the index signature.
 */
export interface OrganizationPolicySettings {
  requireMfa?: boolean;
  requireMfaReasons?: string[];
  mfaEnforcement?: 'withhold_claims' | 'require_step_up';
  mfaMaxAgeSeconds?: number;
  allowedMfaFactors?: Array<'totp' | 'sms' | 'passkey' | 'push'>;
  /** Factor classes every member must have used; implies an MFA session. */
  requiredFactors?: Array<'totp' | 'sms' | 'passkey' | 'push'>;
  /** Tighten-only password rules for members. */
  passwordPolicyOverride?: OrgPasswordPolicyOverride;
  ssoRequired?: boolean;
  sessionIdleOverrideMs?: number;
  /**
   * Sign-in methods a member may use (e.g. `password`, `passkey`, `oauth`,
   * `oauth:google`, `saml`, `magic_link`). Absent = all methods.
   */
  allowedSignInMethods?: string[];
  /** CIDR allow-list gating member sign-in (e.g. `203.0.113.0/24`). Absent = unrestricted. */
  ipAllowlist?: string[];
  /** Cap on the absolute session lifetime for members, in seconds (300 … 7776000). */
  maxSessionAgeSeconds?: number;
  /** Cap on each member's concurrent active sessions (1 to 100). The smallest cap across the user's organizations wins. */
  maxSessions?: number;
  /** Allow this organization more than one enterprise SSO connection. */
  ssoMultiConnection?: boolean;
  endUserPool?: OrganizationEndUserPoolPolicy;
  /** Break-glass: addresses (at most 20) that may still use a password while `ssoRequired` is on. Each use is audited. */
  ssoBypass?: string[];
  /** Technical contacts (at most 10) recorded for the organization's connections. */
  itContacts?: Array<{ email: string; name?: string; role?: string }>;
  [key: string]: unknown;
}

export interface OrganizationPolicy {
  object: 'organization_policy';
  organization_id: string;
  policy: OrganizationPolicySettings;
}

/** An organization's settings document, validated against the instance's settings schema. */
export interface OrganizationSettings {
  object: 'organization_settings';
  organization_id: string;
  values: Record<string, unknown>;
  /** Monotonic per-organization version; 0 when nothing is set yet. */
  version: number;
  updated_by: string | null;
  /** Last write (epoch ms), or null if never set. */
  updated_at: number | null;
}

/** An organization's audit stream destination. The signing secret is never returned. */
export interface OrganizationAuditStream {
  object: 'org_audit_stream';
  id: string;
  organization_id: string;
  url: string;
  /** `json`, `ocsf` or `cef`. */
  format: 'json' | 'ocsf' | 'cef' | (string & {});
  /** Where the record goes. */
  sink_type: 'https' | 'splunk_hec' | 'datadog' | 'elastic' | (string & {});
  sink_config: Record<string, string> | null;
  active: boolean;
  has_secret: boolean;
  created_at: number;
}

export interface CreateOrganizationAuditStreamBody {
  /** Public HTTPS endpoint of the SIEM/collector. */
  url: string;
  /** For `https`: the shared HMAC-SHA256 signing secret (min 16 chars). For a vendor sink: its token (Splunk HEC token, Datadog API key, Elastic API key). Write-only. */
  secret: string;
  /** How each record is written: `json` (default), `ocsf` (OCSF API Activity) or `cef` (ArcSight CEF line). */
  format?: 'json' | 'ocsf' | 'cef';
  /** `https` (default, a signed POST), `splunk_hec`, `datadog` or `elastic`. */
  sink_type?: 'https' | 'splunk_hec' | 'datadog' | 'elastic';
  /** Non-secret sink settings: Splunk `index`, `source`, `sourcetype`; Datadog `service`, `tags`. */
  sink_config?: Record<string, string>;
}

/** The organization's hosted-page branding overlay. Null fields inherit the instance brand. */
export interface OrganizationBranding {
  object: 'organization_branding';
  organization_id: string;
  display_name: string | null;
  logo_url: string | null;
  primary_color: string | null;
  support_url: string | null;
  custom_domain: string | null;
  updated_at: number | null;
}

/** A partial merge: a provided field overrides, `null` (or `''`) clears it back. */
export interface UpdateOrganizationBrandingBody {
  display_name?: string | null;
  logo_url?: string | null;
  primary_color?: string | null;
  support_url?: string | null;
  custom_domain?: string | null;
}

export type OrganizationEndUserStatus = 'active' | 'pending' | 'blocked';

/** A reader in an organization's end-user pool (distinct from its staff members). */
export interface OrganizationEndUser {
  object: 'organization_end_user';
  id: string;
  organization_id: string;
  user_id: string;
  status: OrganizationEndUserStatus;
  source: string;
  public_metadata: Metadata;
  approved_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ListOrganizationEndUsersParams extends CursorParams {
  status?: OrganizationEndUserStatus;
}

export interface AddOrganizationEndUserBody {
  user_id: string;
  /** Defaults to `active`. */
  status?: OrganizationEndUserStatus;
  /** How the reader entered the pool. Defaults to `token_exchange`. */
  source?: 'hosted' | 'federated' | 'token_exchange' | 'import';
}

/** A host whose sign-ups join the organization's end-user pool. */
export interface OrganizationReaderDomain {
  object: 'custom_domain';
  id: string;
  role: string;
  host: string;
  status: string;
  action: string | null;
  live: boolean;
  cname_target: string | null;
  last_checked_at: number | null;
  last_observed_target: string | null;
  failure_reason: string | null;
  certificate_expires_at: number | null;
  cookie_domain: string | null;
}

/** The reader domain just bound, with the DNS record to publish. */
export interface OrganizationReaderDomainCreated extends OrganizationReaderDomain {
  instructions: Array<{
    role: string;
    host: string;
    type: 'CNAME';
    target: string;
    purpose: string;
  }>;
  note: string;
}

export interface OrganizationHierarchy {
  object: 'organization_hierarchy';
  organization_id: string;
  ancestors: Array<{ id: string; name: string; slug: string }>;
  children: Array<{ id: string; name: string; slug: string }>;
}

export interface OrganizationEntitlements {
  object: 'organization_entitlements';
  organization_id: string;
  plan: string | null;
  features: Record<string, unknown>;
  catalog: { features: unknown; plans: unknown };
}

export interface CreateOrganizationBody {
  name: string;
  /** Omit to derive a unique slug from the name (suffixed -2, -3… on collision); it is returned in the response. */
  slug?: string;
  /** Seated with the creator role; omit (or null) for a backend-created organization with no members yet. */
  created_by?: string | null;
  external_id?: string;
  public_metadata?: Metadata;
  private_metadata?: Metadata;
  /** Invites this address with the creator role (org:admin by default). */
  owner_email?: string;
  role_mappings?: Record<string, string>;
  max_allowed_memberships?: number;
}

export interface UpdateOrganizationBody {
  /** null clears it. */
  external_id?: string | null;
  /** null clears them. */
  role_mappings?: Record<string, string> | null;
  name?: string;
  slug?: string;
  image_url?: string;
  max_allowed_memberships?: number;
  public_metadata?: Metadata;
  private_metadata?: Metadata;
}

export interface ReplaceOrganizationMetadataBody {
  public_metadata?: Metadata;
  private_metadata?: Metadata;
}

/**
 * The org security policy patch (§4.4), a partial merge. Fields are camelCase on
 * this route; an explicit `null` clears an override.
 */
export interface OrganizationPolicyPatch {
  requireMfa?: boolean | null;
  /** Replace the whole reason list; `null` clears it. MFA stays required while any tag remains. */
  requireMfaReasons?: string[] | null;
  /** Add reason tags without touching the others. */
  requireMfaReasonsAdd?: string[];
  /** Remove reason tags without touching the others. */
  requireMfaReasonsRemove?: string[];
  /** `withhold_claims` (default) or `require_step_up` (activating the org also needs a step-up). */
  mfaEnforcement?: 'withhold_claims' | 'require_step_up' | null;
  /** The last second factor must be at most this many seconds old (60 to 7776000). */
  mfaMaxAgeSeconds?: number | null;
  /** Accepted second-factor kinds. `totp`, `sms` and `push` are indistinguishable on the session. */
  allowedMfaFactors?: Array<'totp' | 'sms' | 'passkey' | 'push'> | null;
  requiredFactors?: Array<'totp' | 'sms' | 'passkey' | 'push'> | null;
  passwordPolicyOverride?: OrgPasswordPolicyOverride | null;
  ssoRequired?: boolean | null;
  ssoBypass?: string[] | null;
  itContacts?: Array<{ email: string; name?: string; role?: string }> | null;
  sessionIdleOverrideMs?: number | null;
  /** Restrict member sign-in methods; `null` clears (all methods). Unknown method → 400. */
  allowedSignInMethods?: string[] | null;
  /** CIDR allow-list for member sign-in; `null` clears. A bad CIDR → 400. */
  ipAllowlist?: string[] | null;
  /** Absolute session lifetime cap in seconds (300 … 7776000); `null` clears. */
  maxSessionAgeSeconds?: number | null;
  maxSessions?: number | null;
  ssoMultiConnection?: boolean | null;
  /** Retired: only `null` is accepted, to clear a stored value. Use `entitlementOverrides.create`. */
  entitlementPlan?: null;
  /** Retired: only `null` is accepted, to clear a stored value. */
  entitlementOverrides?: null;
  endUserPool?: OrganizationEndUserPoolPolicy | null;
  [key: string]: unknown;
}

/** Fields an organization's endpoint accepts. */
export interface OrganizationWebhookEndpointBody {
  url?: string;
  /** Event types, or ["*"]; only this organization's events are ever delivered. */
  enabled_events?: string[];
  description?: string | null;
  active?: boolean;
}

export interface OrganizationRolePolicy {
  object: 'organization_role_policy';
  organization_id: string;
  role_set: { id: string; key: string } | null;
  /** The role keys the organization may assign; null when unrestricted. */
  allowed_roles: string[] | null;
  default_role: string;
  default_role_source: 'organization' | 'role_set' | 'system';
}

export interface OrganizationSeats {
  object: 'organization_seats';
  organization_id: string;
  /** `max_allowed_memberships`; null = unlimited. */
  limit: number | null;
  used: number;
  pending_invitations: number;
  /** Seats left after members and pending invitations; null when unlimited. */
  available: number | null;
  percent_used: number | null;
  warn_percent: number | null;
  state: 'ok' | 'low' | 'full';
}

export interface OrganizationMembershipImportRow {
  email?: string;
  user_id?: string;
  role?: string;
  expires_at?: string | number | null;
  public_metadata?: Record<string, unknown>;
}

/** Send `memberships` or `csv` (header row: email, user_id, role, expires_at), not both. */
export type OrganizationMembershipImportBody = (
  | { memberships: OrganizationMembershipImportRow[]; csv?: never }
  | { csv: string; memberships?: never }
) & {
  /** What to do with someone already a member. Default `skip`. */
  on_existing?: 'skip' | 'update';
  /** Invite an email that no account has. */
  invite_missing?: boolean;
  default_role?: string;
};

export interface OrganizationMembershipImportJob {
  object: 'job';
  id: string;
  type: 'org_membership_import';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  error_count: number;
  /** Rows by outcome once finished: added, updated, skipped, invited. */
  results?: Record<string, number> | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export function organizationsResource(request: RequestFn) {
  return {
    list(params: ListOrganizationsParams = {}): Promise<CursorPage<Organization>> {
      const { metadata, ...rest } = params;
      const query: Record<string, string | number | boolean | undefined> = { ...rest };
      for (const [k, v] of Object.entries(metadata ?? {})) query[`metadata[${k}]`] = v;
      return request({ method: 'GET', path: '/v1/organizations', query });
    },
    get(id: string): Promise<OrganizationDetail> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(id)}` });
    },
    /** The organization owning a domain (or an email address's domain). Verified domains only unless includeUnverified. */
    findByDomain(domain: string, opts: { includeUnverified?: boolean } = {}): Promise<OrganizationByDomain> {
      return request({
        method: 'GET',
        path: `/v1/organizations/by_domain/${enc(domain)}`,
        query: opts.includeUnverified ? { include_unverified: 'true' } : {},
      });
    },
    /** `GET /v1/organizations/:id/policy`. */
    getPolicy(id: string): Promise<OrganizationPolicy> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(id)}/policy` });
    },
    create(body: CreateOrganizationBody, idempotencyKey?: string): Promise<Organization> {
      return request({ method: 'POST', path: '/v1/organizations', body, idempotencyKey });
    },
    update(id: string, body: UpdateOrganizationBody): Promise<Organization> {
      return request({ method: 'PATCH', path: `/v1/organizations/${enc(id)}`, body });
    },
    /**
     * Create the organization with this `external_id`, or update it if it exists
     * (`PUT /v1/organizations/by_external_id/{external_id}`). Race-safe: parallel
     * calls for one id create one organization. `name` is required when it creates.
     */
    upsertByExternalId(
      externalId: string,
      body: Omit<CreateOrganizationBody, 'external_id'>,
      idempotencyKey?: string,
    ): Promise<Organization> {
      return request({ method: 'PUT', path: `/v1/organizations/by_external_id/${enc(externalId)}`, body, idempotencyKey });
    },
    delete(id: string): Promise<DeletedObject> {
      return request({ method: 'DELETE', path: `/v1/organizations/${enc(id)}` });
    },
    /** `PUT /v1/organizations/:id/metadata` — replaces the named bags wholesale. */
    updateMetadata(id: string, body: ReplaceOrganizationMetadataBody): Promise<Organization> {
      return request({ method: 'PUT', path: `/v1/organizations/${enc(id)}/metadata`, body });
    },
    /** `PATCH /v1/organizations/:id/policy`. */
    updatePolicy(id: string, body: OrganizationPolicyPatch): Promise<OrganizationPolicy> {
      return request({ method: 'PATCH', path: `/v1/organizations/${enc(id)}/policy`, body });
    },
    /**
     * `PUT /v1/organizations/:id/parent` — set (or clear, with null) the org's
     * parent in the B2B2B hierarchy. A cycle is refused; clearing re-parents to
     * top level.
     */
    setParent(id: string, body: { parent_organization_id: string | null }): Promise<Organization> {
      return request({ method: 'PUT', path: `/v1/organizations/${enc(id)}/parent`, body });
    },
    /** `GET /v1/organizations/:id/hierarchy` — ancestor chain (nearest first) + direct children. */
    hierarchy(id: string): Promise<OrganizationHierarchy> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(id)}/hierarchy` });
    },
    /**
     * `GET /v1/organizations/:id/entitlements` — the org's active feature set,
     * resolved from its assigned plan + overrides against the instance catalog.
     */
    entitlements(id: string): Promise<OrganizationEntitlements> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(id)}/entitlements` });
    },

    /**
     * `GET /v1/organizations/:id/mfa_status` — whether the session meets THIS
     * organization's MFA policy, for any organization the user belongs to (not
     * only the token's active one). `orgId` is the Atlas id or the external id.
     */
    mfaStatus(orgId: string, opts: { sessionId: string }): Promise<OrganizationMfaStatus> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(orgId)}/mfa_status`, query: { session_id: opts.sessionId } });
    },

    /** The role set an organization assigns from and its default role. */
    rolePolicy: {
      get(orgId: string): Promise<OrganizationRolePolicy> {
        return request({ method: 'GET', path: `/v1/organizations/${enc(orgId)}/role_policy` });
      },
      /** `role_set` (an id or key) and/or `default_role`; null clears. */
      put(orgId: string, body: { role_set?: string | null; default_role?: string | null }): Promise<OrganizationRolePolicy> {
        return request({ method: 'PUT', path: `/v1/organizations/${enc(orgId)}/role_policy`, body });
      },
    },

    /** Seats used, pending invitations and seats left; set the limit and the warning level. */
    seats: {
      get(orgId: string): Promise<OrganizationSeats> {
        return request({ method: 'GET', path: `/v1/organizations/${enc(orgId)}/seats` });
      },
      put(orgId: string, body: { limit?: number | null; warn_percent?: number | null }): Promise<OrganizationSeats> {
        return request({ method: 'PUT', path: `/v1/organizations/${enc(orgId)}/seats`, body });
      },
    },

    membershipImports: {
      /** Queue up to 5000 memberships as a background job; poll `jobs.get(job.id)`. */
      create(orgId: string, body: OrganizationMembershipImportBody, idempotencyKey?: string): Promise<OrganizationMembershipImportJob> {
        return request({ method: 'POST', path: `/v1/organizations/${enc(orgId)}/membership_imports`, body, idempotencyKey });
      },
    },

    memberships: {
      list(
        orgId: string,
        params: { limit?: number; starting_after?: string; user_id?: string } = {},
      ): Promise<{ data: OrganizationMembership[]; has_more: boolean; next_cursor?: string | null }> {
        return request({ method: 'GET', path: `/v1/organizations/${enc(orgId)}/memberships`, query: { ...params } });
      },
      /** Every membership of the organization, following the cursor. */
      listAll(orgId: string, params: { limit?: number } = {}): AsyncGenerator<OrganizationMembership, void, void> {
        return paginate<OrganizationMembership, { limit?: number; starting_after?: string }>(
          (p) =>
            request<CursorPage<OrganizationMembership>>({
              method: 'GET',
              path: `/v1/organizations/${enc(orgId)}/memberships`,
              query: { ...p },
            }),
          params,
        );
      },
      /** One membership (role, `role_source`); 404 when the user is not a member. */
      get(orgId: string, userId: string): Promise<OrganizationMembership> {
        return request({ method: 'GET', path: `/v1/organizations/${enc(orgId)}/memberships/${enc(userId)}` });
      },
      /**
       * Create or update. A role managed by a directory (SCIM/SSO/LDAP) that
       * `role_source` does not name is left alone: the answer has `unchanged: true`.
       */
      upsert(
        orgId: string,
        userId: string,
        body: { role: string; role_source?: string } & OrganizationSeatGrants & OrganizationSeatExpiry,
        idempotencyKey?: string,
      ): Promise<OrganizationMembership & { unchanged: boolean }> {
        return request({
          method: 'PUT',
          path: `/v1/organizations/${enc(orgId)}/memberships/${enc(userId)}`,
          body,
          idempotencyKey,
        });
      },
      /**
       * Seat a person by the id your own system gives them (`external_id`), before they have signed in. With a user
       * that has that external_id this is `upsert`; with none the seat waits (`status: 'pending'`) and is attached when
       * a user with that external_id is created, imported or given it. Repeating the call replaces the waiting seat.
       */
      upsertByExternalId(
        orgId: string,
        userExternalId: string,
        body: { role: string; role_source?: string } & OrganizationSeatGrants & OrganizationSeatExpiry,
        idempotencyKey?: string,
      ): Promise<
        | (OrganizationMembership & { status: 'active'; user_external_id: string; unchanged: boolean })
        | { object: 'pending_organization_membership'; id: string; organization_id: string; user_external_id: string; role: string; status: 'pending'; expires_at: number | null; created_at: number }
      > {
        return request({
          method: 'PUT',
          path: `/v1/organizations/${enc(orgId)}/memberships/by_external_id/${enc(userExternalId)}`,
          body,
          idempotencyKey,
        });
      },
      /** Cancel a seat that is still waiting for its person. */
      cancelPendingByExternalId(orgId: string, userExternalId: string): Promise<{ object: 'pending_organization_membership'; organization_id: string; user_external_id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/organizations/${enc(orgId)}/memberships/by_external_id/${enc(userExternalId)}` });
      },
      add(
        orgId: string,
        body: { user_id: string; role?: string } & OrganizationSeatGrants & OrganizationSeatExpiry,
        idempotencyKey?: string,
      ): Promise<{
        object: 'organization_membership';
        organization_id: string;
        user_id: string;
        role: string;
        public_metadata?: Record<string, unknown>;
        private_metadata?: Record<string, unknown>;
        permissions?: string[];
        allowed_sign_in_methods?: string[] | null;
      }> {
        return request({
          method: 'POST',
          path: `/v1/organizations/${enc(orgId)}/memberships`,
          body,
          idempotencyKey,
        });
      },
      update(
        orgId: string,
        userId: string,
        /**
         * `role_source`: `manual` takes the role out of directory control; `scim`,
         * `sso:<connection id>` or `ldap:<connection id>` hands it back to that source.
         * A role sent alone counts as `manual`.
         */
        body: { role?: string; role_source?: string } & OrganizationSeatGrants & OrganizationSeatExpiry,
      ): Promise<{
        object: 'organization_membership';
        role?: string;
        role_source?: string | null;
        public_metadata?: Record<string, unknown>;
        private_metadata?: Record<string, unknown>;
        permissions?: string[];
        allowed_sign_in_methods?: string[] | null;
        updated: true;
      }> {
        return request({
          method: 'PATCH',
          path: `/v1/organizations/${enc(orgId)}/memberships/${enc(userId)}`,
          body,
        });
      },
      remove(
        orgId: string,
        userId: string,
      ): Promise<{ object: 'organization_membership'; deleted: true }> {
        return request({
          method: 'DELETE',
          path: `/v1/organizations/${enc(orgId)}/memberships/${enc(userId)}`,
        });
      },
    },

    invitations: {
      /**
       * `GET /v1/organization_invitations` — search invitations across every organization: by invited `email` (exact,
       * case-insensitive), `status` or `organization_id`, newest first. Each row also carries `organization_name` and
       * `organization_slug`. Secret key only. Pages with `limit` and `starting_after`.
       */
      listByEmail(
        params: CursorParams & { email?: string; status?: 'pending' | 'accepted' | 'revoked' | 'expired' | 'declined'; organization_id?: string } = {},
      ): Promise<CursorPage<OrganizationInvitation & { organization_name: string; organization_slug: string }>> {
        return request({ method: 'GET', path: '/v1/organization_invitations', query: { ...params } });
      },
      list(orgId: string): Promise<ListPage<OrganizationInvitation>> {
        return request({ method: 'GET', path: `/v1/organizations/${enc(orgId)}/invitations` });
      },
      create(
        orgId: string,
        body: {
          email: string;
          role: string;
          inviter_user_id: string;
          /** `link`: no mail; `accept_token` (and `accept_url` with `redirect_url`) come back once. Default `email`. */
          delivery?: 'email' | 'link';
          accept_by?: 'link' | 'verified_email';
          /** A page in your app on one of the instance's allowed origins; `accept_url` is this URL with `?invitation_token=` appended. Required for an email invitation when the instance has `organizations.invitationEmail: "atlas"`. */
          redirect_url?: string;
        } & OrganizationSeatGrants,
        idempotencyKey?: string,
      ): Promise<OrganizationInvitation> {
        return request({
          method: 'POST',
          path: `/v1/organizations/${enc(orgId)}/invitations`,
          body,
          idempotencyKey,
        });
      },
      revoke(
        orgId: string,
        invitationId: string,
      ): Promise<{ object: 'organization_invitation'; id: string; status: 'revoked' }> {
        return request({
          method: 'POST',
          path: `/v1/organizations/${enc(orgId)}/invitations/${enc(invitationId)}/revoke`,
        });
      },
      /**
       * Same id, a fresh expiry; a link invitation gets a NEW `accept_token` (the old link stops working).
       * With `organizations.invitationEmail: "atlas"`, pass `redirect_url`: Atlas mails an email invitation again.
       */
      resend(orgId: string, invitationId: string, body?: { redirect_url?: string; /** Keep the replaced link working while the invitation is pending (the last 5 are kept). */ keep_old_link?: boolean }): Promise<OrganizationInvitation> {
        return request({
          method: 'POST',
          path: `/v1/organizations/${enc(orgId)}/invitations/${enc(invitationId)}/resend`,
          ...(body ? { body } : {}),
        });
      },
      /**
       * Import invitations that already exist elsewhere, keeping their links working:
       * each row carries the `token_sha256` of the token already issued and its `expires_at`.
       * Up to 500 rows; `dry_run` checks every row and writes nothing.
       */
      import(
        orgId: string,
        body: { invitations: OrganizationInvitationImportRow[]; dry_run?: boolean },
        idempotencyKey?: string,
      ): Promise<OrganizationInvitationImport> {
        return request({
          method: 'POST',
          path: `/v1/organizations/${enc(orgId)}/invitations/import`,
          body,
          idempotencyKey,
        });
      },
    },

    domains: {
      list(orgId: string): Promise<DataList<OrgDomain> & { object: 'list' }> {
        return request({ method: 'GET', path: `/v1/organizations/${enc(orgId)}/domains` });
      },
      create(
        orgId: string,
        body: { domain: string; auto_join?: boolean; default_role_id?: string | null },
        idempotencyKey?: string,
      ): Promise<OrgDomain> {
        return request({
          method: 'POST',
          path: `/v1/organizations/${enc(orgId)}/domains`,
          body,
          idempotencyKey,
        });
      },
      /** Check now. No body = the DNS TXT check; `well_known` fetches the file; `email` takes the emailed code. */
      verify(
        orgId: string,
        domainId: string,
        body?: { method?: OrgDomainVerificationMethod; code?: string },
      ): Promise<OrgDomain & { verified: boolean }> {
        return request({
          method: 'POST',
          path: `/v1/organizations/${enc(orgId)}/domains/${enc(domainId)}/verify`,
          ...(body ? { body } : {}),
        });
      },
      /** Email a 6-digit code to admin@ (or another administrative mailbox) at the domain, via your own email provider. */
      sendVerificationEmail(
        orgId: string,
        domainId: string,
        body: { address?: 'admin' | 'administrator' | 'hostmaster' | 'postmaster' | 'webmaster' } = {},
      ): Promise<OrgDomain & { sent_to: string }> {
        return request({
          method: 'POST',
          path: `/v1/organizations/${enc(orgId)}/domains/${enc(domainId)}/verification_email`,
          body,
        });
      },
      delete(
        orgId: string,
        domainId: string,
      ): Promise<{ object: 'org_domain'; id: string; deleted: true }> {
        return request({
          method: 'DELETE',
          path: `/v1/organizations/${enc(orgId)}/domains/${enc(domainId)}`,
        });
      },
    },

    /** The organization's settings document, validated against `organizationSettingsSchema`. */
    settings: {
      /** An empty document at version 0 when nothing is set. */
      get(orgId: string): Promise<OrganizationSettings> {
        return request({ method: 'GET', path: `/v1/organizations/${enc(orgId)}/settings` });
      },
      /** Replace the whole document. A schema mismatch is a 422 `SETTINGS_INVALID`. */
      replace(
        orgId: string,
        values: Record<string, unknown>,
        idempotencyKey?: string,
      ): Promise<OrganizationSettings> {
        return request({
          method: 'PUT',
          path: `/v1/organizations/${enc(orgId)}/settings`,
          body: { values },
          idempotencyKey,
        });
      },
      /**
       * Merge a partial object (RFC 7396 shallow merge): a key set to `null` is
       * removed, any other value overwrites, untouched keys are kept.
       */
      update(
        orgId: string,
        values: Record<string, unknown>,
        idempotencyKey?: string,
      ): Promise<OrganizationSettings> {
        return request({
          method: 'PATCH',
          path: `/v1/organizations/${enc(orgId)}/settings`,
          body: { values },
          idempotencyKey,
        });
      },
    },

    /** Per-organization audit stream destinations (only that org's events are forwarded). */
    auditStreams: {
      list(orgId: string): Promise<ListPage<OrganizationAuditStream>> {
        return request({ method: 'GET', path: `/v1/organizations/${enc(orgId)}/audit_streams` });
      },
      create(
        orgId: string,
        body: CreateOrganizationAuditStreamBody,
        idempotencyKey?: string,
      ): Promise<OrganizationAuditStream> {
        return request({
          method: 'POST',
          path: `/v1/organizations/${enc(orgId)}/audit_streams`,
          body,
          idempotencyKey,
        });
      },
      delete(
        orgId: string,
        streamId: string,
      ): Promise<{ object: 'org_audit_stream'; id: string; deleted: true }> {
        return request({
          method: 'DELETE',
          path: `/v1/organizations/${enc(orgId)}/audit_streams/${enc(streamId)}`,
        });
      },
    },

    /**
     * The organization's own webhook endpoints. They receive only that
     * organization's events and are hidden from the instance's endpoint list;
     * the org's admins manage the same endpoints from the app.
     */
    webhookEndpoints: {
      list(orgId: string): Promise<ListPage<WebhookEndpoint>> {
        return request({ method: 'GET', path: `/v1/organizations/${enc(orgId)}/webhook_endpoints` });
      },
      get(orgId: string, endpointId: string): Promise<WebhookEndpoint> {
        return request({ method: 'GET', path: `/v1/organizations/${enc(orgId)}/webhook_endpoints/${enc(endpointId)}` });
      },
      /** The signing secret is in this response only. */
      create(
        orgId: string,
        body: OrganizationWebhookEndpointBody & { url: string },
        idempotencyKey?: string,
      ): Promise<WebhookEndpointWithSecret> {
        return request({ method: 'POST', path: `/v1/organizations/${enc(orgId)}/webhook_endpoints`, body, idempotencyKey });
      },
      update(orgId: string, endpointId: string, body: OrganizationWebhookEndpointBody): Promise<WebhookEndpoint> {
        return request({
          method: 'PATCH',
          path: `/v1/organizations/${enc(orgId)}/webhook_endpoints/${enc(endpointId)}`,
          body,
        });
      },
      delete(orgId: string, endpointId: string): Promise<{ object: 'webhook_endpoint'; id: string; deleted: true }> {
        return request({
          method: 'DELETE',
          path: `/v1/organizations/${enc(orgId)}/webhook_endpoints/${enc(endpointId)}`,
        });
      },
      /** Returns the new secret once; the previous one keeps signing for 24 hours. */
      rotateSecret(
        orgId: string,
        endpointId: string,
      ): Promise<{ object: 'webhook_secret'; secret: string; overlap_seconds: number; previous_secret_expires_at: number | null }> {
        return request({
          method: 'POST',
          path: `/v1/organizations/${enc(orgId)}/webhook_endpoints/${enc(endpointId)}/rotate_secret`,
        });
      },
      deliveries(orgId: string, endpointId: string, query: Record<string, string | number | undefined> = {}): Promise<ListPage<WebhookDelivery>> {
        return request({
          method: 'GET',
          path: `/v1/organizations/${enc(orgId)}/webhook_endpoints/${enc(endpointId)}/deliveries`,
          query,
        });
      },
      /** Re-show the signing secret (audited). */
      revealSecret(orgId: string, endpointId: string): Promise<{ object: 'webhook_secret'; secret: string }> {
        return request({ method: 'POST', path: `/v1/organizations/${enc(orgId)}/webhook_endpoints/${enc(endpointId)}/reveal_secret` });
      },
      /** Send a synthetic `webhook.test` to this endpoint alone; `wait: '10s'` returns the attempt inline. */
      test(orgId: string, endpointId: string, opts: { wait?: string } = {}): Promise<WebhookTestResult | WebhookDeliveryQueued> {
        return request({ method: 'POST', path: `/v1/organizations/${enc(orgId)}/webhook_endpoints/${enc(endpointId)}/test`, query: opts });
      },
      /** Re-send one delivery's event as a new attempt. */
      redeliver(orgId: string, endpointId: string, deliveryId: string): Promise<WebhookDeliveryQueued> {
        return request({ method: 'POST', path: `/v1/organizations/${enc(orgId)}/webhook_endpoints/${enc(endpointId)}/deliveries/${enc(deliveryId)}/redeliver` });
      },
      /** Re-send every event of this organization since `since` that the endpoint subscribes to and has not received. */
      replay(orgId: string, endpointId: string, body: WebhookWindow & { since: number | string; event_type?: string }): Promise<WebhookBulkResult> {
        return request({ method: 'POST', path: `/v1/organizations/${enc(orgId)}/webhook_endpoints/${enc(endpointId)}/replay`, body });
      },
    },

    /** The organization's hosted-page branding overlay. */
    branding: {
      get(orgId: string): Promise<OrganizationBranding> {
        return request({ method: 'GET', path: `/v1/organizations/${enc(orgId)}/branding` });
      },
      /** Partial merge: provided fields override, `null` clears back to the instance brand. */
      update(orgId: string, body: UpdateOrganizationBrandingBody): Promise<OrganizationBranding> {
        return request({ method: 'PUT', path: `/v1/organizations/${enc(orgId)}/branding`, body });
      },
    },

    /** The organization's end-user (reader) pool — external users, not staff members. */
    endUsers: {
      list(
        orgId: string,
        params: ListOrganizationEndUsersParams = {},
      ): Promise<CursorPage<OrganizationEndUser> & { object: 'list' }> {
        return request({
          method: 'GET',
          path: `/v1/organizations/${enc(orgId)}/end_users`,
          query: { ...params },
        });
      },
      /** Attach an instance user as a reader. Idempotent per (org, user); grants no org role. */
      add(
        orgId: string,
        body: AddOrganizationEndUserBody,
        idempotencyKey?: string,
      ): Promise<OrganizationEndUser> {
        return request({
          method: 'POST',
          path: `/v1/organizations/${enc(orgId)}/end_users`,
          body,
          idempotencyKey,
        });
      },
      /** Approve (`active`), gate (`pending`) or block a reader. */
      update(
        orgId: string,
        userId: string,
        body: { status: OrganizationEndUserStatus },
      ): Promise<OrganizationEndUser> {
        return request({
          method: 'PATCH',
          path: `/v1/organizations/${enc(orgId)}/end_users/${enc(userId)}`,
          body,
        });
      },
      remove(
        orgId: string,
        userId: string,
      ): Promise<{ object: 'organization_end_user'; id: string; deleted: true }> {
        return request({
          method: 'DELETE',
          path: `/v1/organizations/${enc(orgId)}/end_users/${enc(userId)}`,
        });
      },
    },

    /** The host(s) whose sign-ups join the organization's end-user pool. */
    readerDomain: {
      list(orgId: string): Promise<ListPage<OrganizationReaderDomain>> {
        return request({ method: 'GET', path: `/v1/organizations/${enc(orgId)}/reader_domain` });
      },
      /** Bind a host; returns the CNAME to publish. Verify with `domains.verify(id)`. */
      create(
        orgId: string,
        body: { host: string },
        idempotencyKey?: string,
      ): Promise<OrganizationReaderDomainCreated> {
        return request({
          method: 'POST',
          path: `/v1/organizations/${enc(orgId)}/reader_domain`,
          body,
          idempotencyKey,
        });
      },
      delete(orgId: string): Promise<{ object: 'custom_domain'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/organizations/${enc(orgId)}/reader_domain` });
      },
    },

    /** Directory-group → role grants that augment members' permissions. */
    groupRoles: {
      grant(
        orgId: string,
        groupId: string,
        roleId: string,
      ): Promise<{
        object: 'group_role_grant';
        organization_id: string;
        group_id: string;
        role_id: string;
        granted: true;
      }> {
        return request({
          method: 'PUT',
          path: `/v1/organizations/${enc(orgId)}/groups/${enc(groupId)}/roles/${enc(roleId)}`,
        });
      },
      revoke(
        orgId: string,
        groupId: string,
        roleId: string,
      ): Promise<{
        object: 'group_role_grant';
        organization_id: string;
        group_id: string;
        role_id: string;
        deleted: boolean;
      }> {
        return request({
          method: 'DELETE',
          path: `/v1/organizations/${enc(orgId)}/groups/${enc(groupId)}/roles/${enc(roleId)}`,
        });
      },
    },
  };
}

import { enc, type RequestFn } from './request';
import type { CursorPage, CursorParams, DataList, DeletedObject, ListPage, Metadata } from './types';

export interface Organization {
  object: 'organization';
  id: string;
  name: string;
  slug: string;
  image_url: string | null;
  public_metadata: Metadata;
  max_allowed_memberships: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface OrganizationMembership {
  object: 'organization_membership';
  id: string;
  organization_id: string;
  user_id: string;
  role: string;
  created_at: number;
}

export interface OrganizationInvitation {
  object: 'organization_invitation';
  id: string;
  organization_id: string;
  email: string;
  role: string;
  status: string;
  inviter_user_id: string;
  expires_at: number;
  created_at: number;
}

export interface OrgDomain {
  object: 'org_domain';
  id: string;
  organization_id: string;
  domain: string;
  status: string;
  auto_join: boolean;
  default_role_id: string | null;
  verification: {
    record_name: string;
    record_type: 'TXT';
    record_value: string;
  };
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

/**
 * The organization's security policy overrides. Keys are camelCase on this
 * route, and only overrides that are set appear. Unknown keys from a newer API
 * version are kept in the index signature.
 */
export interface OrganizationPolicySettings {
  requireMfa?: boolean;
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
  endUserPool?: OrganizationEndUserPoolPolicy;
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
  format: string;
  active: boolean;
  has_secret: boolean;
  created_at: number;
}

export interface CreateOrganizationAuditStreamBody {
  /** Public HTTPS endpoint of the SIEM/collector. */
  url: string;
  /** Shared HMAC-SHA256 signing secret (min 16 chars). Write-only. */
  secret: string;
  /** Shape hint for the collector. Default `json`. */
  format?: string;
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
  slug: string;
  created_by: string;
  max_allowed_memberships?: number;
}

export interface UpdateOrganizationBody {
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
  ssoRequired?: boolean | null;
  sessionIdleOverrideMs?: number | null;
  /** Restrict member sign-in methods; `null` clears (all methods). Unknown method → 400. */
  allowedSignInMethods?: string[] | null;
  /** CIDR allow-list for member sign-in; `null` clears. A bad CIDR → 400. */
  ipAllowlist?: string[] | null;
  /** Absolute session lifetime cap in seconds (300 … 7776000); `null` clears. */
  maxSessionAgeSeconds?: number | null;
  /** Retired: only `null` is accepted, to clear a stored value. Use `entitlementOverrides.create`. */
  entitlementPlan?: null;
  /** Retired: only `null` is accepted, to clear a stored value. */
  entitlementOverrides?: null;
  endUserPool?: OrganizationEndUserPoolPolicy | null;
  [key: string]: unknown;
}

export function organizationsResource(request: RequestFn) {
  return {
    list(params: CursorParams = {}): Promise<CursorPage<Organization>> {
      return request({ method: 'GET', path: '/v1/organizations', query: { ...params } });
    },
    get(id: string): Promise<Organization> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(id)}` });
    },
    create(body: CreateOrganizationBody, idempotencyKey?: string): Promise<Organization> {
      return request({ method: 'POST', path: '/v1/organizations', body, idempotencyKey });
    },
    update(id: string, body: UpdateOrganizationBody): Promise<Organization> {
      return request({ method: 'PATCH', path: `/v1/organizations/${enc(id)}`, body });
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

    memberships: {
      list(orgId: string): Promise<{ data: OrganizationMembership[]; has_more: boolean }> {
        return request({ method: 'GET', path: `/v1/organizations/${enc(orgId)}/memberships` });
      },
      add(
        orgId: string,
        body: { user_id: string; role?: string },
        idempotencyKey?: string,
      ): Promise<{
        object: 'organization_membership';
        organization_id: string;
        user_id: string;
        role: string;
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
        body: { role: string },
      ): Promise<{ object: 'organization_membership'; role: string; updated: true }> {
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
      list(orgId: string): Promise<ListPage<OrganizationInvitation>> {
        return request({ method: 'GET', path: `/v1/organizations/${enc(orgId)}/invitations` });
      },
      create(
        orgId: string,
        body: { email: string; role: string; inviter_user_id: string },
        idempotencyKey?: string,
      ): Promise<{
        object: 'organization_invitation';
        id: string;
        organization_id: string;
        email: string;
        status: string;
        expires_at: number;
      }> {
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
      verify(orgId: string, domainId: string): Promise<OrgDomain & { verified: boolean }> {
        return request({
          method: 'POST',
          path: `/v1/organizations/${enc(orgId)}/domains/${enc(domainId)}/verify`,
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

import { enc, type RequestFn } from './request';
import type { CursorPage, CursorParams, ListPage, Metadata } from './types';

/**
 * §9.3 / §P1-7 MACHINE identities + the device registry.
 *
 * A machine is a first-class non-human principal with its own secret (`mk_…`),
 * distinct from an instance API key. §P1-7 layers a DEVICE half on top: a machine
 * can carry a registered public KEY, a lifecycle `status`, device `metadata`, and
 * optional org/owner ownership. This namespace is the `sk_`-authenticated
 * MANAGEMENT surface (list/filter, create, rename, metadata, approve, revoke, key
 * rotation, delete) plus enrolment-token management and M2M-token verification.
 *
 * The device self-serve half (`/v1/machines/enroll`, `/challenge`, `/token`) is a
 * PUBLIC, credential-presented surface a bootstrapping device calls with no `sk_`,
 * so it is deliberately NOT part of this secret-key client.
 */

/** A machine's lifecycle state. `pending` awaits approval; `revoked` is terminal. */
export type MachineStatus = 'pending' | 'active' | 'revoked';

/** What a machine's tokens are bound to: a DPoP key, a client certificate, either, or nothing (a plain bearer token). */
export type MachineTokenBinding = 'none' | 'dpop' | 'mtls' | 'any';

/** Device metadata bag (hostname/os/app_version/last_seen_at/…). */
export type MachineMetadata = Record<string, unknown>;

/**
 * A named machine identity. `secret_hash` is never present on any machine surface
 * — only a hash is stored, so the `mk_` secret is shown exactly once at
 * create/rotate (see {@link MachineWithSecret}).
 */
export interface Machine {
  object: 'machine';
  id: string;
  name: string;
  organization_id: string | null;
  status: MachineStatus;
  /** JWK thumbprint of the registered device key, or null for a secret-only machine. */
  public_key_jkt: string | null;
  /** The sender constraint every token this machine mints must carry. A proof or certificate sent under `none` still binds the token. */
  token_binding?: MachineTokenBinding;
  metadata: MachineMetadata;
  enrolled_at: number | null;
  /** When the machine last minted a token (epoch ms); null = never. */
  last_token_at?: number | null;
  /** Why a revoked machine ended: `revoked_by_api`, `revoked_by_user`, `owner_signed_out`, `superseded`, `delegation_ended`. Null while not revoked. */
  revoked_reason?: string | null;
  /** Who revoked it (`api_key`, `user`, `system`). Null while not revoked. */
  revoked_by?: EndActor | null;
  /** Epoch ms the machine was revoked. Null while not revoked. */
  ended_at?: number | null;
  /** `sign_out_everywhere`: revoked when its owner signs out everywhere. */
  dies_with?: 'sign_out_everywhere' | null;
  created_at: number;
  updated_at: number;
}

/** Who ended a credential. */
export interface EndActor {
  type: string;
  id: string | null;
}

/** One entry of the machine deny feed: a machine revoked, or a machine grant ended. */
export type RevokedMachineRef =
  | { object: 'machine'; id: string; revoked_at: number; revoked_reason?: string | null; revoked_by?: EndActor | null; owner_user_id?: string | null; organization_id?: string | null }
  | { object: 'machine_grant'; id: string; machine_id: string; audience: string; revoked_at: number; revoked_reason?: string | null; revoked_by?: EndActor | null };

export interface ListRevokedMachinesQuery {
  /** An ISO-8601 instant, epoch-millis, or a `next_cursor` from a previous page. */
  since?: string;
  limit?: number;
}

/** The create / rotate_secret response: the machine plus its `mk_` secret, shown once. */
export interface MachineWithSecret extends Machine {
  secret: string;
}

export interface CreateMachineBody {
  name: string;
  /** Round-7: the user who owns this machine identity. */
  owner_user_id?: string;
  /** Round-7: bind the machine to an organization at creation. */
  organization_id?: string;
  /** Round-7: free-form data bag stored on the machine. */
  data?: Metadata;
  /** `sign_out_everywhere`: revoke the machine when its owner signs out everywhere. Needs `owner_user_id`. */
  dies_with?: 'sign_out_everywhere';
  /** Device metadata (hostname/os/app_version/…). */
  metadata?: MachineMetadata;
}

export interface ListMachinesQuery extends CursorParams {
  status?: MachineStatus;
  /** Filter by the device's reported hostname. */
  hostname?: string;
  /** Round-7: only machines owned by this user. */
  owner_user_id?: string;
  /** Round-7: only machines belonging to this organization. */
  organization_id?: string;
  /** Round-7: a JSON-encoded metadata match filter. */
  metadata?: string;
}

/**
 * The machine list page. The envelope is `{ object: 'list', data }`; §P1-7's
 * cursor fields (`has_more`/`next_cursor`) are present on the round-7 surface and
 * optional here so the type is honest against both.
 */
export interface MachineListPage {
  object: 'list';
  data: Machine[];
  has_more?: boolean;
  next_cursor?: string | null;
}

/**
 * A machine's org membership, membership-shaped like
 * `GET /v1/users/:id/organization_memberships`. A machine belongs to at most one
 * org today, so the list holds 0 or 1 entries; `role` is always null (a machine
 * holds no org role).
 */
export interface MachineOrganizationMembership {
  object: 'organization_membership';
  organization_id: string;
  organization_slug: string;
  /** The role it holds as a member. Null when the org owns the machine but has not made it a member. */
  role: string | null;
  plan: string | null;
  joined_at: number;
}

export interface MachineOrganizationMembershipPage {
  object: 'list';
  data: MachineOrganizationMembership[];
  has_more: boolean;
  next_cursor: string | null;
}

/** An enrolment token — a short-lived credential a device presents to `/enroll`. */
export interface MachineEnrolmentToken {
  object: 'machine_enrolment_token';
  id: string;
  organization_id: string | null;
  max_uses: number;
  uses: number;
  expires_at: number;
  requires_approval: boolean;
  /** `user_code` for a short single-use code, else `token`. */
  format?: 'token' | 'user_code';
  created_at: number;
}

/** The create response: the enrolment token plus its secret, shown once: `token` (a `met_` secret), or `user_code` for `format: 'user_code'`. */
export interface MachineEnrolmentTokenWithSecret extends MachineEnrolmentToken {
  token?: string;
  user_code?: string;
}

export interface CreateEnrolmentTokenBody {
  /** `user_code` mints a short single-use code (8 letters, 5 to 15 minutes) a person types on the device. Default `token`. */
  format?: 'token' | 'user_code';
  /** Bind machines enrolled with this token to an organization. */
  organization_id?: string;
  /** Round-7: the user who will own machines enrolled with this token. */
  owner_user_id?: string;
  /** Round-7: free-form data copied onto each enrolled machine. */
  data?: Metadata;
  /** Round-7: restrict the token to a single enrolment session. */
  single_session?: boolean;
  /** Round-7: the maximum number of machines that may enrol with this token. */
  max_machines?: number;
  /** How many times the token may be redeemed (defaults to 1 server-side). */
  max_uses?: number;
  /** Token lifetime; defaults to 3600s, capped at one year. */
  expires_in_seconds?: number;
  /** When true, enrolled machines start `pending` and must be approved. */
  requires_approval?: boolean;
}

/**
 * The verify verdict for an M2M credential (Clerk `verifyM2MToken`): resolve a
 * presented machine secret to its machine. An unknown, rotated, or revoked secret
 * all resolve to the SAME `{ valid: false }`, so a caller cannot probe which
 * machines exist.
 */
export type M2mTokenVerification =
  | { object: 'm2m_verification'; valid: false }
  | {
      object: 'm2m_verification';
      valid: true;
      machine_id: string;
      name: string;
      /** Machine JWT only: the resource server it is bound to. */
      audience?: string | null;
      /** Machine JWT only: the scopes it carries. */
      scopes?: string[];
      /** Machine JWT only: its organization context. */
      organization_id?: string | null;
      org_role?: string | null;
      org_permissions?: string[];
      /** Machine JWT only: when it expires (epoch ms). */
      expires_at?: number | null;
      /** What the machine holds now. */
      grants: Array<{ resource_server_id: string; audience: string; scopes: string[] }>;
      organization_memberships: Array<{ organization_id: string; role: string }>;
    };

/** A machine's authorization for a resource server: it may obtain tokens for that API, up to `scopes`. */
export interface MachineGrant {
  object: 'machine_grant';
  id: string;
  machine_id: string;
  resource_server_id: string;
  scopes: string[];
  /** Limits carried in the `constraints` claim of the machine's tokens for this resource server. */
  constraints: Record<string, unknown> | null;
  /** Epoch ms after which the grant mints no tokens, or null. */
  expires_at: number | null;
  expired: boolean;
  /** Epoch ms the grant was ended (it stays as a record for 90 days); null while live. */
  revoked_at?: number | null;
  ended_at?: number | null;
  /** Why it ended: `revoked_by_api` or `owner_signed_out`. */
  revoked_reason?: string | null;
  revoked_by?: EndActor | null;
  dies_with?: 'sign_out_everywhere' | null;
  created_at: number;
  updated_at: number;
}

export interface UpdateMachineGrantBody {
  scopes?: string[];
  scope_presets?: string[];
  /** Replaces the constraints; null clears them. */
  constraints?: Record<string, unknown> | null;
  expires_in_seconds?: number;
  /** Epoch ms or ISO 8601; null removes the expiry. */
  expires_at?: number | string | null;
}

export interface CreateMachineGrantBody {
  /** `sign_out_everywhere`; needs a machine with an owner. */
  dies_with?: 'sign_out_everywhere';
  resource_server_id: string;
  /** Scopes the machine may request. Each must be defined on the resource server. */
  scopes?: string[];
  /** Names from the resource server's `scope_presets`, unioned with `scopes`. The expanded list is stored. */
  scope_presets?: string[];
  /** A JSON object of at most 2 KB, carried as the `constraints` claim of the machine's tokens. */
  constraints?: Record<string, unknown>;
  /** The grant stops minting after this many seconds (60 to 31536000). */
  expires_in_seconds?: number;
  /** Or at this time (epoch ms or ISO 8601). Not both. */
  expires_at?: number | string;
}

/** A machine as an organization member with a role. Holds no seat. */
export interface MachineMembership {
  object: 'machine_membership';
  id: string;
  organization_id: string;
  machine_id: string;
  /** The organization role key. */
  role: string;
  role_id: string;
  created_at: number;
  updated_at: number;
}

export function machinesResource(request: RequestFn) {
  return {
    /** List + filter machines (§P1-7 device-registry query). */
    list(query: ListMachinesQuery = {}): Promise<MachineListPage> {
      return request({ method: 'GET', path: '/v1/machines', query: { ...query } });
    },
    /** Create a machine. The `mk_` secret is returned once, here. */
    create(body: CreateMachineBody, idempotencyKey?: string): Promise<MachineWithSecret> {
      return request({ method: 'POST', path: '/v1/machines', body, idempotencyKey });
    },
    get(id: string): Promise<Machine> {
      return request({ method: 'GET', path: `/v1/machines/${enc(id)}` });
    },
    /** Rename a machine (`PATCH /v1/machines/:id`). */
    rename(id: string, name: string): Promise<Machine> {
      return request({ method: 'PATCH', path: `/v1/machines/${enc(id)}`, body: { name } });
    },
    /**
     * Set the sender constraint the machine's tokens must carry (`PATCH /v1/machines/:id`). Needs a
     * recent MFA sign-in, and is audited.
     */
    setTokenBinding(id: string, tokenBinding: MachineTokenBinding): Promise<Machine> {
      return request({ method: 'PATCH', path: `/v1/machines/${enc(id)}`, body: { token_binding: tokenBinding } });
    },
    /** Merge device metadata (`PATCH /v1/machines/:id/metadata`). */
    patchMetadata(id: string, metadata: MachineMetadata): Promise<Machine> {
      return request({ method: 'PATCH', path: `/v1/machines/${enc(id)}/metadata`, body: { metadata } });
    },
    /** Approve a `pending` device (→ `active`). */
    approve(id: string): Promise<Machine> {
      return request({ method: 'POST', path: `/v1/machines/${enc(id)}/approve` });
    },
    /** Revoke a machine (→ `revoked`). The record is kept; its key stops minting at once. */
    revoke(id: string): Promise<Machine> {
      return request({ method: 'POST', path: `/v1/machines/${enc(id)}/revoke` });
    },
    /** Rotate the `mk_` secret. The new secret is shown once; the old stops working. */
    rotateSecret(id: string): Promise<MachineWithSecret> {
      return request({ method: 'POST', path: `/v1/machines/${enc(id)}/rotate_secret` });
    },
    /** Rotate the registered device keypair by supplying the new public key PEM. */
    rotateKey(id: string, publicKeyPem: string): Promise<Machine> {
      return request({
        method: 'POST',
        path: `/v1/machines/${enc(id)}/rotate_key`,
        body: { public_key_pem: publicKeyPem },
      });
    },
    /** Delete a machine outright (distinct from {@link revoke}, which keeps the record). */
    delete(id: string): Promise<{ object: 'machine'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/machines/${enc(id)}` });
    },
    /** The org that owns the machine and every org it is a member of. */
    organizationMemberships(id: string): Promise<MachineOrganizationMembershipPage> {
      return request({ method: 'GET', path: `/v1/machines/${enc(id)}/organization_memberships` });
    },

    /** The resource servers this machine may obtain tokens for (`GET /v1/machines/:id/grants`). */
    listGrants(id: string, query: { include_ended?: boolean } = {}): Promise<ListPage<MachineGrant>> {
      return request({ method: 'GET', path: `/v1/machines/${enc(id)}/grants`, query: { ...(query.include_ended ? { include_ended: 'true' } : {}) } });
    },
    /**
     * The machine deny feed: machines revoked and machine grants ended since a cursor, oldest first. Feed it to
     * `createMachineDenyList().sync()` (or let `createRevocationMirror` keep it current from the revocation stream).
     */
    listRevoked(query: ListRevokedMachinesQuery = {}): Promise<CursorPage<RevokedMachineRef>> {
      return request({ method: 'GET', path: '/v1/machines/revoked', query: { ...query } });
    },
    /** Authorize the machine for a resource server and its scopes. Takes effect from its next token. */
    createGrant(id: string, body: CreateMachineGrantBody): Promise<MachineGrant> {
      return request({ method: 'POST', path: `/v1/machines/${enc(id)}/grants`, body });
    },
    /**
     * Change a grant in place. Tokens minted earlier keep the constraints they carry until they expire;
     * counter limits in `constraints.counters` apply at once.
     */
    updateGrant(id: string, grantId: string, body: UpdateMachineGrantBody): Promise<MachineGrant> {
      return request({ method: 'PATCH', path: `/v1/machines/${enc(id)}/grants/${enc(grantId)}`, body });
    },
    /** Revoke a grant. A token already issued lasts until it expires. */
    deleteGrant(id: string, grantId: string): Promise<{ object: 'machine_grant'; id: string; deleted: true; revoked_at?: number; revoked_reason?: string }> {
      return request({ method: 'DELETE', path: `/v1/machines/${enc(id)}/grants/${enc(grantId)}` });
    },

    /** The machines that are members of an organization. Paginated with `limit` + `starting_after`. */
    listOrganizationMembers(
      organizationId: string,
      query: { limit?: number; starting_after?: string } = {},
    ): Promise<ListPage<MachineMembership>> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(organizationId)}/machine_memberships`, query: { ...query } });
    },
    /** Make a machine a member of an organization. `role` defaults to `org:member`. */
    addToOrganization(
      organizationId: string,
      body: { machine_id: string; role?: string },
      idempotencyKey?: string,
    ): Promise<MachineMembership> {
      return request({ method: 'POST', path: `/v1/organizations/${enc(organizationId)}/machine_memberships`, body, idempotencyKey });
    },
    /** Change a machine's role in an organization. New tokens carry the new role. */
    updateOrganizationRole(organizationId: string, machineId: string, role: string): Promise<MachineMembership> {
      return request({
        method: 'PATCH',
        path: `/v1/organizations/${enc(organizationId)}/machine_memberships/${enc(machineId)}`,
        body: { role },
      });
    },
    /** Remove a machine from an organization. */
    removeFromOrganization(
      organizationId: string,
      machineId: string,
    ): Promise<{ object: 'machine_membership'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/organizations/${enc(organizationId)}/machine_memberships/${enc(machineId)}` });
    },

    /** Mint an enrolment token. The `met_` secret is returned once, here. */
    createEnrolmentToken(
      body: CreateEnrolmentTokenBody = {},
      idempotencyKey?: string,
    ): Promise<MachineEnrolmentTokenWithSecret> {
      return request({ method: 'POST', path: '/v1/machine_enrolment_tokens', body, idempotencyKey });
    },
    listEnrolmentTokens(): Promise<ListPage<MachineEnrolmentToken>> {
      return request({ method: 'GET', path: '/v1/machine_enrolment_tokens' });
    },
    deleteEnrolmentToken(
      id: string,
    ): Promise<{ object: 'machine_enrolment_token'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/machine_enrolment_tokens/${enc(id)}` });
    },

    /**
     * Verify a presented M2M credential (`POST /v1/m2m_tokens/verify`). Resolve a
     * machine secret or machine JWT to its machine and what it holds; every negative
     * resolves to `{ valid: false }`. To check a machine JWT with no call to Atlas, use
     * `createAccessTokenVerifier` with `acceptMachineTokens`.
     */
    verifyM2mToken(token: string): Promise<M2mTokenVerification> {
      return request({ method: 'POST', path: '/v1/m2m_tokens/verify', body: { token } });
    },
  };
}

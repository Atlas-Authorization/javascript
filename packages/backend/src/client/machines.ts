import { enc, type RequestFn } from './request';
import type { CursorParams, ListPage, Metadata } from './types';

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
  metadata: MachineMetadata;
  enrolled_at: number | null;
  created_at: number;
  updated_at: number;
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
  role: null;
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
  created_at: number;
}

/** The create response: the enrolment token plus its `met_` secret, shown once. */
export interface MachineEnrolmentTokenWithSecret extends MachineEnrolmentToken {
  token: string;
}

export interface CreateEnrolmentTokenBody {
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
  | { object: 'm2m_verification'; valid: true; machine_id: string; name: string };

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
    /** The machine's org memberships (0 or 1 entry). */
    organizationMemberships(id: string): Promise<MachineOrganizationMembershipPage> {
      return request({ method: 'GET', path: `/v1/machines/${enc(id)}/organization_memberships` });
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
     * machine secret to its machine; every negative resolves to `{ valid: false }`.
     */
    verifyM2mToken(token: string): Promise<M2mTokenVerification> {
      return request({ method: 'POST', path: '/v1/m2m_tokens/verify', body: { token } });
    },
  };
}

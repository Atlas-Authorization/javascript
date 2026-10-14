/**
 * BAPI resource shapes + list envelopes.
 *
 * COPIED verbatim from `@atlasauth/backend` (`src/client/*`). That package ships
 * the HTTP client factories; only the pure snake_case wire types are mirrored
 * here. The wire is snake_case JSON and these types mirror it exactly (no
 * camelCase translation), because the SDK's job is to type the BAPI, not to
 * invent a second dialect a reader would then have to reconcile against the docs.
 */

// --- Envelopes (client/types.ts) -------------------------------------------

/** A free-form metadata bag. The BAPI stores arbitrary JSON objects here. */
export type Metadata = Record<string, unknown>;

/**
 * The `GET /v1/users`-style cursor page: no total, a boolean `has_more`, and an
 * opaque `next_cursor` to pass back as `starting_after`.
 */
export interface CursorPage<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

/** A bare `{ data }` list with no pagination metadata. */
export interface DataList<T> {
  data: T[];
}

/** Common cursor-pagination params. */
export interface CursorParams {
  /** Page size. Server clamps to its own maximum. */
  limit?: number;
  /** Opaque cursor: the id after which to continue (from `next_cursor`). */
  starting_after?: string;
}

/** A minimal deletion acknowledgement several mutation routes return. */
export interface DeletedObject {
  object: string;
  id: string;
  deleted: true;
}

// --- User + EmailAddress (client/users.ts) ---------------------------------

/** A user as the BAPI serves it. `private_metadata` is never returned. */
export interface User {
  object: 'user';
  id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
  public_metadata: Metadata;
  mfa_enabled: boolean;
  banned: boolean;
  locked: boolean;
  /** Epoch milliseconds, or null if never signed in. */
  last_sign_in_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface EmailAddress {
  object: 'email_address';
  id: string;
  email_address: string;
  verified: boolean;
  primary: boolean;
  created_at: number;
}

// --- Session (client/sessions.ts) ------------------------------------------

export interface Session {
  object: 'session';
  id: string;
  user_id: string;
  status: string;
  last_active_organization_id: string | null;
  impersonated_by: string | null;
  last_active_at: number;
  expire_at: number;
  abandon_at: number;
  created_at: number;
}

// --- Organization + OrganizationMembership (client/organizations.ts) -------

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

// --- Invitation (client/invitations.ts) ------------------------------------

export interface Invitation {
  object: 'invitation';
  id: string;
  email_address: string;
  status: string;
  public_metadata: Metadata;
  expires_at: number;
  accepted_at: number | null;
  created_at: number;
}

// --- ApiKey + ApiKeyVerification (client/api-keys.ts) ----------------------

export type ApiKeySubjectType = 'user' | 'organization';

/**
 * An end-user API key — Clerk `api_keys` parity. A tenant mints these for ITS OWN
 * users/organizations and later asks Atlas to verify one a subject presented.
 * Only a hash is stored, so the `ak_` secret is shown exactly once at mint; a
 * read reports only the `prefix`.
 */
export interface ApiKey {
  object: 'api_key';
  id: string;
  subject_type: ApiKeySubjectType;
  subject_id: string;
  name: string | null;
  /** Enough to tell two keys apart in a listing; not enough to use one. */
  prefix: string;
  claims: Record<string, unknown>;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

/**
 * The verify verdict. Every negative — unknown, malformed, revoked, expired, or a
 * key whose subject was since deleted — resolves to the SAME `{ valid: false }`,
 * so a caller learns nothing about which keys exist.
 */
export type ApiKeyVerification =
  | { object: 'api_key_verification'; valid: false }
  | {
      object: 'api_key_verification';
      valid: true;
      id: string;
      subject_type: ApiKeySubjectType;
      subject_id: string;
      claims: Record<string, unknown>;
      last_used_at: number | null;
    };

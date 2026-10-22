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
  /**
   * Strictly increases with every change to the user; user webhook payloads
   * carry the same value. Apply an update only if its version is higher than
   * the one you hold. (Absent from servers older than this field.)
   */
  version?: number;
  /**
   * How the user arrived through a referral program, when the instance has
   * referral attribution on and the user was reported to the referral
   * platform (`status` says how it stands: `pending` until the platform
   * answers). Null when the user was never reported. (Absent from servers
   * older than this field.)
   */
  referral?: UserReferral | null;
  /** The user's own referral code, when they are a referrer. */
  referral_code?: string | null;
  /** The user's own referral link, when they are a referrer. */
  referral_link?: string | null;
}

/** Where a user's referral attribution stands. */
export type UserReferralStatus = 'pending' | 'attributed' | 'none' | 'failed' | 'held' | 'flagged';

/** The inbound referral on a user (snake_case, as the BAPI serves it). */
export interface UserReferral {
  /**
   * Where attribution stands: `pending` (the platform has not answered yet),
   * `attributed`, `none` (not referred), `failed`, `held` or `flagged`.
   * Servers before 2026-10-21 sent the platform's own status here; that is
   * now `referral_status`.
   */
  status: UserReferralStatus | string | null;
  /** The referral platform's id for the referring partner. */
  partner_id: string | null;
  /** The referrer as the platform knows them (your external id for that user, or their Atlas id). */
  partner_external_ref?: string | null;
  /** Same as `partner_external_ref`. */
  referrer_external_id: string | null;
  /** The referrer's Atlas user id, when they are a user of this instance. */
  referrer_user_id: string | null;
  /** How the platform matched the referral, e.g. code, click, coupon. */
  matched_via: string | null;
  /** The platform's own status for the referral (e.g. active). */
  referral_status?: string | null;
  /** The platform's reasoning notes for its answer. */
  notes?: string[];
  /** The risk level Atlas assessed at sign-up, when one was. */
  risk_level?: 'low' | 'medium' | 'high' | null;
  /** An admin marked the referral fraudulent. */
  flagged?: boolean;
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

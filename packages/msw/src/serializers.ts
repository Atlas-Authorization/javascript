/**
 * Serialisers that turn the mock store's internal objects into the exact wire
 * shapes Atlas's FAPI and BAPI return. Kept in one place, mirroring the API's
 * own per-resource `present()` closures, so a shape change is a one-line edit.
 *
 * Verbatim references (so the shapes do not drift from the server):
 *   - BAPI user         → apps/api/src/routes/users/context.ts `present`
 *   - FAPI `me` user     → apps/api/src/routes/me/profile.ts `present` (+ extras)
 *   - BAPI organization → apps/api/src/routes/organizations/context.ts `present`
 *   - BAPI session       → apps/api/src/routes/bapi-sessions.ts `present`
 *   - sign_in_attempt    → apps/api/src/modules/signin/signin.service.ts `view`
 *   - sign_up_attempt    → apps/api/src/modules/signup/signup.types.ts `toAttemptView`
 *   - environment        → apps/api/src/routes/fapi-oauth/environment.ts
 */
import type {
  AtlasMock,
  MockAttempt,
  MockOrganization,
  MockSession,
  MockUser,
} from './state';

/** The §9.1 error envelope: `{ errors: [{ code, message, param?, meta?, docs_url }] }`. */
export function errorBody(
  code: string,
  message: string,
  param?: string,
  meta?: Record<string, unknown>,
): { errors: Array<Record<string, unknown>> } {
  const item: Record<string, unknown> = { code, message };
  if (param !== undefined) item.param = param;
  if (meta !== undefined) item.meta = meta;
  item.docs_url = `https://atlasauth.net/errors/${code.toLowerCase()}`;
  return { errors: [item] };
}

/** BAPI user — `private_metadata` is never serialised (§4.2). */
export function presentUser(user: MockUser) {
  return {
    object: 'user' as const,
    id: user.id,
    username: user.username,
    first_name: user.firstName,
    last_name: user.lastName,
    image_url: user.imageUrl,
    email_addresses: user.emails.map((e) => ({
      id: e.id,
      object: 'email_address' as const,
      email_address: e.email,
      verification: { status: e.verified ? 'verified' : 'unverified' },
      verified: e.verified,
      primary: e.id === user.primaryEmailId,
    })),
    primary_email_address_id: user.primaryEmailId,
    primary_email: user.emails.find((e) => e.id === user.primaryEmailId)?.email ?? null,
    external_id: user.externalId,
    password_enabled: user.password != null,
    public_metadata: user.publicMetadata,
    mfa_enabled: user.mfaEnabled,
    is_anonymous: user.isAnonymous,
    banned: user.banned,
    ban_reason: null,
    ban_note: null,
    locked: false,
    deleted_at: user.deletedAt,
    last_sign_in_at: user.lastSignInAt,
    created_at: user.createdAt,
    updated_at: user.updatedAt,
  };
}

/** FAPI `/v1/client/me` user — carries `unsafe_metadata` + connections, never `private_metadata`. */
export function presentMeUser(mock: AtlasMock, user: MockUser) {
  const memberships = mock.memberships.filter((m) => m.userId === user.id);
  return {
    object: 'user' as const,
    id: user.id,
    first_name: user.firstName,
    last_name: user.lastName,
    username: user.username,
    image_url: user.imageUrl,
    locale: user.locale,
    public_metadata: user.publicMetadata,
    unsafe_metadata: user.unsafeMetadata,
    mfa_enabled: user.mfaEnabled,
    has_password: user.password !== null,
    is_anonymous: user.isAnonymous,
    created_at: user.createdAt,
    primary_email_id: user.primaryEmailId,
    email_addresses: user.emails.map((e) => ({
      object: 'email_address' as const,
      id: e.id,
      email_address: e.email,
      verified: e.verified,
      primary: e.id === user.primaryEmailId,
    })),
    external_accounts: [] as unknown[],
    passkeys: [] as unknown[],
    organization_memberships: memberships.map((m) => presentMembership(mock, m.organizationId, m.role)),
  };
}

/** The `organization_membership` shape used in the client boot + me. */
export function presentMembership(mock: AtlasMock, organizationId: string, role: string) {
  const org = mock.findOrganization(organizationId);
  return {
    object: 'organization_membership' as const,
    role,
    organization: org
      ? {
          object: 'organization' as const,
          id: org.id,
          name: org.name,
          slug: org.slug,
          image_url: org.imageUrl,
          public_metadata: org.publicMetadata,
        }
      : null,
  };
}

/** BAPI organization — `private_metadata` is never serialised (§4.4). */
export function presentOrganization(org: MockOrganization) {
  return {
    object: 'organization' as const,
    id: org.id,
    name: org.name,
    slug: org.slug,
    image_url: org.imageUrl,
    parent_organization_id: org.parentOrganizationId,
    public_metadata: org.publicMetadata,
    max_allowed_memberships: org.maxAllowedMemberships,
    created_by: org.createdBy,
    created_at: org.createdAt,
    updated_at: org.updatedAt,
  };
}

/** BAPI session (operator view). */
export function presentSession(session: MockSession) {
  return {
    object: 'session' as const,
    id: session.id,
    user_id: session.userId,
    status: session.status,
    last_active_organization_id: session.activeOrganizationId,
    impersonated_by: session.impersonatedBy,
    last_active_at: session.lastActiveAt,
    expire_at: session.expiresAt,
    abandon_at: session.idleExpiresAt,
    created_at: session.createdAt,
  };
}

/** A sign_in_attempt view. `supported_first_factors` is always the instance's list. */
export function presentSignInAttempt(mock: AtlasMock, attempt: MockAttempt) {
  return {
    id: attempt.id,
    object: 'sign_in_attempt' as const,
    status: attempt.status,
    identifier: attempt.identifier,
    supported_first_factors: mock.instance.firstFactors,
    created_session_id: attempt.sessionId,
    expires_at: attempt.expiresAt,
  };
}

/** A sign_up_attempt view. */
export function presentSignUpAttempt(attempt: MockAttempt) {
  return {
    id: attempt.id,
    object: 'sign_up_attempt' as const,
    status: attempt.status,
    identifier: attempt.identifier,
    created_session_id: attempt.sessionId,
    expires_at: attempt.expiresAt,
  };
}

/** The cursor-paginated list envelope (§9.1): `{ data, has_more, next_cursor }`. */
export function listEnvelope<T>(data: T[], hasMore: boolean, nextCursor: string | null) {
  return { data, has_more: hasMore, next_cursor: nextCursor };
}

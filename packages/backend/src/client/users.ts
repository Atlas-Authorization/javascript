import { enc, type RequestFn } from './request';
import type { CursorPage, CursorParams, DeletedObject, ListPage, Metadata } from './types';

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

export interface UserSession {
  object: 'session';
  id: string;
  user_id: string;
  status: string;
  last_active_at: number;
  expire_at: number;
  abandon_at: number;
  created_at: number;
}

export type ListUsersParams = CursorParams;

export interface CreateUserBody {
  email_address: string;
  password?: string;
  first_name?: string;
  last_name?: string;
  email_verified?: boolean;
  public_metadata?: Metadata;
  private_metadata?: Metadata;
  unsafe_metadata?: Metadata;
}

export interface UpdateUserBody {
  first_name?: string;
  last_name?: string;
  public_metadata?: Metadata;
  private_metadata?: Metadata;
}

export interface ReplaceUserMetadataBody {
  public_metadata?: Metadata;
  private_metadata?: Metadata;
  unsafe_metadata?: Metadata;
}

export function usersResource(request: RequestFn) {
  return {
    /** `GET /v1/users` — cursor-paginated. */
    list(params: ListUsersParams = {}): Promise<CursorPage<User>> {
      return request({ method: 'GET', path: '/v1/users', query: { ...params } });
    },
    get(id: string): Promise<User> {
      return request({ method: 'GET', path: `/v1/users/${enc(id)}` });
    },
    create(body: CreateUserBody, idempotencyKey?: string): Promise<User> {
      return request({ method: 'POST', path: '/v1/users', body, idempotencyKey });
    },
    update(id: string, body: UpdateUserBody): Promise<User> {
      return request({ method: 'PATCH', path: `/v1/users/${enc(id)}`, body });
    },
    /** `PUT /v1/users/:id/metadata` — replaces the named bags wholesale. */
    replaceMetadata(id: string, body: ReplaceUserMetadataBody): Promise<User> {
      return request({ method: 'PUT', path: `/v1/users/${enc(id)}/metadata`, body });
    },
    ban(id: string): Promise<User> {
      return request({ method: 'POST', path: `/v1/users/${enc(id)}/ban` });
    },
    unban(id: string): Promise<User> {
      return request({ method: 'POST', path: `/v1/users/${enc(id)}/unban` });
    },
    lock(id: string, body: { duration_in_seconds?: number } = {}): Promise<User> {
      return request({ method: 'POST', path: `/v1/users/${enc(id)}/lock`, body });
    },
    unlock(id: string): Promise<User> {
      return request({ method: 'POST', path: `/v1/users/${enc(id)}/unlock` });
    },
    delete(id: string): Promise<DeletedObject> {
      return request({ method: 'DELETE', path: `/v1/users/${enc(id)}` });
    },
    resetMfa(id: string): Promise<{ object: 'user'; id: string; mfa_enabled: false }> {
      return request({ method: 'POST', path: `/v1/users/${enc(id)}/reset_mfa` });
    },
    deleteMfaFactor(
      id: string,
      factorId: string,
    ): Promise<{ object: 'mfa_factor'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/users/${enc(id)}/mfa/${enc(factorId)}` });
    },
    listSessions(id: string): Promise<ListPage<UserSession>> {
      return request({ method: 'GET', path: `/v1/users/${enc(id)}/sessions` });
    },
    revokeSessions(
      id: string,
    ): Promise<{ object: 'user'; id: string; sessions_revoked: number }> {
      return request({ method: 'POST', path: `/v1/users/${enc(id)}/sessions/revoke` });
    },
    addEmail(id: string, body: { email_address: string }): Promise<EmailAddress> {
      return request({ method: 'POST', path: `/v1/users/${enc(id)}/email_addresses`, body });
    },
    verifyEmail(id: string, emailId: string): Promise<EmailAddress> {
      return request({
        method: 'POST',
        path: `/v1/users/${enc(id)}/email_addresses/${enc(emailId)}/verify`,
      });
    },
    setPrimaryEmail(id: string, emailId: string): Promise<EmailAddress> {
      return request({
        method: 'POST',
        path: `/v1/users/${enc(id)}/email_addresses/${enc(emailId)}/primary`,
      });
    },
    /** `GET /v1/users/:id/oauth_access_tokens/:provider` — a live provider credential. */
    getOAuthAccessToken(id: string, provider: string): Promise<OAuthAccessToken> {
      return request({
        method: 'GET',
        path: `/v1/users/${enc(id)}/oauth_access_tokens/${enc(provider)}`,
      });
    },
    /**
     * `GET /v1/users/:id/identities` — the base Atlas identity plus one entry per
     * linked external account. Tokens are never included.
     */
    listIdentities(id: string): Promise<ListPage<Identity>> {
      return request({ method: 'GET', path: `/v1/users/${enc(id)}/identities` });
    },
    /**
     * `POST /v1/users/:id/identities` — merge a secondary user INTO this one
     * (Auth0 `post_identities` parity). The secondary is retired by soft-delete;
     * collisions (a provider/email the primary already holds) are reported, never
     * clobbered.
     */
    linkIdentity(
      id: string,
      body: { secondary_user_id: string },
      idempotencyKey?: string,
    ): Promise<ListPage<Identity> & { collisions: Array<{ type: string; detail: string }> }> {
      return request({ method: 'POST', path: `/v1/users/${enc(id)}/identities`, body, idempotencyKey });
    },
    /**
     * `POST /v1/users/:id/external_accounts/connect` — start an OAuth flow that
     * links a NEW provider identity to THIS user (backend-initiated connect). For
     * an app whose own backend knows the current user (not an Atlas session
     * cookie): call this with the user's id, then redirect the browser to the
     * returned `authorization_url`. The callback links the provider to this user
     * WITHOUT creating a session, returning `__atlas_status=connected`. The
     * `IDENTITY_ALREADY_LINKED` guard refuses an identity owned by another user.
     */
    connectExternalAccount(
      id: string,
      body: { provider: string; redirect_url: string; additional_scopes?: string[] },
      idempotencyKey?: string,
    ): Promise<{
      object: 'external_account_connection';
      provider: string;
      user_id: string;
      attempt_id: string;
      authorization_url: string;
      scopes: string[];
    }> {
      return request({
        method: 'POST',
        path: `/v1/users/${enc(id)}/external_accounts/connect`,
        body,
        idempotencyKey,
      });
    },
    /**
     * `DELETE /v1/users/:id/identities/:identityId` — extract a linked provider
     * identity into a brand-new standalone user. The base identity and a user's
     * sole remaining sign-in identity cannot be unlinked.
     */
    unlinkIdentity(
      id: string,
      identityId: string,
    ): Promise<{ object: 'identity'; id: string; provider: string; unlinked: true; new_user_id: string }> {
      return request({ method: 'DELETE', path: `/v1/users/${enc(id)}/identities/${enc(identityId)}` });
    },
    /** `GET /v1/users/:id/grants` — the OAuth clients this user has authorized. */
    listGrants(id: string): Promise<ListPage<Grant>> {
      return request({ method: 'GET', path: `/v1/users/${enc(id)}/grants` });
    },
    /**
     * `DELETE /v1/users/:id/grants` — revoke every consent grant the user holds,
     * cascading to the associated access/refresh tokens so de-authorized apps
     * stop on their next call.
     */
    revokeAllGrants(
      id: string,
    ): Promise<{ object: 'user'; id: string; grants_revoked: number; tokens_revoked: number }> {
      return request({ method: 'DELETE', path: `/v1/users/${enc(id)}/grants` });
    },
    /**
     * `DELETE /v1/grants/:id` — revoke ONE consent grant (and its live tokens).
     * Grants are instance-scoped, so this is not nested under a user id.
     */
    revokeGrant(
      grantId: string,
    ): Promise<{ object: 'grant'; id: string; deleted: true; tokens_revoked: number }> {
      return request({ method: 'DELETE', path: `/v1/grants/${enc(grantId)}` });
    },
  };
}

/** One sign-in identity on a user: the base Atlas anchor, or a linked provider. */
export interface Identity {
  object: 'identity';
  id: string;
  type: 'atlas' | 'oauth';
  provider: string;
  provider_user_id?: string;
  email?: string | null;
  email_verified?: boolean;
  is_primary: boolean;
  has_password?: boolean;
}

/** An OAuth consent grant — the scopes a user authorized a client for. Never a token. */
export interface Grant {
  object: 'grant';
  id: string;
  client_id: string | null;
  client_name: string | null;
  scopes: string[];
  granted_at: number;
  updated_at: number;
}

export interface OAuthAccessToken {
  object: 'oauth_access_token';
  provider: string;
  /** The provider access token itself. Field is `token`, not `access_token`. */
  token: string;
  expires_at: number | null;
  scopes: string[];
  refreshed: boolean;
}

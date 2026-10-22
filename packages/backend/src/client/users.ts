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
  /**
   * Strictly increases with every change to the user; user webhook payloads
   * carry the same value. Apply an update only if its version is higher than
   * the one you hold. (Absent from servers older than this field.)
   */
  version?: number;
  /**
   * How the user arrived through a referral program, when the instance has
   * referral attribution on and the platform matched a referrer; null when not
   * referred, not answered yet, or referrals are off. (Absent from servers
   * older than this field.)
   */
  referral?: UserReferral | null;
  /** The user's own referral code, when they are a referrer. */
  referral_code?: string | null;
  /** The user's own referral link, when they are a referrer. */
  referral_link?: string | null;
}

/** The inbound referral the referral platform matched for a user. */
export interface UserReferral {
  /** The platform's id for the referring partner. */
  partner_id: string | null;
  /** The referrer as the platform knows them (your `external_id` for that user, or their Atlas id). */
  referrer_external_id: string | null;
  /** The referrer's Atlas user id, when they are a user of this instance. */
  referrer_user_id: string | null;
  /** How the platform matched the referral, e.g. `code`, `click`, `coupon`. */
  matched_via: string | null;
  /**
   * The attribution status: `pending` (the platform has not answered yet),
   * `attributed`, `none`, `failed`, `held` or `flagged`. Servers before
   * referral attribution v2 sent the platform's own status here; that is now
   * `referral_status`.
   */
  status: string | null;
  /** The referrer as the platform knows them. Same value as `referrer_external_id`. */
  partner_external_ref?: string | null;
  /** The platform's own status for the referral, e.g. `active`. */
  referral_status?: string | null;
  /** The platform's reasoning notes (why it matched, or why not). */
  notes?: string[] | null;
  /** The risk level Atlas assessed at sign-up, when one was. */
  risk_level?: 'low' | 'medium' | 'high' | null;
  /** An admin marked the referral fraudulent (`users.flagReferral`). */
  flagged?: boolean;
}

/**
 * An imported referral on `users.create`: how the user arrived. With referral
 * attribution on, the user is reported to the referral platform. Each id is
 * 3-64 characters of `A-Z a-z 0-9 _ -`.
 */
export interface CreateUserReferralInput {
  code?: string;
  click_id?: string;
  anon_id?: string;
}

/** `POST /v1/users/:id/referral/flag`. */
export interface UserReferralFlag {
  object: 'user_referral';
  user_id: string;
  /** `flagged` after this call. */
  status: string;
  flagged: boolean;
  flag_reason: string | null;
  /** Epoch ms. */
  flagged_at: number | null;
  risk_level: 'low' | 'medium' | 'high' | null;
}

/**
 * The `data` of a `user.referral_attributed` webhook: the referral platform
 * answered after `user.created` was sent.
 */
export interface UserReferralAttributedEvent {
  object: 'user_referral';
  user_id: string;
  /** `attributed`, `not_referred`, `failed`, … (`not_referred`: the platform found no referrer). */
  attribution_status: string;
  referral: UserReferral | null;
  referral_code: string | null;
  referral_link: string | null;
  /** Epoch ms. */
  signed_up_at: number;
  updated_at: number;
}

/**
 * The `data` of a `user.referral_resolved` webhook: a referral call that was
 * still pending when `user.created` was sent has a final result (attributed,
 * none or failed). `user.referral_attributed` still fires too when attributed.
 */
export type UserReferralResolvedEvent = UserReferralAttributedEvent;

/**
 * `GET /v1/users/:id/referral`: the stored result of the user's referral
 * calls, with no call to the platform. 404 when the user was never reported.
 */
export interface UserReferralResult {
  object: 'user_referral';
  user_id: string;
  /** `pending`, `attributed`, `none`, `failed`, `held` or `flagged`. */
  status: 'pending' | 'attributed' | 'none' | 'failed' | 'held' | 'flagged';
  /** The id Atlas reports the user under: their `external_id`, else the Atlas user id. */
  customer_ref: string;
  partner_id: string | null;
  /** The referrer as the platform knows them. */
  partner_external_ref: string | null;
  referrer_user_id: string | null;
  matched_via: string | null;
  /** The platform's own status for the referral. */
  referral_status: string | null;
  /** The platform's reasoning notes. */
  notes: string[];
  referral_code: string | null;
  referral_link: string | null;
  /** The referral captured at sign-up, as sent (camelCase). */
  context: Record<string, unknown> | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  flagged: boolean;
  /** Why the call is held, while `held`. */
  hold_reason: string | null;
  /** Epoch ms. */
  signed_up_at: number;
  updated_at: number;
}

export interface EmailAddress {
  object: 'email_address';
  id: string;
  email_address: string;
  /**
   * True only when the address was proven (an emailed code or link, a provider
   * that vouches for it, or your backend). An address that signed up while
   * `requireEmailVerification` was false is `false`.
   */
  verified: boolean;
  /**
   * `status` mirrors `verified`. `strategy` says how it was verified
   * (`email_code`, `email_link`, `oauth`, `admin`, `import`, `scim`, `lti`), or
   * `skipped` for an address held for sign-in but never proven; `null` when not
   * verified. (Absent from servers older than this field.)
   */
  verification?: { status: 'verified' | 'unverified'; strategy?: string | null };
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
  /** Epoch ms the session ends from inactivity unless there is activity first (same value as `abandon_at`). */
  idle_expires_at?: number;
  last_active_organization_id?: string | null;
  impersonated_by?: string | null;
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
  /**
   * Whether creating the user may notify them. Defaults to false, which
   * guarantees no email, SMS or push is sent as a consequence of the create.
   */
  notify?: boolean;
  /**
   * Import a referral (how the user arrived). With referral attribution on,
   * the user is reported to the referral platform.
   */
  referral?: CreateUserReferralInput;
  /** The user's own referral code; unique per instance (`409 REFERRAL_CODE_TAKEN`). */
  referral_code?: string;
}

export interface UpdateUserBody {
  first_name?: string;
  last_name?: string;
  /**
   * Your own id for the user; `null` clears. With referral attribution on, a
   * change after sign-up is forwarded to the referral platform as an alias,
   * so events under the new id still match.
   */
  external_id?: string | null;
  public_metadata?: Metadata;
  private_metadata?: Metadata;
  /** The user's own referral code; `null` clears. Unique per instance (`409 REFERRAL_CODE_TAKEN`). */
  referral_code?: string | null;
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
    /**
     * Set (or clear with `null`) the user's `external_id`: `PATCH
     * /v1/users/:id`. With referral attribution on, Atlas forwards the change
     * to the referral platform as an alias (old id, or the Atlas user id, to
     * the new one), so billing events under your id earn the referrer.
     */
    setExternalId(id: string, externalId: string | null): Promise<User> {
      return request({ method: 'PATCH', path: `/v1/users/${enc(id)}`, body: { external_id: externalId } });
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
    /**
     * `POST /v1/users/:id/referral/flag` — mark the user's referral fraudulent.
     * The referral reads `flagged: true`, the referral platform is sent a
     * `fraud_confirmed` signal (when referrals are on) and the action is
     * audited. The user's account is not changed. 404 when the user has no
     * referral. `reason` (at most 500 characters) is sent to the platform.
     */
    flagReferral(
      id: string,
      body: { reason?: string } = {},
      idempotencyKey?: string,
    ): Promise<UserReferralFlag> {
      return request({
        method: 'POST',
        path: `/v1/users/${enc(id)}/referral/flag`,
        body,
        idempotencyKey,
      });
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
    /**
     * Revoke every session of the user. `{ revoke_grants: true }` also revokes the
     * user's OAuth grants, so app refresh tokens stop minting access tokens.
     */
    revokeSessions(
      id: string,
      options: { revoke_grants?: boolean } = {},
    ): Promise<{ object: 'user'; id: string; sessions_revoked: number; grants_revoked?: number }> {
      return request({
        method: 'POST',
        path: `/v1/users/${enc(id)}/sessions/revoke`,
        ...(options.revoke_grants !== undefined ? { body: { revoke_grants: options.revoke_grants } } : {}),
      });
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
    /**
     * `POST /v1/users/by_emails` — resolve up to 1000 addresses to user ids in
     * one call. Verified, live users only by default; an address ABSENT from
     * `data` has no such user. For rights requests pass `include_unverified`.
     */
    byEmails(body: UsersByEmailsBody): Promise<ListPage<UserEmailMatch>> {
      return request({ method: 'POST', path: '/v1/users/by_emails', body });
    },
    /**
     * `GET /v1/users/:id/resolved` — the flat identity: real primary email,
     * whether it is verified, name, image and linked provider identities.
     */
    resolved(id: string): Promise<ResolvedUser> {
      return request({ method: 'GET', path: `/v1/users/${enc(id)}/resolved` });
    },
    /** `GET /v1/users/:id/state` — portable state: progression, tier, flair, entitlements, directives, roles. */
    state(id: string): Promise<UserState> {
      return request({ method: 'GET', path: `/v1/users/${enc(id)}/state` });
    },
    /**
     * `GET /v1/users/:id/sign_in_history` — successful sign-ins, newest first,
     * cursor-paginated (`limit` 1–100, default 50). Works with `paginate()`:
     * `paginate((p) => atlas.users.signInHistory('user_1', p))`.
     */
    signInHistory(id: string, params: CursorParams = {}): Promise<CursorPage<SignInEvent>> {
      return request({
        method: 'GET',
        path: `/v1/users/${enc(id)}/sign_in_history`,
        query: { ...params },
      });
    },
    /**
     * `GET /v1/users/:id/organization_memberships` — the organizations a user
     * belongs to with role, resolved plan and join time. Cursor-paginated
     * (`limit` default 20, max 100).
     */
    listOrganizationMemberships(
      id: string,
      params: CursorParams = {},
    ): Promise<CursorPage<UserOrganizationMembership>> {
      return request({
        method: 'GET',
        path: `/v1/users/${enc(id)}/organization_memberships`,
        query: { ...params },
      });
    },
    /**
     * `POST /v1/users/:id/password` — set (reset) a user's password. Password
     * history and policy apply unless `skip_password_checks` is set.
     */
    setPassword(id: string, body: SetUserPasswordBody): Promise<User> {
      return request({ method: 'POST', path: `/v1/users/${enc(id)}/password`, body });
    },
    /** `DELETE /v1/users/:id/profile_image` — clear the profile image. */
    deleteProfileImage(id: string): Promise<User> {
      return request({ method: 'DELETE', path: `/v1/users/${enc(id)}/profile_image` });
    },
    /** `DELETE /v1/users/:id/passkeys/:passkeyId` — remove one of the user's passkeys. */
    deletePasskey(
      id: string,
      passkeyId: string,
    ): Promise<{ object: 'passkey'; id: string; deleted: true }> {
      return request({
        method: 'DELETE',
        path: `/v1/users/${enc(id)}/passkeys/${enc(passkeyId)}`,
      });
    },
    /**
     * `POST /v1/users/:id/identities/import` — link a KNOWN provider identity
     * (migration) without an OAuth flow. A `(provider, provider_user_id)` held
     * by another user is a 409. Idempotent on the same user.
     */
    importIdentity(id: string, body: ImportIdentityBody): Promise<Identity> {
      return request({ method: 'POST', path: `/v1/users/${enc(id)}/identities/import`, body });
    },
    /**
     * `DELETE /v1/users/:id/identities/by-provider/:provider` — hard-remove a
     * provider identity (undo a mis-import). Unlike `unlinkIdentity`, no new
     * user is created. The account's only sign-in identity is refused.
     */
    removeIdentityByProvider(
      id: string,
      provider: string,
    ): Promise<{ object: string; id: string; provider: string; removed: boolean }> {
      return request({
        method: 'DELETE',
        path: `/v1/users/${enc(id)}/identities/by-provider/${enc(provider)}`,
      });
    },
    /**
     * `POST /v1/users/:id/erasure_acks` — your app confirms it purged its copy
     * of the user during a scheduled deletion, optionally contributing a JSON
     * `payload` to the erasure export. Upserts on (user, source).
     */
    acknowledgeErasure(
      id: string,
      body: UserErasureAckBody,
      idempotencyKey?: string,
    ): Promise<UserErasureAck> {
      return request({
        method: 'POST',
        path: `/v1/users/${enc(id)}/erasure_acks`,
        body,
        idempotencyKey,
      });
    },
    /**
     * `GET /v1/users/:id/erasure_export` — Atlas's own data about the user plus
     * every app's contributed payload, in one package.
     */
    erasureExport(id: string): Promise<UserErasureExport> {
      return request({ method: 'GET', path: `/v1/users/${enc(id)}/erasure_export` });
    },
    /** Graceful deletion with a cancellation window (`DELETE /v1/users/:id` stays the immediate path). */
    deletion: {
      /** `POST /v1/users/:id/deletion` — schedule; `grace_seconds` defaults to the instance erasure grace. */
      schedule(
        id: string,
        body: { grace_seconds?: number } = {},
        idempotencyKey?: string,
      ): Promise<User> {
        return request({
          method: 'POST',
          path: `/v1/users/${enc(id)}/deletion`,
          body,
          idempotencyKey,
        });
      },
      /** `POST /v1/users/:id/deletion/cancel` — 409 unless a deletion is still scheduled. */
      cancel(id: string, idempotencyKey?: string): Promise<User> {
        return request({
          method: 'POST',
          path: `/v1/users/${enc(id)}/deletion/cancel`,
          idempotencyKey,
        });
      },
      /** `POST /v1/users/:id/deletion/finalize` — purge once the window has lapsed; 409 if none is due. */
      finalize(
        id: string,
        idempotencyKey?: string,
      ): Promise<{ object: 'user'; id: string; deleted: true }> {
        return request({
          method: 'POST',
          path: `/v1/users/${enc(id)}/deletion/finalize`,
          idempotencyKey,
        });
      },
    },
    /** Cross-property directives: suspension, read-only, forced logout. */
    directives: {
      /** `POST /v1/users/:id/directives` — revokes live sessions where applicable. */
      impose(
        id: string,
        body: ImposeUserDirectiveBody,
        idempotencyKey?: string,
      ): Promise<UserDirective> {
        return request({
          method: 'POST',
          path: `/v1/users/${enc(id)}/directives`,
          body,
          idempotencyKey,
        });
      },
      /** `DELETE /v1/users/:id/directives` — lift the user's directive. */
      lift(id: string): Promise<{ object: 'directive'; user_id: string; lifted: true }> {
        return request({ method: 'DELETE', path: `/v1/users/${enc(id)}/directives` });
      },
    },
    /** Versioned consent records (ToS, privacy, marketing…). Append-only. */
    consents: {
      list(id: string): Promise<{ object: string; data: UserConsent[] }> {
        return request({ method: 'GET', path: `/v1/users/${enc(id)}/consents` });
      },
      /** Record acceptance (default) or `status: 'withdrawn'`. Repeating the current standing returns the existing record. */
      record(
        id: string,
        body: RecordUserConsentBody,
        idempotencyKey?: string,
      ): Promise<UserConsent> {
        return request({
          method: 'POST',
          path: `/v1/users/${enc(id)}/consents`,
          body,
          idempotencyKey,
        });
      },
    },
    /** Push number-matching approval of an arbitrary action ("approve this transfer"). */
    approvalRequests: {
      /**
       * `POST /v1/users/:id/approval_requests` — push the prompt to the user's
       * devices. Display the returned `match_number` yourself; 409 when the user
       * has no push device.
       */
      create(id: string, body: CreateUserApprovalRequestBody): Promise<UserApprovalRequestCreated> {
        return request({ method: 'POST', path: `/v1/users/${enc(id)}/approval_requests`, body });
      },
      /** `GET /v1/users/:id/approval_requests/:approvalId` — poll its status. */
      get(id: string, approvalId: string): Promise<UserApprovalRequest> {
        return request({
          method: 'GET',
          path: `/v1/users/${enc(id)}/approval_requests/${enc(approvalId)}`,
        });
      },
    },
    /** Security-notification preferences of one end user. */
    notificationPreferences: {
      get(id: string): Promise<UserNotificationPreferences> {
        return request({
          method: 'GET',
          path: `/v1/users/${enc(id)}/notification_preferences`,
        });
      },
      /** `{ preferences: { category: enabled } }`. Security-critical categories cannot be disabled. */
      update(
        id: string,
        body: UpdateUserNotificationPreferencesBody,
      ): Promise<UserNotificationPreferences> {
        return request({
          method: 'PATCH',
          path: `/v1/users/${enc(id)}/notification_preferences`,
          body,
        });
      },
    },
    /** Phone numbers on a user (the SMS counterpart of email addresses). */
    phoneNumbers: {
      /** Starts unverified. */
      add(id: string, body: { phone_number: string }): Promise<UserPhoneNumber> {
        return request({ method: 'POST', path: `/v1/users/${enc(id)}/phone_numbers`, body });
      },
      /** Mark verified. 409 if the number is already verified on another user. */
      verify(id: string, phoneId: string): Promise<UserPhoneNumber> {
        return request({
          method: 'POST',
          path: `/v1/users/${enc(id)}/phone_numbers/${enc(phoneId)}/verify`,
        });
      },
      delete(
        id: string,
        phoneId: string,
      ): Promise<{ object: 'phone_number'; id: string; deleted: true }> {
        return request({
          method: 'DELETE',
          path: `/v1/users/${enc(id)}/phone_numbers/${enc(phoneId)}`,
        });
      },
    },
    /** XP / level progression. */
    progression: {
      /**
       * `POST /v1/users/:id/progression/events` — append an event, idempotent on
       * `idempotency_key` (per calling key). A negative `amount` needs the `*` scope.
       */
      addEvent(id: string, body: UserProgressionEventBody): Promise<UserProgressionEvent> {
        return request({
          method: 'POST',
          path: `/v1/users/${enc(id)}/progression/events`,
          body,
        });
      },
    },
  };
}

export interface UsersByEmailsBody {
  /** Up to 1000 addresses, case-insensitive, deduplicated. */
  email_addresses: string[];
  /** Also match addresses never verified (for rights requests). Default false. */
  include_unverified?: boolean;
  /** Also match soft-deleted users. Default false. */
  include_deleted?: boolean;
}

export interface UserEmailMatch {
  email_address: string;
  user_id: string;
  verified: boolean;
  /** Present (true) only for a soft-deleted user matched via `include_deleted`. */
  deleted?: boolean;
}

export interface ResolvedUser {
  object: string;
  user_id: string;
  /** The real primary email, never a placeholder; null when the user has none. */
  email: string | null;
  email_verified: boolean;
  name: string | null;
  image_url: string | null;
  identities: Array<{ provider: string; provider_user_id: string; email: string | null }>;
}

export interface UserState {
  object: 'user_state';
  attributes: {
    /** Keyed by track name. */
    progression: Record<string, { xp: number; level: number }>;
    /** From `public_metadata.tier`, when set. */
    tier?: unknown;
    /** From `public_metadata.flair`, when set. */
    flair?: unknown;
  };
  entitlements: unknown[];
  directives: unknown[];
  roles: unknown[];
}

export interface SignInEvent {
  object: 'sign_in_event';
  id: string;
  /** password, email_code, oauth, passkey, … */
  method: string;
  /** The social provider, for an oauth sign-in. */
  provider: string | null;
  provider_email: string | null;
  ip: string | null;
  /** The actor id when the sign-in was an impersonation. */
  impersonated_by: string | null;
  created_at: number;
}

export interface UserOrganizationMembership {
  object: 'organization_membership';
  organization_id: string;
  organization_slug: string;
  role: string;
  plan: string | null;
  joined_at: number;
}

export interface SetUserPasswordBody {
  password: string;
  skip_password_checks?: boolean;
  /** Revoke the user's other sessions. */
  sign_out_of_other_sessions?: boolean;
}

export interface ImportIdentityBody {
  provider: string;
  provider_user_id: string;
  email_address?: string;
  verified?: boolean;
}

export interface UserErasureAckBody {
  /** The acknowledging app/system (its app id or a label). */
  source: string;
  /** Alias of `source`. */
  app_id?: string;
  /** Your data for the erasure export; omit to only confirm the purge. */
  payload?: Record<string, unknown>;
}

export interface UserErasureAck {
  object: 'user_erasure_ack';
  id: string;
  user_id: string;
  source: string;
  created_at: number;
}

export interface UserErasureExport {
  object: 'erasure_export';
  format_version: 1;
  generated_at: number;
  user_id: string;
  /** Atlas's own data about the user (no secrets). */
  atlas: Record<string, unknown>;
  app_contributions: Array<{ source: string; contributed_at: number; payload: unknown }>;
}

export interface ImposeUserDirectiveBody {
  /** ISO 8601 timestamp the suspension lasts until. */
  suspended_until?: string;
  read_only?: boolean;
  forced_logout?: boolean;
  reason?: string;
}

export interface UserDirective {
  object: 'directive';
  user_id: string;
  suspended_until?: string;
  read_only?: true;
  forced_logout?: true;
  reason?: string;
  /** Live sessions revoked by imposing the directive. */
  sessions_revoked: number;
}

export interface RecordUserConsentBody {
  /** e.g. `tos`, `privacy`, `marketing`. */
  policy: string;
  /** The policy version accepted. */
  version: string;
  /** `accepted` (default) or `withdrawn`. */
  status?: 'accepted' | 'withdrawn';
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface UserConsent {
  object: 'consent';
  id: string;
  policy: string;
  version: string;
  status: 'accepted' | 'withdrawn' | (string & {});
  source: string | null;
  metadata?: unknown;
  created_at: number;
}

export interface CreateUserApprovalRequestBody {
  /** What is being approved, shown on the device. */
  description: string;
  /** Extra key/value details shown under the description. Strings only. */
  context?: Record<string, string>;
}

export interface UserApprovalRequestCreated {
  object: 'approval_request';
  id: string;
  status: 'pending';
  /** Show this to the user; they confirm the matching number on their device. */
  match_number: string;
  expires_at: number;
}

export interface UserApprovalRequest {
  object: 'approval_request';
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  description: string;
  context?: Record<string, string>;
  approved_by_device_id: string | null;
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
}

export interface UserNotificationPreference {
  category: string;
  label: string;
  enabled: boolean;
  /** False for security-critical categories, which are always enabled. */
  optional: boolean;
}

export interface UserNotificationPreferences {
  object: 'notification_preferences';
  preferences: UserNotificationPreference[];
}

export interface UpdateUserNotificationPreferencesBody {
  /** Category key → enabled. */
  preferences: Record<string, boolean>;
}

export interface UserPhoneNumber {
  object: 'phone_number';
  id: string;
  phone_number: string;
  verified: boolean;
  created_at: number;
}

export interface UserProgressionEventBody {
  track?: string;
  amount: number;
  reason: string;
  /** Required; a retry with the same key is a no-op. */
  idempotency_key: string;
}

export interface UserProgressionEvent {
  object: 'progression_event';
  track: string;
  xp: number;
  level: number;
  level_changed: boolean;
  delta: number;
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

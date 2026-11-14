import { enc, type RequestFn } from './request';



export type UsersCreateAccountClaimBody = {
  password_policy?: string;
};

export type UsersCreateAccountClaimResult = {
  object: 'account_claim';
  user_id: string;
  protection: 'password_hold' | 'claim_marker';
};

export type UsersMergeBody = {
  source_user_id?: string;
  dry_run?: boolean;
};

export type UsersMergeResult = Record<string, unknown>;

/** Operations on `/v1/users` (2). */
export function usersOpsResource(request: RequestFn) {
  return {
    /** Protect one existing unverified user, so a proof of its address reaches it instead of making a second account. Body: `password_policy` must be `until_email_verified`. A user with a password gets the same hold an import gives. A user with no credential is marked as yours, and a proof of its address then claims it. Naming the exact user id is what makes this safe, so nothing matches by address. Answers 409 ACCOUNT_NOT_CLAIMABLE with `meta.reasons` when the user has a verified address or anything else that signs in, and 422 when it has no email address. Safe to repeat. */
    createAccountClaim(id: string, body?: UsersCreateAccountClaimBody, idempotencyKey?: string): Promise<UsersCreateAccountClaimResult> {
      return request({ method: 'POST', path: `/v1/users/${enc(id)}/account_claim`, body, idempotencyKey });
    },
    /** Merge another user INTO this one (the one kept). Emails, phones, social accounts, MFA factors, passkeys, API tokens, devices, organization and group memberships, app roles, consents, billing subscriptions and credits move across (a membership the target already has is left as it is, and the target's role wins); metadata merges key by key with the target winning; blank profile fields are filled. The source user's sessions end and it is deleted, firing `user.deleted` and `user.merged`. Refused when the users are the same, the source is banned and the target is not, or the target is a guest. `dry_run` reports what would move. Needs users:write and users:delete. */
    merge(id: string, body?: UsersMergeBody, idempotencyKey?: string): Promise<UsersMergeResult> {
      return request({ method: 'POST', path: `/v1/users/${enc(id)}/merge`, body, idempotencyKey });
    },
  };
}

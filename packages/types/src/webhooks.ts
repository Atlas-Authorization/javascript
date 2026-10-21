/**
 * Webhook event + payload + verification types.
 *
 * COPIED from `@atlasauth/core` (`src/webhooks/signing.ts`) and
 * `@atlasauth/backend` (`src/webhooks.ts`). Both ship the HMAC signing/verifying
 * runtime (node:crypto), so the types are mirrored here. {@link WebhookEvent} is
 * the exact literal union off core's `WEBHOOK_EVENTS` catalog, inlined so this
 * package needs no value import.
 */

/**
 * §12.1 event catalog — the exact union off core's `WEBHOOK_EVENTS`.
 */
export type WebhookEvent =
  | 'user.created'
  | 'user.updated'
  | 'user.referral_attributed'
  | 'user.deleted'
  | 'user.banned'
  | 'user.unbanned'
  | 'user.locked'
  | 'user.deactivated'
  | 'user.graduated'
  | 'policy.imposed'
  | 'user.suspended'
  | 'user.unsuspended'
  | 'session.created'
  | 'session.revoked'
  | 'session.ended'
  | 'session.pending'
  | 'session.removed'
  | 'grant.revoked'
  | 'email.created'
  | 'sms.created'
  | 'organization.created'
  | 'organization.updated'
  | 'organization.deleted'
  | 'organizationMembership.created'
  | 'organizationMembership.updated'
  | 'organizationMembership.deleted'
  | 'organization.membership.deleted'
  | 'organizationInvitation.created'
  | 'organizationInvitation.accepted'
  | 'organizationInvitation.revoked'
  | 'organizationInvitation.declined'
  | 'role.created'
  | 'role.updated'
  | 'role.deleted'
  | 'permission.created'
  | 'permission.updated'
  | 'permission.deleted'
  | 'organizationDomain.created'
  | 'organizationDomain.updated'
  | 'organizationDomain.deleted'
  | 'organization.settings.updated'
  | 'waitlistEntry.created'
  | 'waitlistEntry.updated'
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.deleted'
  | 'entitlement.created'
  | 'entitlement.updated'
  | 'entitlement.deleted'
  | 'entitlement.override.created'
  | 'entitlement.override.deleted'
  | 'entitlement.override.expired'
  | 'scimToken.created'
  | 'scimToken.revoked'
  | 'api_key.revoked'
  | 'api_key.created'
  | 'api_key.updated'
  | 'api_key.limit_reached'
  | 'ssoConnection.created'
  | 'ssoConnection.updated'
  | 'ssoConnection.deleted'
  | 'user.data_export.requested'
  | 'user.deletion_requested'
  | 'user.deletion_cancelled'
  | 'data_subject_request.scheduled'
  | 'data_subject_request.fulfilled'
  | 'data_subject_request.rejected'
  | 'machine.enrolled'
  | 'machine.revoked'
  | 'machine.updated'
  | 'user.deletion_scheduled'
  | 'user.deletion_canceled';

/**
 * §12.2 payload. Full resource objects, not diffs — "consumers never need a
 * read-back call", which also means a consumer processing events out of order
 * can still reconstruct state from the latest one it sees.
 */
export interface WebhookPayload<T = unknown> {
  id: string;
  type: string;
  timestamp: number;
  instance_id: string;
  data: T;
}

/** Why verification of an inbound Atlas webhook failed, when it did. */
export type WebhookVerifyFailure =
  | 'missing_headers'
  | 'malformed_signature'
  | 'stale_timestamp'
  | 'signature_mismatch';

export interface WebhookVerifyResult<T = unknown> {
  /** True only when the signature and timestamp both check out. */
  verified: boolean;
  /** Why verification failed, when it did. */
  reason?: WebhookVerifyFailure;
  /** The parsed event envelope `{ id, type, timestamp, instance_id, data }` — present only when `verified`. */
  event?: T;
}

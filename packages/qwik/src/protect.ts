/**
 * The authorization primitive, surfaced for logic that is not a render decision.
 *
 * `<Protect>` and `useAuth().has()` both evaluate conditions through this ONE
 * primitive — shared with `@atlasauth/backend`'s `auth().has()` through
 * `@atlasauth/authz` (re-exported by `@atlasauth/js`) — so the Qwik guard and the
 * server judge a role/permission condition identically.
 */
export {
  type ProtectCondition,
  type ProtectOutcome,
  type ProtectReason,
  evaluate,
  hasFromClaims,
} from '@atlasauth/js';

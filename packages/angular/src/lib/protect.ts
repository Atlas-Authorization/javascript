/**
 * Conditional-rendering authorization primitive — re-exported unchanged from
 * `@atlasauth/authz`, the ONE evaluator every Atlas SDK shares. `*atlasProtect` in
 * this package and `<Protect>` in `@atlasauth/react` therefore judge a condition
 * identically, and the server checking the same permission is what actually
 * stops a request; these helpers only decide what a user is shown.
 */
export {
  type ProtectCondition,
  type ProtectOutcome,
  type ProtectReason,
  evaluate,
  hasFromClaims,
} from '@atlasauth/authz';

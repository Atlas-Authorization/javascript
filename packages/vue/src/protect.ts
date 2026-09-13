/**
 * §10.2 `<Protect permission="org:sys_memberships:manage">` — conditional
 * rendering.
 *
 * The rule that makes this safe to ship: this is a RENDERING helper, never an
 * authorization boundary. It decides what a user sees, and seeing is not doing.
 * Anyone can open devtools and flip the condition; the only thing that stops
 * them acting is the server checking the same permission on the request.
 *
 * That is worth stating loudly because the component reads like a guard, and a
 * developer who believes it is one will eventually put a delete button behind
 * it and no check behind the endpoint.
 *
 * The evaluation logic lives in `@atlasauth/authz` — the ONE primitive every SDK
 * (backend, Next.js, React, React Native, JS) shares, so `<Protect>` here and
 * `auth().has()` on the server judge a condition identically.
 */
export {
  type ProtectCondition,
  type ProtectOutcome,
  type ProtectReason,
  evaluate,
  hasFromClaims,
} from '@atlasauth/authz';

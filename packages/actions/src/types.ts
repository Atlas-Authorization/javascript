/**
 * `@atlasauth/actions` — the typed event/api surface for Atlas Actions.
 *
 * An Action is a tenant's own JavaScript, run at a fixed point in the auth
 * pipeline inside a hardened V8 isolate. Inside that isolate the tenant code
 * sees exactly two things in scope: a frozen `event` (structured data about the
 * sign-in / registration) and an `api` object whose methods record intents the
 * host applies afterwards (deny the transaction, add a token claim, merge app
 * metadata, log a line). There is no `require`, no `fetch`, no `process`, no
 * bare `console` — the ONLY capability is `api`.
 *
 * This module mirrors that surface as TypeScript so a tenant can author an
 * action with full type-safety and unit-test it offline (see `./harness`),
 * exactly the way `@auth0/actions` types Auth0's `onExecute*` handlers.
 */

/** The fixed points in the auth pipeline an action can bind to. */
export type ActionTrigger = 'post_login' | 'pre_user_registration' | 'post_user_registration';

export const ACTION_TRIGGERS: readonly ActionTrigger[] = [
  'post_login',
  'pre_user_registration',
  'post_user_registration',
];

// ---------------------------------------------------------------------------
// event
// ---------------------------------------------------------------------------

/** The user as an action sees it. A read-only projection of the user row. */
export interface ActionUser {
  /**
   * The user's id (`user_...`). Present for an existing user (post_login,
   * post_user_registration); `null` for pre_user_registration, where the user
   * has not been created yet.
   */
  id: string | null;
  email: string | null;
  emailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  /**
   * The user's public metadata — the bucket `api.user.setAppMetadata` merges
   * into. Always an object (empty when unset).
   */
  metadata: Record<string, unknown>;
}

/** How the user authenticated. */
export interface ActionConnection {
  /** e.g. `password`, `oauth_google`, `passkey`, `sso_<id>`, `lti`. */
  strategy: string | null;
  /**
   * Registration triggers only — the sign-up method family: `password`,
   * `email_code`, `email_link`, `phone_code`, `social`, `enterprise_sso`,
   * `web3_wallet` or `lti`. Absent on post_login.
   */
  method?: string | null;
}

/** The inbound request the auth transaction arrived on. */
export interface ActionRequest {
  ip: string | null;
  userAgent: string | null;
}

/**
 * The base event every trigger receives. Triggers refine `user` (whether `id`
 * is populated) but share this shape. `secrets` is the action's own declared
 * secrets, decrypted for this run only (name → plaintext); never log them.
 */
export interface BaseActionEvent {
  user: ActionUser;
  connection: ActionConnection;
  request: ActionRequest;
  secrets: Record<string, string>;
}

/** post_login — an existing user is signing in. `user.id` is populated. */
export interface PostLoginEvent extends BaseActionEvent {
  user: ActionUser & { id: string };
}

/**
 * pre_user_registration — a user is about to be created. `user.id` is `null`
 * (the row does not exist yet); denying here aborts the registration.
 */
export interface PreUserRegistrationEvent extends BaseActionEvent {
  user: ActionUser & { id: null };
}

/** post_user_registration — the user now exists (side-effect hook). */
export interface PostUserRegistrationEvent extends BaseActionEvent {
  user: ActionUser & { id: string };
}

// ---------------------------------------------------------------------------
// api
// ---------------------------------------------------------------------------

/**
 * Refuse the transaction. On a fail-closed trigger (post_login,
 * pre_user_registration) the first `deny` short-circuits the flow and blocks
 * the sign-in / registration with `reason`.
 */
export interface AccessApi {
  deny(reason?: string): void;
}

/**
 * Add a custom claim to a minted token. NB `setCustomClaim` returns `void` (not
 * the api, so it is NOT chainable) — this matches the real in-isolate surface
 * exactly, so a handler that passes the harness behaves identically once
 * deployed.
 */
export interface TokenApi {
  setCustomClaim(name: string, value: unknown): void;
}

/** Queue a merge into the user's public (app) metadata, applied by the host. */
export interface UserApi {
  setAppMetadata(name: string, value: unknown): void;
}

/** The only logging surface — there is no bare `console` inside an action. */
export interface ConsoleApi {
  log(...args: unknown[]): void;
}

/** api for post_login: gate the sign-in, stamp claims, merge metadata, log. */
export interface PostLoginApi {
  access: AccessApi;
  accessToken: TokenApi;
  idToken: TokenApi;
  user: UserApi;
  console: ConsoleApi;
}

/**
 * api for pre_user_registration: gate the registration, and pre-seed claims /
 * metadata that attach to the user once created.
 */
export interface PreUserRegistrationApi {
  access: AccessApi;
  accessToken: TokenApi;
  idToken: TokenApi;
  user: UserApi;
  console: ConsoleApi;
}

/**
 * api for post_user_registration: a side-effect hook. The transaction has
 * already committed, so there is deliberately NO `api.access` here — a `deny`
 * is meaningless once the user exists and is ignored by the host. Only
 * metadata and logging are available.
 */
export interface PostUserRegistrationApi {
  user: UserApi;
  console: ConsoleApi;
}

// ---------------------------------------------------------------------------
// trigger → event/api mapping + handler
// ---------------------------------------------------------------------------

/** The event type for a trigger. */
export type EventForTrigger<T extends ActionTrigger> = T extends 'post_login'
  ? PostLoginEvent
  : T extends 'pre_user_registration'
    ? PreUserRegistrationEvent
    : PostUserRegistrationEvent;

/** The api type for a trigger. */
export type ApiForTrigger<T extends ActionTrigger> = T extends 'post_login'
  ? PostLoginApi
  : T extends 'pre_user_registration'
    ? PreUserRegistrationApi
    : PostUserRegistrationApi;

/**
 * An action handler for a trigger: `(event, api) => void | Promise<void>`. The
 * mirror of Auth0's `onExecutePostLogin` etc., but typed per Atlas trigger.
 */
export type ActionHandler<T extends ActionTrigger> = (
  event: EventForTrigger<T>,
  api: ApiForTrigger<T>,
) => void | Promise<void>;

/**
 * A defined action: a handler bound to its trigger, plus `toCode()` which
 * serializes the handler into the deployable script body Atlas stores and runs
 * in the isolate. The deployed script is `await (<handler source>)(event, api)`
 * — so the function you unit-test IS the function that runs in production.
 *
 * Because the handler is serialized by `Function.prototype.toString`, it MUST
 * be self-contained: no imports, no closure over module-scope variables, no
 * references to anything but `event`, `api`, and values it declares itself.
 * (The isolate enforces this anyway — there is nothing else in scope there.)
 */
export interface DefinedAction<T extends ActionTrigger> {
  trigger: T;
  handler: ActionHandler<T>;
  toCode(): string;
}

/**
 * A trigger-erased defined action, for collections (e.g. the template manifest)
 * where the per-trigger generic would otherwise fight TypeScript's handler
 * contravariance.
 */
export interface AnyDefinedAction {
  trigger: ActionTrigger;
  // `any` (not `never`) so an erased action's handler stays usable with the
  // generic `runAction` without fighting handler contravariance — the concrete
  // per-trigger types on `DefinedAction<T>` are what authors actually see.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (event: any, api: any) => void | Promise<void>;
  toCode(): string;
}

/**
 * Define an action: bind a typed handler to its trigger. Use it to author an
 * action, unit-test it with `runAction` from `./harness`, and `toCode()` it for
 * `atlas actions deploy`.
 */
export function defineAction<T extends ActionTrigger>(
  trigger: T,
  handler: ActionHandler<T>,
): DefinedAction<T> {
  return {
    trigger,
    handler,
    toCode() {
      // The isolate wraps stored code in `(async function(){ <code> })()` with
      // `event` and `api` in scope, so invoking the serialized handler with
      // them reproduces exactly what the harness ran.
      return `await (${handler.toString()})(event, api);`;
    },
  };
}

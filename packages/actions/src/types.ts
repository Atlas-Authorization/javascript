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
export type ActionTrigger =
  | 'post_login'
  | 'pre_user_registration'
  | 'post_user_registration'
  | 'pre_organization_create'
  | 'pre_member_add'
  | 'pre_invitation_create'
  | 'pre_authentication'
  | 'pre_token'
  | 'post_token_exchange'
  | 'custom_token_exchange'
  | 'pre_user_update'
  | 'mfa_verification_attempt'
  | 'password_verification_attempt'
  | 'account_link_decision'
  | 'billing_plan_selected'
  | 'post_change_password'
  | 'post_password_reset'
  | 'post_user_update'
  | 'post_email_verified'
  | 'post_mfa_enroll'
  | 'post_mfa_remove'
  | 'post_logout'
  | 'org_membership_changed'
  // EXT-04 custom challenge factor handlers (gates).
  | 'custom_challenge_create'
  | 'custom_challenge_verify'
  | 'workflow_step';

export const ACTION_TRIGGERS: readonly ActionTrigger[] = [
  'post_login',
  'pre_user_registration',
  'post_user_registration',
  'pre_organization_create',
  'pre_member_add',
  'pre_invitation_create',
  'pre_authentication',
  'pre_token',
  'post_token_exchange',
  'custom_token_exchange',
  'pre_user_update',
  'mfa_verification_attempt',
  'password_verification_attempt',
  'account_link_decision',
  'billing_plan_selected',
  'post_change_password',
  'post_password_reset',
  'post_user_update',
  'post_email_verified',
  'post_mfa_enroll',
  'post_mfa_remove',
  'post_logout',
  'org_membership_changed',
  'custom_challenge_create',
  'custom_challenge_verify',
  'workflow_step',
];

/**
 * The triggers that run AFTER the change they report. The change has committed,
 * so a failing Action is ignored (fail open) and `api.access.deny` does not
 * exist. Every other trigger is a gate that fails closed.
 */
export const SIDE_EFFECT_TRIGGERS: readonly ActionTrigger[] = [
  'post_user_registration',
  'post_change_password',
  'post_password_reset',
  'post_user_update',
  'post_email_verified',
  'post_mfa_enroll',
  'post_mfa_remove',
  'post_logout',
  'org_membership_changed',
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
  /**
   * The organizations the user belongs to (up to 50), with their role in each.
   * Empty for pre_user_registration, where the user does not exist yet.
   */
  organizations: ActionOrganizationMembership[];
}

/** One of the user's organization memberships. */
export interface ActionOrganizationMembership {
  id: string;
  slug: string;
  name: string;
  role: string;
}

/** How the user authenticated. */
export interface ActionConnection {
  /** e.g. `password`, `oauth_google`, `passkey`, `sso_<id>`, `lti`. */
  strategy: string | null;
  /**
   * Registration triggers only — the sign-up method family: `password`,
   * `email_code`, `email_link`, `phone_code`, `social`, `enterprise_sso`,
   * `web3_wallet`, `lti` or `passkey`. Absent on post_login.
   */
  method?: string | null;
}

/** The inbound request the auth transaction arrived on. */
export interface ActionRequest {
  ip: string | null;
  userAgent: string | null;
  /**
   * ISO 3166-1 alpha-2 country of `ip` (e.g. `DE`) when the platform's GeoIP
   * data resolves it; null for private or unknown addresses.
   */
  country: string | null;
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
  /**
   * What the trigger is about, per trigger: `pre_token` has `tokenType` and the
   * client/audience/scopes, `pre_authentication` the credential kind,
   * `pre_user_update` the changed fields, the MFA triggers the factor type and
   * `result`, and so on. See the Actions guide for the table.
   */
  context: Record<string, unknown>;
  secrets: Record<string, string>;
}

/** Registration triggers also carry what the person typed into the sign-up fields. */
export interface RegistrationFields {
  signUpFields: Record<string, string>;
}

/** post_login — an existing user is signing in. `user.id` is populated. */
export interface PostLoginEvent extends BaseActionEvent {
  user: ActionUser & { id: string };
}

/**
 * pre_user_registration — a user is about to be created. `user.id` is `null`
 * (the row does not exist yet); denying here aborts the registration.
 */
export interface PreUserRegistrationEvent extends BaseActionEvent, RegistrationFields {
  user: ActionUser & { id: null };
}

/** post_user_registration — the user now exists (side-effect hook). */
export interface PostUserRegistrationEvent extends BaseActionEvent, RegistrationFields {
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
 * `mfa_verification_attempt` and `password_verification_attempt`: besides
 * `deny` (reject the attempt, even a correct one), `lock` locks the account for
 * 15 minutes and answers 429.
 */
export interface AttemptAccessApi extends AccessApi {
  lock(reason?: string): void;
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

/**
 * `pre_token`: the token API also removes claims. Only optional identity claims
 * (`email`, `name`, `picture`, `orgs`, …) and claims an Action or template added
 * can be removed; claims Atlas owns (`sub`, `iss`, `aud`, `sid`, `org_*`, …) never.
 */
export interface PreTokenTokenApi extends TokenApi {
  suppressClaim(name: string): void;
}

/** Queue a merge into the user's public (app) metadata, applied by the host. */
export interface UserApi {
  setAppMetadata(name: string, value: unknown): void;
}

/**
 * Edits to the user, applied by Atlas after the run when the step was not
 * refused: ban or unban, mark the email verified (it cannot be un-verified),
 * set the name, set the avatar (https only). Available on triggers that have a user.
 */
export interface UserEditApi extends UserApi {
  setBanned(banned: boolean, reason?: string): void;
  setEmailVerified(verified: boolean): void;
  setName(firstName?: string | null, lastName?: string | null): void;
  setImage(url: string | null): void;
}

/**
 * Registration triggers: shape the sign-up fields. `prefill` fills a field the
 * person left empty; `modify` replaces whatever they typed. `first_name` and
 * `last_name` set the name; any other key is saved on the user's public metadata.
 */
export interface SignUpApi {
  prefill(field: string, value: string): void;
  modify(field: string, value: string): void;
}

/** Options for an outbound request. */
export interface HttpRequestOptions {
  /** Up to 20 headers. Host, Content-Length, Connection and other hop-by-hop headers are set by Atlas. */
  headers?: Record<string, string>;
  /**
   * Save a JSON response on the user's public metadata under this key (letters,
   * digits and `_`), where later sign-ins and token claims can read it.
   */
  saveResponseAs?: string;
}

/**
 * Outbound HTTP. The sandbox has no network of its own: each call QUEUES a
 * request (https only, up to 5 per run, body up to 64 KB) that Atlas sends after
 * the sign-in or sign-up completes, so a slow endpoint never delays the user. A
 * denied sign-in sends nothing. The response never comes back into the action;
 * use `saveResponseAs` to keep it.
 */
export interface HttpApi {
  get(url: string, options?: HttpRequestOptions): void;
  /** A non-string `body` is sent as JSON with `content-type: application/json`. */
  post(url: string, body?: unknown, options?: HttpRequestOptions): void;
}

/**
 * Call one of your service connectors (Twilio, Slack, Segment, a CRM…) by the
 * name you gave it. Like `api.http` the call is queued and made by Atlas after
 * the flow completes, with the credentials kept in the vault; the answer never
 * comes back into the action. At most 5 calls per run; `input` is checked
 * against the operation's fields when it runs.
 */
export interface ConnectorApi {
  send(name: string, operation: string, input?: Record<string, unknown>): void;
}

/**
 * post_login only: attach custom data to the session being created. It is
 * returned on the session object and, when the instance opts in, carried in the
 * session token under one namespaced claim. Keys are truncated to 64
 * characters; the whole object is capped at 2 KB (largest keys dropped first).
 */
export interface SessionApi {
  setCustomData(name: string, value: unknown): void;
}

/** The only logging surface — there is no bare `console` inside an action. */
export interface ConsoleApi {
  log(...args: unknown[]): void;
}

/** api for post_login: gate the sign-in, stamp claims, attach session data, merge metadata, log. */
export interface PostLoginApi {
  access: AccessApi;
  accessToken: TokenApi;
  idToken: TokenApi;
  session: SessionApi;
  user: UserEditApi;
  http: HttpApi;
  connector: ConnectorApi;
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
  user: UserEditApi;
  signUp: SignUpApi;
  console: ConsoleApi;
}

/**
 * api for post_user_registration: a side-effect hook. The transaction has
 * already committed, so there is deliberately NO `api.access` here — a `deny`
 * is meaningless once the user exists and is ignored by the host. Only
 * metadata and logging are available.
 */
export interface PostUserRegistrationApi {
  user: UserEditApi;
  http: HttpApi;
  connector: ConnectorApi;
  console: ConsoleApi;
}

/** api for `pre_authentication`, `pre_user_update`, `account_link_decision`, `billing_plan_selected` and the organization gates: decide, with optional user edits. */
export interface GateApi {
  access: AccessApi;
  user: UserEditApi;
  console: ConsoleApi;
}

/** api for `mfa_verification_attempt` and `password_verification_attempt`. */
export interface AttemptApi {
  access: AttemptAccessApi;
  user: UserEditApi;
  console: ConsoleApi;
}

/** `custom_challenge_create` / `custom_challenge_verify`: the custom second factor. */
export interface ChallengeApi {
  /** create: what the person is asked. `state` is kept by Atlas and handed back to verify (never shown). */
  set(challenge: { prompt: string; hint?: string; state?: unknown }): void;
  /** verify: let the sign-in through. `amr` lands in the session's amr claim (default `["custom"]`). */
  accept(options?: { amr?: string[] }): void;
}

/** api for the custom-challenge triggers. Not accepting (or `access.deny`) rejects the answer. */
export interface CustomChallengeApi {
  access: AccessApi;
  challenge: ChallengeApi;
  console: ConsoleApi;
}

/** Who a custom token exchange issues tokens for (what `api.exchange.setUser*` recorded). */
export interface ExchangeSubject {
  by: 'id' | 'email' | 'external_id';
  value: string;
  /** Create the user when none matches (email / external id lookups only). */
  create: boolean;
  email?: string;
  externalId?: string;
  emailVerified?: boolean;
}

/** `custom_token_exchange`: say which user the validated subject token stands for. */
export interface ExchangeApi {
  /** An Atlas user id. */
  setUserById(id: string): void;
  /** The user with this email; `create` makes one (with `externalId`, `emailVerified` as given) when there is none. */
  setUserByEmail(email: string, options?: { create?: boolean; externalId?: string; emailVerified?: boolean }): void;
  /** The user with this external id; `create` makes one (with `email`, `emailVerified`) when there is none. */
  setUserByExternalId(externalId: string, options?: { create?: boolean; email?: string; emailVerified?: boolean }): void;
}

/**
 * api for `custom_token_exchange`: validate the subject token in `event.context.subjectToken` (there is no outbound
 * request here, so verify it in the Action, for example a signature against a key kept in a secret), then call one
 * of `api.exchange.setUser*`. `api.access.deny` refuses the exchange; calling none of them refuses it too.
 */
export interface CustomTokenExchangeApi {
  access: AccessApi;
  exchange: ExchangeApi;
  console: ConsoleApi;
}

/** api for `pre_token` and `post_token_exchange`: claims in, claims out, or refuse. */
export interface PreTokenApi {
  access: AccessApi;
  accessToken: PreTokenTokenApi;
  idToken: PreTokenTokenApi;
  console: ConsoleApi;
}

/** api for the side-effect triggers: edits, metadata, outbound requests, logs. No `access`. */
export interface SideEffectApi {
  user: UserEditApi;
  http: HttpApi;
  connector: ConnectorApi;
  console: ConsoleApi;
}

// ---------------------------------------------------------------------------
// trigger → event/api mapping + handler
// ---------------------------------------------------------------------------

/** An event with an existing user, for every trigger that is not about a new one. */
export interface UserEvent extends BaseActionEvent {
  user: ActionUser & { id: string };
}

/** The organization an organization trigger is about (`id` is null for `pre_organization_create`). */
export interface OrganizationEvent extends BaseActionEvent {
  organization: { id: string | null; name: string; slug: string };
  membership?: { role: string; source: string };
  invitation?: { email: string; role: string };
}

/** custom_token_exchange — the user is not known yet: `user.id` is null and `context` holds the subject token. */
export interface CustomTokenExchangeEvent extends BaseActionEvent {
  user: ActionUser & { id: null };
}

/** The event type for a trigger. */
export type EventForTrigger<T extends ActionTrigger> = T extends 'post_login'
  ? PostLoginEvent
  : T extends 'custom_token_exchange'
    ? CustomTokenExchangeEvent
    : T extends 'pre_user_registration'
    ? PreUserRegistrationEvent
    : T extends 'post_user_registration'
      ? PostUserRegistrationEvent
      : T extends 'pre_organization_create' | 'pre_member_add' | 'pre_invitation_create' | 'org_membership_changed'
        ? OrganizationEvent
        : UserEvent;

/** The api type for a trigger. */
export type ApiForTrigger<T extends ActionTrigger> = T extends 'post_login'
  ? PostLoginApi
  : T extends 'custom_token_exchange'
    ? CustomTokenExchangeApi
    : T extends 'pre_user_registration'
    ? PreUserRegistrationApi
    : T extends 'post_user_registration'
      ? PostUserRegistrationApi
      : T extends 'pre_token' | 'post_token_exchange'
        ? PreTokenApi
        : T extends 'custom_challenge_create' | 'custom_challenge_verify'
          ? CustomChallengeApi
          : T extends 'mfa_verification_attempt' | 'password_verification_attempt'
          ? AttemptApi
          : T extends
                | 'post_change_password'
                | 'post_password_reset'
                | 'post_user_update'
                | 'post_email_verified'
                | 'post_mfa_enroll'
                | 'post_mfa_remove'
                | 'post_logout'
                | 'org_membership_changed'
            ? SideEffectApi
            : GateApi;

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

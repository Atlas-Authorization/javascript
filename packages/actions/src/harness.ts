/**
 * The local test harness — run an action offline and assert what it did.
 *
 * It is a faithful in-process re-implementation of the api surface the real
 * Atlas isolate injects (apps/api actions/runtime.ts `BOOTSTRAP`): every method
 * accumulates intents onto a plain result object, exactly as the sandbox does,
 * so a handler that behaves a given way here behaves the same way in production.
 * This is the Atlas peer of `@kilterset/auth0-actions-testing` — a mock `event`
 * builder plus a runner that captures `api.access.deny`,
 * `api.*.setCustomClaim`, `api.user.setAppMetadata`, and `api.console.log`.
 *
 * It does NOT spin up a V8 isolate (that is the server's job) — it runs the
 * handler as ordinary JS so a test is fast and needs no native dependency.
 */
import type {
  ActionTrigger,
  AnyDefinedAction,
  DefinedAction,
  EventForTrigger,
  PostLoginApi,
  AttemptApi,
  PreTokenApi,
  PreUserRegistrationApi,
  PostUserRegistrationApi,
  CustomTokenExchangeApi,
  ExchangeSubject,
} from './types';

/** One recorded api call, in the order it was made. */
export interface CapturedApiCall {
  method:
    | 'access.deny'
    | 'access.lock'
    | 'exchange.setUserById'
    | 'exchange.setUserByEmail'
    | 'exchange.setUserByExternalId'
    | 'challenge.set'
    | 'challenge.accept'
    | 'accessToken.suppressClaim'
    | 'idToken.suppressClaim'
    | 'signUp.prefill'
    | 'signUp.modify'
    | 'user.setBanned'
    | 'user.setEmailVerified'
    | 'user.setName'
    | 'user.setImage'
    | 'accessToken.setCustomClaim'
    | 'idToken.setCustomClaim'
    | 'session.setCustomData'
    | 'user.setAppMetadata'
    | 'http.get'
    | 'http.post'
    | 'connector.send'
    | 'console.log';
  args: unknown[];
}

/**
 * Everything an action produced against a mock event. Mirrors the host-side
 * `ActionResult`: the claim/metadata buckets, the deny verdict, captured logs,
 * and — set only when the handler threw — the error message.
 */
export interface ActionRunResult {
  denied: boolean;
  denyReason: string | null;
  accessTokenClaims: Record<string, unknown>;
  idTokenClaims: Record<string, unknown>;
  appMetadata: Record<string, unknown>;
  /** post_login: what `api.session.setCustomData` attached to the session. */
  sessionData: Record<string, unknown>;
  /** `api.access.lock` reason (attempt triggers), or null. */
  lockReason: string | null;
  /** `api.challenge.set` (custom_challenge_create). */
  challenge: { prompt: string; hint: string | null; state: unknown } | null;
  /** `api.challenge.accept` (custom_challenge_verify): null until called. */
  challengeAccept: { amr: string[] } | null;
  /** `custom_token_exchange`: the user `api.exchange.setUser*` chose, or null. */
  exchangeSubject: ExchangeSubject | null;
  /** `pre_token`: claim names asked to be removed. */
  suppressedAccessClaims: string[];
  suppressedIdClaims: string[];
  /** `api.user.setBanned/setEmailVerified/setName/setImage`. */
  userEdits: {
    banned?: { value: boolean; reason: string | null };
    emailVerified?: boolean;
    firstName?: string | null;
    lastName?: string | null;
    imageUrl?: string | null;
  };
  /** Registration triggers: `api.signUp.prefill` / `modify`. */
  signUpPrefill: Record<string, string>;
  signUpModify: Record<string, string>;
  logs: string[];
  /** Requests queued with `api.http` (Atlas sends them after the flow; the harness never does). */
  httpRequests: HarnessHttpRequest[];
  /** Calls queued with `api.connector.send` (Atlas makes them after the flow; the harness never does). */
  connectorCalls: Array<{ name: string; operation: string; input: Record<string, unknown> }>;
  /** The handler's thrown error message, or `null` on clean completion. */
  error: string | null;
  /** Every api call in order — handy for asserting a sequence precisely. */
  calls: CapturedApiCall[];
}

/** One request queued with `api.http`, as the platform would send it. */
export interface HarnessHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body: string | null;
  saveResponseAs: string | null;
}

const HTTP_PER_RUN = 5;
const HTTP_URL_MAX = 2048;
const HTTP_HEADERS_MAX = 20;
const HTTP_HEADER_VALUE_MAX = 4096;
const HTTP_BODY_MAX = 64 * 1024;
const HTTP_FORBIDDEN = ['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'expect'];

const KEY_MAX = 256;
const REASON_MAX = 512;
const LOG_MAX = 2000;
const LOG_COUNT_MAX = 100;

function emptyResult(): ActionRunResult {
  return {
    denied: false,
    denyReason: null,
    accessTokenClaims: {},
    idTokenClaims: {},
    appMetadata: {},
    sessionData: {},
    lockReason: null,
    challenge: null,
    challengeAccept: null,
    exchangeSubject: null,
    suppressedAccessClaims: [],
    suppressedIdClaims: [],
    userEdits: {},
    signUpPrefill: {},
    signUpModify: {},
    logs: [],
    httpRequests: [],
    connectorCalls: [],
    error: null,
    calls: [],
  };
}

/** The same checks the isolate applies to `api.http` (it throws on a bad call). */
function queueHttp(
  result: ActionRunResult,
  method: 'GET' | 'POST',
  url: unknown,
  options: { headers?: unknown; body?: unknown; saveResponseAs?: unknown } = {},
): void {
  if (result.httpRequests.length >= HTTP_PER_RUN) {
    throw new RangeError(`api.http: at most ${HTTP_PER_RUN} requests per action run`);
  }
  const target = String(url);
  if (!/^https:\/\/[^\s]+$/i.test(target) || target.length > HTTP_URL_MAX) {
    throw new TypeError(`api.http: the url must be an https:// URL of at most ${HTTP_URL_MAX} characters`);
  }
  const headers: Record<string, string> = {};
  const lower = new Set<string>();
  if (options.headers != null) {
    if (typeof options.headers !== 'object' || Array.isArray(options.headers)) throw new TypeError('api.http: headers must be an object');
    const entries = Object.entries(options.headers as Record<string, unknown>);
    if (entries.length > HTTP_HEADERS_MAX) throw new RangeError(`api.http: at most ${HTTP_HEADERS_MAX} headers`);
    for (const [name, raw] of entries) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) throw new TypeError(`api.http: invalid header name ${name}`);
      if (HTTP_FORBIDDEN.includes(name.toLowerCase())) throw new TypeError(`api.http: the ${name} header is set by Atlas`);
      const value = String(raw);
      if (value.length > HTTP_HEADER_VALUE_MAX || /[\r\n]/.test(value)) throw new TypeError(`api.http: invalid value for header ${name}`);
      headers[name] = value;
      lower.add(name.toLowerCase());
    }
  }
  let body: string | null = null;
  if (options.body !== undefined && options.body !== null) {
    if (method === 'GET') throw new TypeError('api.http.get: a GET request has no body');
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    if (typeof options.body !== 'string' && !lower.has('content-type')) headers['content-type'] = 'application/json';
    if (body.length > HTTP_BODY_MAX) throw new RangeError(`api.http: the body is over ${HTTP_BODY_MAX} bytes`);
  }
  let saveResponseAs: string | null = null;
  if (options.saveResponseAs != null) {
    saveResponseAs = String(options.saveResponseAs);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(saveResponseAs)) {
      throw new TypeError('api.http: saveResponseAs must be a metadata key (letters, digits, _)');
    }
  }
  result.httpRequests.push({ method, url: target, headers, body, saveResponseAs });
}

/**
 * Build a mock `api` that records every call onto `result`, with the SAME
 * truncation and default-reason rules the real isolate applies. The full
 * surface is always built; the per-trigger types restrict what a handler may
 * reach at author time, while a raw script (via {@link runScript}) sees it all.
 */
export function createMockApi(result: ActionRunResult = emptyResult()): {
  api: PostLoginApi & PreUserRegistrationApi & PostUserRegistrationApi & AttemptApi & PreTokenApi & CustomTokenExchangeApi;
  result: ActionRunResult;
} {
  const key = (k: string) => String(k).slice(0, KEY_MAX);
  const api = {
    access: {
      deny(reason?: string) {
        result.denied = true;
        result.denyReason = (reason == null ? 'Access denied.' : String(reason)).slice(
          0,
          REASON_MAX,
        );
        result.calls.push({ method: 'access.deny', args: [reason] });
      },
      lock(reason?: string) {
        result.lockReason = (reason == null ? 'Account locked.' : String(reason)).slice(0, REASON_MAX);
        result.calls.push({ method: 'access.lock', args: [reason] });
      },
    },
    exchange: {
      setUserById(id: string) {
        result.exchangeSubject = { by: 'id', value: String(id).slice(0, 255), create: false };
        result.calls.push({ method: 'exchange.setUserById', args: [id] });
      },
      setUserByEmail(email: string, o?: { create?: boolean; externalId?: string; emailVerified?: boolean }) {
        result.exchangeSubject = {
          by: 'email',
          value: String(email).trim().toLowerCase().slice(0, 320),
          create: o?.create === true,
          ...(o?.externalId ? { externalId: String(o.externalId).slice(0, 255) } : {}),
          ...(o?.emailVerified === true ? { emailVerified: true } : {}),
        };
        result.calls.push({ method: 'exchange.setUserByEmail', args: [email, o] });
      },
      setUserByExternalId(externalId: string, o?: { create?: boolean; email?: string; emailVerified?: boolean }) {
        result.exchangeSubject = {
          by: 'external_id',
          value: String(externalId).trim().slice(0, 255),
          create: o?.create === true,
          ...(o?.email ? { email: String(o.email).trim().toLowerCase().slice(0, 320) } : {}),
          ...(o?.emailVerified === true ? { emailVerified: true } : {}),
        };
        result.calls.push({ method: 'exchange.setUserByExternalId', args: [externalId, o] });
      },
    },
    challenge: {
      set(c: { prompt: string; hint?: string; state?: unknown }) {
        result.challenge = { prompt: String(c.prompt).slice(0, 512), hint: c.hint == null ? null : String(c.hint).slice(0, 256), state: c.state ?? null };
        result.calls.push({ method: 'challenge.set', args: [c] });
      },
      accept(o?: { amr?: string[] }) {
        result.challengeAccept = { amr: Array.isArray(o?.amr) ? o!.amr!.slice(0, 5).map((a) => String(a).slice(0, 32)) : ['custom'] };
        result.calls.push({ method: 'challenge.accept', args: [o] });
      },
    },
    signUp: {
      prefill(field: string, value: string) {
        result.signUpPrefill[key(field)] = String(value).slice(0, 1024);
        result.calls.push({ method: 'signUp.prefill', args: [field, value] });
      },
      modify(field: string, value: string) {
        result.signUpModify[key(field)] = String(value).slice(0, 1024);
        result.calls.push({ method: 'signUp.modify', args: [field, value] });
      },
    },
    accessToken: {
      setCustomClaim(name: string, value: unknown) {
        result.accessTokenClaims[key(name)] = value;
        result.calls.push({ method: 'accessToken.setCustomClaim', args: [name, value] });
      },
      suppressClaim(name: string) {
        if (result.suppressedAccessClaims.length < 50) result.suppressedAccessClaims.push(key(name));
        result.calls.push({ method: 'accessToken.suppressClaim', args: [name] });
      },
    },
    idToken: {
      setCustomClaim(name: string, value: unknown) {
        result.idTokenClaims[key(name)] = value;
        result.calls.push({ method: 'idToken.setCustomClaim', args: [name, value] });
      },
      suppressClaim(name: string) {
        if (result.suppressedIdClaims.length < 50) result.suppressedIdClaims.push(key(name));
        result.calls.push({ method: 'idToken.suppressClaim', args: [name] });
      },
    },
    session: {
      setCustomData(name: string, value: unknown) {
        result.sessionData[String(name).slice(0, 64)] = value;
        result.calls.push({ method: 'session.setCustomData', args: [name, value] });
      },
    },
    user: {
      setAppMetadata(name: string, value: unknown) {
        result.appMetadata[key(name)] = value;
        result.calls.push({ method: 'user.setAppMetadata', args: [name, value] });
      },
      setBanned(banned: boolean, reason?: string) {
        result.userEdits.banned = { value: banned === true, reason: reason == null ? null : String(reason).trim().slice(0, REASON_MAX) || null };
        result.calls.push({ method: 'user.setBanned', args: [banned, reason] });
      },
      setEmailVerified(verified: boolean) {
        result.userEdits.emailVerified = verified === true;
        result.calls.push({ method: 'user.setEmailVerified', args: [verified] });
      },
      setName(firstName?: string | null, lastName?: string | null) {
        const clean = (v: string | null) => (v == null ? null : String(v).trim().slice(0, 255) || null);
        if (firstName !== undefined) result.userEdits.firstName = clean(firstName);
        if (lastName !== undefined) result.userEdits.lastName = clean(lastName);
        result.calls.push({ method: 'user.setName', args: [firstName, lastName] });
      },
      setImage(url: string | null) {
        const u = url == null ? null : String(url).trim().slice(0, 2048) || null;
        if (u !== null && !/^https:\/\/[^\s]+$/i.test(u)) throw new TypeError('api.user.setImage: the url must be an https:// URL');
        result.userEdits.imageUrl = u;
        result.calls.push({ method: 'user.setImage', args: [url] });
      },
    },
    http: {
      get(url: string, options?: { headers?: Record<string, string>; saveResponseAs?: string }) {
        result.calls.push({ method: 'http.get', args: [url, options] });
        queueHttp(result, 'GET', url, options ?? {});
      },
      post(url: string, body?: unknown, options?: { headers?: Record<string, string>; saveResponseAs?: string }) {
        result.calls.push({ method: 'http.post', args: [url, body, options] });
        queueHttp(result, 'POST', url, { ...(options ?? {}), body });
      },
    },
    connector: {
      send(name: string, operation: string, input?: Record<string, unknown>) {
        result.calls.push({ method: 'connector.send', args: [name, operation, input] });
        if (result.connectorCalls.length >= 5) throw new RangeError('api.connector.send: at most 5 calls per action run');
        if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(String(name))) throw new TypeError('api.connector.send: name is the connector name you gave it');
        if (!/^[a-z_]{1,64}$/.test(String(operation))) throw new TypeError('api.connector.send: operation is an operation of the connector, e.g. send_sms');
        if (input != null && (typeof input !== 'object' || Array.isArray(input))) throw new TypeError('api.connector.send: input must be an object');
        result.connectorCalls.push({ name: String(name), operation: String(operation), input: JSON.parse(JSON.stringify(input ?? {})) });
      },
    },
    console: {
      log(...args: unknown[]) {
        if (result.logs.length < LOG_COUNT_MAX) {
          const line = args
            .map((a) => {
              try {
                return typeof a === 'string' ? a : JSON.stringify(a);
              } catch {
                return String(a);
              }
            })
            .join(' ')
            .slice(0, LOG_MAX);
          result.logs.push(line);
        }
        result.calls.push({ method: 'console.log', args });
      },
    },
  };
  return { api, result };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The stand-in event for a trigger, matching the defaults the server's `/test`
 * dry-run uses. `overrides` is merged one level deep for `user`, `connection`,
 * `request` and `secrets`, so a test can set just the field it cares about.
 */
export function createTestEvent<T extends ActionTrigger>(
  trigger: T,
  overrides: DeepPartialEvent = {},
): EventForTrigger<T> {
  const base = {
    user: {
      id: trigger === 'pre_user_registration' ? null : 'user_sample',
      email: 'sample@example.com',
      emailVerified: true,
      firstName: 'Sample',
      lastName: 'User',
      username: 'sample',
      metadata: {} as Record<string, unknown>,
      organizations: [] as Array<{ id: string; slug: string; name: string; role: string }>,
    },
    connection: { strategy: 'password' },
    request: { ip: '198.51.100.10', userAgent: 'atlas-actions-harness', country: null as string | null },
    context: { trigger } as Record<string, unknown>,
    signUpFields: {} as Record<string, string>,
    secrets: {} as Record<string, string>,
  };

  const o = overrides as DeepPartialEvent;
  if (isObject(o.user)) Object.assign(base.user, o.user);
  if (isObject(o.connection)) Object.assign(base.connection, o.connection);
  if (isObject(o.request)) Object.assign(base.request, o.request);
  if (isObject(o.secrets)) Object.assign(base.secrets, o.secrets);
  if (isObject(o.context)) Object.assign(base.context, o.context);
  if (isObject(o.signUpFields)) Object.assign(base.signUpFields, o.signUpFields);
  if (isObject(o.organization)) Object.assign(base, { organization: o.organization });

  return base as unknown as EventForTrigger<T>;
}

/** The loose override shape accepted by {@link createTestEvent}. */
export interface DeepPartialEvent {
  user?: Partial<EventForTrigger<ActionTrigger>['user']> & Record<string, unknown>;
  connection?: { strategy?: string | null };
  request?: { ip?: string | null; userAgent?: string | null; country?: string | null };
  secrets?: Record<string, string>;
  /** `event.context` for the trigger (token type, changed fields, MFA result, …). */
  context?: Record<string, unknown>;
  /** Registration triggers: the typed sign-up field values. */
  signUpFields?: Record<string, string>;
  /** Organization triggers. */
  organization?: { id: string | null; name: string; slug: string };
}

/** A bare handler whose param types the caller need not pin — the escape hatch. */
export type LooseHandler = (event: never, api: never) => void | Promise<void>;

/**
 * Run a handler (or a defined action) against a mock event and capture what it
 * did. Never throws: a handler that throws resolves with `result.error` set,
 * mirroring the fail-safe the host applies around the real isolate.
 *
 * Two call shapes, via overloads:
 *   - `runAction(definedAction, event)` — fully typed; the trigger (hence the
 *     event/api types) is taken straight off `definedAction.trigger`, so a
 *     mismatched event is a compile error.
 *   - `runAction(handler, event)` — a bare handler (e.g. a template's
 *     `.handler`); accepted loosely, since a conditional event type cannot drive
 *     inference back onto a function parameter.
 */
export async function runAction<T extends ActionTrigger>(
  action: DefinedAction<T>,
  event: EventForTrigger<T>,
): Promise<ActionRunResult>;
export async function runAction(
  handler: LooseHandler,
  event: EventForTrigger<ActionTrigger>,
): Promise<ActionRunResult>;
export async function runAction(
  runnable: AnyDefinedAction | LooseHandler,
  event: EventForTrigger<ActionTrigger>,
): Promise<ActionRunResult> {
  const { api, result } = createMockApi();
  const handler: LooseHandler = typeof runnable === 'function' ? runnable : runnable.handler;
  try {
    await (handler as (event: unknown, api: unknown) => void | Promise<void>)(event, api);
  } catch (err) {
    result.error = (err instanceof Error ? err.message : String(err)).slice(0, REASON_MAX);
  }
  return result;
}

// The AsyncFunction constructor — runs a deployable script body (the `code`
// string Atlas stores) with `event`/`api` in scope, the way the isolate does,
// but in-process. Derived at module load so no `node:vm` import is needed.
const AsyncFunction = Object.getPrototypeOf(async function () {
  /* noop */
}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

/**
 * Host globals the real isolate does NOT expose. `new Function` bodies run in
 * the host's global scope (unlike a V8 isolate), so a tenant script could
 * otherwise reach Node's `console`, `require`, `process`, `fetch`, etc. — which
 * would make the harness pass code that FAILS once deployed. We shadow each to
 * `undefined` as a function parameter, so referencing-and-using one throws here
 * the way it is simply absent there. (This is best-effort fidelity, not a
 * security boundary — the isolate is the boundary; the harness is a test aid.)
 */
const SHADOWED_GLOBALS = [
  'console',
  'require',
  'process',
  'fetch',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'globalThis',
  'window',
  'self',
  'Buffer',
  'module',
  'exports',
  '__dirname',
  '__filename',
];

/**
 * Run a raw action `code` string — the exact body Atlas stores and deploys —
 * against a mock event. This is what `atlas actions test <file>` uses: it lets
 * a tenant dry-run the deployable artifact offline, and it proves a
 * `defineAction(...).toCode()` round-trips to the same result the handler gave.
 *
 * The script sees `event` and `api`; the common host globals the isolate omits
 * are shadowed to `undefined`, so using `console`/`require`/`fetch` throws and
 * is captured into `result.error` — mirroring how those are unavailable in
 * production. Use `api.console.log` for logging.
 */
export async function runScript(
  code: string,
  event: EventForTrigger<ActionTrigger>,
): Promise<ActionRunResult> {
  const { api, result } = createMockApi();
  try {
    const fn = new AsyncFunction('event', 'api', ...SHADOWED_GLOBALS, code);
    await fn(event, api, ...SHADOWED_GLOBALS.map(() => undefined));
  } catch (err) {
    result.error = (err instanceof Error ? err.message : String(err)).slice(0, REASON_MAX);
  }
  return result;
}

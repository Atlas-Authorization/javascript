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
  PreUserRegistrationApi,
  PostUserRegistrationApi,
} from './types';

/** One recorded api call, in the order it was made. */
export interface CapturedApiCall {
  method:
    | 'access.deny'
    | 'accessToken.setCustomClaim'
    | 'idToken.setCustomClaim'
    | 'user.setAppMetadata'
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
  logs: string[];
  /** The handler's thrown error message, or `null` on clean completion. */
  error: string | null;
  /** Every api call in order — handy for asserting a sequence precisely. */
  calls: CapturedApiCall[];
}

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
    logs: [],
    error: null,
    calls: [],
  };
}

/**
 * Build a mock `api` that records every call onto `result`, with the SAME
 * truncation and default-reason rules the real isolate applies. The full
 * surface is always built; the per-trigger types restrict what a handler may
 * reach at author time, while a raw script (via {@link runScript}) sees it all.
 */
export function createMockApi(result: ActionRunResult = emptyResult()): {
  api: PostLoginApi & PreUserRegistrationApi & PostUserRegistrationApi;
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
    },
    accessToken: {
      setCustomClaim(name: string, value: unknown) {
        result.accessTokenClaims[key(name)] = value;
        result.calls.push({ method: 'accessToken.setCustomClaim', args: [name, value] });
      },
    },
    idToken: {
      setCustomClaim(name: string, value: unknown) {
        result.idTokenClaims[key(name)] = value;
        result.calls.push({ method: 'idToken.setCustomClaim', args: [name, value] });
      },
    },
    user: {
      setAppMetadata(name: string, value: unknown) {
        result.appMetadata[key(name)] = value;
        result.calls.push({ method: 'user.setAppMetadata', args: [name, value] });
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
    },
    connection: { strategy: 'password' },
    request: { ip: '198.51.100.10', userAgent: 'atlas-actions-harness' },
    secrets: {} as Record<string, string>,
  };

  const o = overrides as DeepPartialEvent;
  if (isObject(o.user)) Object.assign(base.user, o.user);
  if (isObject(o.connection)) Object.assign(base.connection, o.connection);
  if (isObject(o.request)) Object.assign(base.request, o.request);
  if (isObject(o.secrets)) Object.assign(base.secrets, o.secrets);

  return base as unknown as EventForTrigger<T>;
}

/** The loose override shape accepted by {@link createTestEvent}. */
export interface DeepPartialEvent {
  user?: Partial<EventForTrigger<ActionTrigger>['user']> & Record<string, unknown>;
  connection?: { strategy?: string | null };
  request?: { ip?: string | null; userAgent?: string | null };
  secrets?: Record<string, string>;
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

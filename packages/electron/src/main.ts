import {
  SignOutGuard,
  resolveFrontendApi,
  type FapiRequest,
  type SignOutAttempt,
  type SignOutOptions,
  type SignOutResult,
  type TombstoneStore,
} from '@atlasauth/js';
import {
  ATLAS_TOKEN_CHANNELS,
  DEFAULT_TOKEN_KEY,
  type IpcMainInvokeEventLike,
  type IpcMainLike,
  type SignOutReply,
} from './shared';
import { createInMemoryTokenStorage, type TokenStorage } from './storage';

/**
 * MAIN-process setup.
 *
 * `createAtlasBridge` is the one call an Electron app makes from its main
 * process. It wires the token cache to three `ipcMain` handlers — the renderer's
 * only path to the token — and hands back a `getToken` the main process itself
 * can use (e.g. to attach the bearer to a `net.request`, or to gate a window).
 *
 * The renderer never sees the storage: it can ask for the token, replace it, or
 * clear it, and nothing more. That is the whole security posture of this package
 * expressed in an API — the token lives here, behind whatever OS-backed
 * {@link TokenStorage} the app supplied.
 */

export interface CreateAtlasBridgeOptions {
  /** The real Electron `ipcMain` (structurally typed; see `./shared`). */
  ipcMain: IpcMainLike;
  /**
   * Where the session token is kept. Defaults to a non-persistent in-memory
   * cache — fine for tests, but ship `createTokenStorage(...)` in production so
   * the session survives a restart.
   */
  storage?: TokenStorage;
  /**
   * The key the single session token is stored under.
   * @default 'atlas.session'
   */
  tokenKey?: string;
  /**
   * Optional sender guard. Return false to reject an IPC call — an app can, for
   * example, allow only its top-level window's main frame, rejecting `<webview>`
   * guests that happen to share the preload. When omitted, all senders pass.
   */
  validateSender?: (event: IpcMainInvokeEventLike) => boolean;
  /**
   * The instance's Frontend API as an absolute URL, e.g.
   * `"https://auth.example.com"` — what `signOut()` revokes the session on.
   * Without it (and {@link publishableKey}) `signOut()` can only clear the
   * token, and reports `revoked: false`.
   */
  frontendApi?: string;
  /** The publishable key, sent with the revoke. */
  publishableKey?: string;
  /** Injectable for tests; defaults to the main process's `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Delays (ms) between background re-tries of a revoke `signOut()` could not
   * complete. Default `[15_000, 60_000, 300_000]`.
   */
  signOutRetryDelaysMs?: number[];
}

export interface AtlasBridge {
  /** Read the current session token from the main-process storage. */
  getToken(): Promise<string | null>;
  /** Persist a session token (main-side). */
  setToken(token: string): Promise<void>;
  /** Clear the session token (main-side). */
  clearToken(): Promise<void>;
  /**
   * Sign out (main-side): revoke the session on the Frontend API (retried
   * once) with the stored token, then clear it. Resolves `{ revoked,
   * activeSessionId? }`; `{ strict: true }` rejects with a `SignOutError` —
   * after the token is cleared — when the revoke was not confirmed. The
   * session id is remembered in {@link CreateAtlasBridgeOptions.storage}, so
   * a token for it is never handed out (or stored) again, even after a
   * restart; its revoke is re-tried in the background with the dropped token.
   *
   * `activeSessionId` is reported when the server names a promoted session,
   * but not adopted: a bearer client receives no token for it.
   */
  signOut(options?: SignOutOptions): Promise<SignOutResult>;
  /** Remove the IPC handlers this bridge registered (and cancel re-tries). Call on teardown. */
  cleanup(): void;
}

export function createAtlasBridge(options: CreateAtlasBridgeOptions): AtlasBridge {
  const { ipcMain } = options;
  const storage = options.storage ?? createInMemoryTokenStorage();
  const tokenKey = options.tokenKey ?? DEFAULT_TOKEN_KEY;
  const validateSender = options.validateSender;

  const guard = (event: IpcMainInvokeEventLike): void => {
    if (validateSender && !validateSender(event)) {
      throw new Error('Atlas: token-cache IPC call was rejected by validateSender.');
    }
  };

  // Tombstones live in the same main-process storage as the token (session
  // ids only — not a secret), so a restart still refuses a signed-out session.
  const tombstoneStore: TombstoneStore = {
    getItem: (key) => storage.get(key),
    setItem: (key, value) => storage.set(key, value),
  };
  const frontendApi = options.frontendApi
    ? resolveFrontendApi(options.frontendApi, { component: 'createAtlasBridge()', allowSameOrigin: false })
    : undefined;
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  /** A raw FAPI request authenticated with `token` — not the stored one, which sign-out drops. */
  const requestWith =
    (token: string | null): FapiRequest =>
    (path, init = {}) => {
      if (!frontendApi || !options.publishableKey) {
        return Promise.reject(new Error('Atlas: createAtlasBridge() needs frontendApi and publishableKey to revoke.'));
      }
      const headers = new Headers(init.headers);
      headers.set('x-publishable-key', options.publishableKey);
      if (token) headers.set('authorization', `Bearer ${token}`);
      return fetchImpl(`${frontendApi}${path}`, { ...init, headers });
    };
  const signOutGuard = new SignOutGuard({
    request: (path, init) => Promise.resolve(storage.get(tokenKey)).then((token) => requestWith(token)(path, init)),
    frontendApi,
    store: tombstoneStore,
    // The main process has no DOM to load front-channel logout frames in.
    frontChannelLogout: false,
    ...(options.signOutRetryDelaysMs ? { retryDelaysMs: options.signOutRetryDelaysMs } : {}),
  });

  const getToken = async (): Promise<string | null> => {
    // Persisted tombstones first: on a cold start they are read from storage.
    await signOutGuard.ready;
    const token = await storage.get(tokenKey);
    // A token for a session this app signed out of is refused (and dropped) —
    // this is the boot path, since every renderer starts by reading the token.
    if (token && signOutGuard.refuse(sessionIdOf(token), requestWith(token))) {
      await storage.remove(tokenKey);
      return null;
    }
    return token;
  };
  const setToken = async (token: string): Promise<void> => {
    await signOutGuard.ready;
    // A late write (an in-flight refresh) must not resurrect a signed-out session.
    if (signOutGuard.isSignedOut(sessionIdOf(token))) return;
    await storage.set(tokenKey, token);
  };
  const clearToken = (): Promise<void> => Promise.resolve(storage.remove(tokenKey));

  /** The revoke + local clear, without `strict` (the caller decides how to report it). */
  const signOutAttempt = async (): Promise<SignOutAttempt> => {
    await signOutGuard.ready;
    let token: string | null = null;
    try {
      token = await storage.get(tokenKey);
    } catch {
      token = null;
    }
    // No token: this app holds no credential, so there is no session to end.
    const attempt: SignOutAttempt = token
      ? await signOutGuard.revoke(sessionIdOf(token), { request: requestWith(token) })
      : { sessionId: null, outcome: { revoked: true, status: 200 } };
    try {
      await clearToken();
    } catch {
      // The tombstone still keeps the token from being handed out again.
    }
    return attempt;
  };

  const signOut = async (signOutOptions: SignOutOptions = {}): Promise<SignOutResult> =>
    signOutGuard.settle(await signOutAttempt(), signOutOptions);

  ipcMain.handle(ATLAS_TOKEN_CHANNELS.get, (event) => {
    guard(event);
    return getToken();
  });

  ipcMain.handle(ATLAS_TOKEN_CHANNELS.set, (event, token) => {
    guard(event);
    if (typeof token !== 'string') {
      throw new Error('Atlas: setToken expects a string token.');
    }
    return setToken(token);
  });

  ipcMain.handle(ATLAS_TOKEN_CHANNELS.remove, (event) => {
    guard(event);
    return clearToken();
  });

  // Never rejects for a failed revoke: an error crossing IPC arrives as a bare
  // message, so the reply carries the facts and the renderer's `signOut()`
  // re-creates the `SignOutError` itself.
  ipcMain.handle(ATLAS_TOKEN_CHANNELS.signOut, async (event): Promise<SignOutReply> => {
    guard(event);
    const attempt = await signOutAttempt();
    const result = signOutGuard.settle(attempt);
    return { ...result, sessionId: attempt.sessionId, status: attempt.outcome.status };
  });

  return {
    getToken,
    setToken,
    clearToken,
    signOut,
    cleanup() {
      ipcMain.removeHandler(ATLAS_TOKEN_CHANNELS.get);
      ipcMain.removeHandler(ATLAS_TOKEN_CHANNELS.set);
      ipcMain.removeHandler(ATLAS_TOKEN_CHANNELS.remove);
      ipcMain.removeHandler(ATLAS_TOKEN_CHANNELS.signOut);
      signOutGuard.dispose();
    },
  };
}

/** The `sid` claim of a session JWT (unverified — only to name the session), or null. */
function sessionIdOf(token: string | null): string | null {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { sid?: unknown };
    return typeof claims.sid === 'string' && claims.sid ? claims.sid : null;
  } catch {
    return null;
  }
}

import {
  ATLAS_TOKEN_CHANNELS,
  DEFAULT_TOKEN_KEY,
  type IpcMainInvokeEventLike,
  type IpcMainLike,
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
}

export interface AtlasBridge {
  /** Read the current session token from the main-process storage. */
  getToken(): Promise<string | null>;
  /** Persist a session token (main-side). */
  setToken(token: string): Promise<void>;
  /** Clear the session token (main-side). */
  clearToken(): Promise<void>;
  /** Remove the IPC handlers this bridge registered. Call on teardown. */
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

  const getToken = (): Promise<string | null> => Promise.resolve(storage.get(tokenKey));
  const setToken = (token: string): Promise<void> => Promise.resolve(storage.set(tokenKey, token));
  const clearToken = (): Promise<void> => Promise.resolve(storage.remove(tokenKey));

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

  return {
    getToken,
    setToken,
    clearToken,
    cleanup() {
      ipcMain.removeHandler(ATLAS_TOKEN_CHANNELS.get);
      ipcMain.removeHandler(ATLAS_TOKEN_CHANNELS.set);
      ipcMain.removeHandler(ATLAS_TOKEN_CHANNELS.remove);
    },
  };
}

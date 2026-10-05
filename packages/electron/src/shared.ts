/**
 * Shapes and constants shared by the three sides of the Electron bridge — the
 * MAIN process (`./main`), the PRELOAD script (`./preload`) and the RENDERER
 * (`./renderer`).
 *
 * The whole reason this package exists: an Electron renderer is a web page, but
 * it is NOT served from the Atlas FAPI origin, so it has no cookie to carry the
 * session — and a renderer has no business holding the raw session token in the
 * first place. So the token lives in the MAIN process (behind OS-level secure
 * storage) and the renderer reaches it only through a narrow IPC bridge. This
 * module defines that contract in one place so all three sides agree on it.
 *
 * ── Why the Electron types are declared here, structurally ────────────────────
 * `electron` is a peer the consuming app installs; this package must compile,
 * typecheck and test WITHOUT it. So instead of `import type { IpcMain } from
 * 'electron'`, we declare the minimal `ipcMain` / `ipcRenderer` / `contextBridge`
 * / `safeStorage` surfaces we actually touch. At runtime the app passes in the
 * real Electron objects, which are structurally compatible; at build time there
 * is no dependency on `electron` at all.
 */

/** IPC channel names. One per token-cache operation, namespaced to avoid clashes. */
export const ATLAS_TOKEN_CHANNELS = {
  get: 'atlas:token:get',
  set: 'atlas:token:set',
  remove: 'atlas:token:remove',
} as const;

/**
 * The property the preload script hangs the bridge off in the renderer's
 * `window`. The renderer helper reads `window.atlas` to find it.
 */
export const ATLAS_BRIDGE_KEY = 'atlas' as const;

/** The default storage key the bridge binds to for the single session token. */
export const DEFAULT_TOKEN_KEY = 'atlas.session';

/**
 * The bridge as the renderer sees it (`window.atlas`). Three async methods —
 * the renderer can read, write and clear the session token, but never touches
 * where it is stored. Every call is a Promise because it crosses the IPC gap.
 */
export interface AtlasTokenBridge {
  /** The current session token, or null when signed out. */
  getToken(): Promise<string | null>;
  /** Persist a session token (after a completed sign-in). */
  setToken(token: string): Promise<void>;
  /** Drop the session token (sign-out, or a rejected session). */
  clearToken(): Promise<void>;
}

// ── Structural Electron shapes (see file header) ─────────────────────────────

/** The `event` Electron hands an `ipcMain.handle` listener. Opaque here. */
export interface IpcMainInvokeEventLike {
  readonly senderFrame?: unknown;
}

/** The subset of Electron's `ipcMain` the bridge uses. */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEventLike, ...args: unknown[]) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

/** The subset of Electron's `ipcRenderer` the preload uses. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

/** The subset of Electron's `contextBridge` the preload uses. */
export interface ContextBridgeLike {
  exposeInMainWorld(apiKey: string, api: unknown): void;
}

/**
 * The subset of Electron's `safeStorage` the default token storage uses. Backed
 * by the OS keystore (Keychain / DPAPI / libsecret) in a real Electron app.
 * `encryptString` returns a Node `Buffer`; we only ever base64-encode it, hence
 * the narrowed return type. `decryptString` takes that Buffer back — see
 * {@link safeStorageCipher} for how the base64 is rehydrated without pulling in
 * Node's `Buffer` type.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): { toString(encoding: 'base64'): string };
  decryptString(encrypted: unknown): string;
}

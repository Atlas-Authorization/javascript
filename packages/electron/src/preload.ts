import {
  ATLAS_BRIDGE_KEY,
  ATLAS_TOKEN_CHANNELS,
  type AtlasTokenBridge,
  type ContextBridgeLike,
  type IpcRendererLike,
  type SignOutReply,
  type SignOutRequest,
} from './shared';

/**
 * PRELOAD-script helper.
 *
 * A preload script is the one place that can see both Node/Electron APIs and the
 * renderer's `window`, so it is where the bridge is published. `exposeAtlasBridge`
 * uses `contextBridge` to hang a narrow, promise-only API on `window.atlas`
 * (see {@link ATLAS_BRIDGE_KEY}) — four methods that each forward to an
 * `ipcMain` handler registered by `createAtlasBridge` in the main process.
 *
 * Using `contextBridge` (rather than assigning `window.atlas` directly) is what
 * keeps context isolation intact: the renderer gets the functions, not a handle
 * into the preload's Node realm.
 *
 * @example
 * ```ts
 * // preload.ts
 * import { contextBridge, ipcRenderer } from 'electron';
 * import { exposeAtlasBridge } from '@atlasauth/electron/preload';
 *
 * exposeAtlasBridge({ contextBridge, ipcRenderer });
 * ```
 */
export interface ExposeAtlasBridgeOptions {
  /** The real Electron `contextBridge` (structurally typed; see `./shared`). */
  contextBridge: ContextBridgeLike;
  /** The real Electron `ipcRenderer` (structurally typed; see `./shared`). */
  ipcRenderer: IpcRendererLike;
}

export function exposeAtlasBridge(options: ExposeAtlasBridgeOptions): void {
  const { contextBridge, ipcRenderer } = options;

  const bridge: AtlasTokenBridge = {
    getToken: () =>
      ipcRenderer.invoke(ATLAS_TOKEN_CHANNELS.get) as Promise<string | null>,
    setToken: (token: string) =>
      ipcRenderer.invoke(ATLAS_TOKEN_CHANNELS.set, token) as Promise<void>,
    clearToken: () => ipcRenderer.invoke(ATLAS_TOKEN_CHANNELS.remove) as Promise<void>,
    // Plain data both ways (the reply never carries a token); the renderer's
    // `signOut()` turns the reply into a SignOutResult / SignOutError.
    signOut: (options?: SignOutRequest) =>
      ipcRenderer.invoke(
        ATLAS_TOKEN_CHANNELS.signOut,
        options?.frontchannel === undefined ? {} : { frontchannel: options.frontchannel },
      ) as Promise<SignOutReply>,
  };

  contextBridge.exposeInMainWorld(ATLAS_BRIDGE_KEY, bridge);
}

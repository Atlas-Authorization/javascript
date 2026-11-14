# @atlasauth/electron

The Atlas SDK for Electron. The session token lives in the main process; the renderer never holds it.

- **Main process**: `createAtlasBridge({ ipcMain, storage, frontendApi, publishableKey })` registers the IPC handlers that read, store and clear the token and run a main-side `signOut()` (the revoke is retried in the background if it could not complete). Use `createTokenStorage(...)` for a token that survives a restart; the default is an in-memory cache for tests. `validateSender` lets you accept calls only from your top-level window.
- **Preload** (`@atlasauth/electron/preload`): `exposeAtlasBridge(...)` hands the renderer a narrow token bridge.
- **Renderer**: `createAtlasClient(...)` is a Frontend API client that sends the bearer token through the bridge; `bearerFetch` and `signOut` are the building blocks.

```ts
// main.ts
import { ipcMain } from 'electron';
import { createAtlasBridge } from '@atlasauth/electron';

createAtlasBridge({ ipcMain, frontendApi: 'https://auth.example.com', publishableKey: 'pk_live_...' });
```

```ts
// preload.ts
import { contextBridge, ipcRenderer } from 'electron';
import { exposeAtlasBridge } from '@atlasauth/electron/preload';

exposeAtlasBridge({ contextBridge, ipcRenderer });
```

Sign-in itself runs through the system browser or a hosted page; the SDK only keeps and presents the resulting session token.

import { describe, expect, it, vi } from 'vitest';
import { createAtlasBridge } from './main';
import { ATLAS_TOKEN_CHANNELS, DEFAULT_TOKEN_KEY, type IpcMainInvokeEventLike, type IpcMainLike } from './shared';
import {
  createInMemoryTokenStorage,
  createTokenStorage,
  safeStorageCipher,
  type Cipher,
  type PersistentStore,
  type TokenStorage,
} from './storage';

// ── test doubles ─────────────────────────────────────────────────────────────

/** A synchronous in-memory PersistentStore (the `electron-store` shape). */
function fakeStore(): PersistentStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: (key) => data.get(key) ?? null,
    set: (key, value) => {
      data.set(key, value);
    },
    delete: (key) => {
      data.delete(key);
    },
  };
}

/** A reversible fake cipher — good enough to prove the enc:/raw: plumbing. */
const reversibleCipher: Cipher = {
  encrypt: (v) => `X${v}X`,
  decrypt: (c) => {
    if (!c.startsWith('X') || !c.endsWith('X')) throw new Error('bad ciphertext');
    return c.slice(1, -1);
  },
};

/**
 * A fake `ipcMain` that records handlers so a test can invoke them directly, the
 * way the renderer would over IPC — no Electron, no real IPC.
 */
function fakeIpcMain() {
  const handlers = new Map<string, (event: IpcMainInvokeEventLike, ...args: unknown[]) => unknown>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
  };
  // Mirror Electron's `ipcMain.handle`: a handler that throws synchronously is
  // surfaced to the caller as a rejected invoke promise, not a sync throw.
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({} as IpcMainInvokeEventLike, ...args);
  };
  return { ipcMain, handlers, invoke };
}

// ── TokenStorage: in-memory ──────────────────────────────────────────────────

describe('createInMemoryTokenStorage', () => {
  it('gets/sets/removes a value', async () => {
    const storage = createInMemoryTokenStorage();
    expect(await storage.get('k')).toBeNull();

    await storage.set('k', 'jwt-1');
    expect(await storage.get('k')).toBe('jwt-1');

    await storage.set('k', 'jwt-2');
    expect(await storage.get('k')).toBe('jwt-2');

    await storage.remove('k');
    expect(await storage.get('k')).toBeNull();
  });

  it('keeps keys independent', async () => {
    const storage = createInMemoryTokenStorage();
    await storage.set('a', '1');
    await storage.set('b', '2');
    await storage.remove('a');
    expect(await storage.get('a')).toBeNull();
    expect(await storage.get('b')).toBe('2');
  });
});

// ── TokenStorage: persistent + cipher ────────────────────────────────────────

describe('createTokenStorage', () => {
  it('encrypts at rest and round-trips through the cipher', async () => {
    const store = fakeStore();
    const storage = createTokenStorage({ store, cipher: reversibleCipher });

    await storage.set('atlas.session', 'jwt');
    expect(store.data.get('atlas.session')).toBe('enc:XjwtX'); // stored ciphertext, tagged
    expect(await storage.get('atlas.session')).toBe('jwt');

    await storage.remove('atlas.session');
    expect(await storage.get('atlas.session')).toBeNull();
  });

  it('returns null (not throw) for an undecryptable entry', async () => {
    const store = fakeStore();
    store.set('atlas.session', 'enc:not-valid-ciphertext');
    const storage = createTokenStorage({ store, cipher: reversibleCipher });
    expect(await storage.get('atlas.session')).toBeNull();
  });

  it('does not persist when no cipher and fallback is off', async () => {
    const store = fakeStore();
    const storage = createTokenStorage({ store, cipher: null });
    await storage.set('atlas.session', 'jwt');
    expect(store.data.has('atlas.session')).toBe(false);
    expect(await storage.get('atlas.session')).toBeNull();
  });

  it('persists raw: when no cipher and unencryptedFallback is on', async () => {
    const store = fakeStore();
    const storage = createTokenStorage({ store, cipher: null, unencryptedFallback: true });
    await storage.set('atlas.session', 'jwt');
    expect(store.data.get('atlas.session')).toBe('raw:jwt');
    expect(await storage.get('atlas.session')).toBe('jwt');
  });

  it('drops an entry with an unrecognised format', async () => {
    const store = fakeStore();
    store.set('atlas.session', 'garbage-without-prefix');
    const storage = createTokenStorage({ store, cipher: reversibleCipher });
    expect(await storage.get('atlas.session')).toBeNull();
    expect(store.data.has('atlas.session')).toBe(false);
  });
});

describe('safeStorageCipher', () => {
  it('returns null when OS encryption is unavailable', () => {
    const cipher = safeStorageCipher(
      {
        isEncryptionAvailable: () => false,
        encryptString: () => ({ toString: () => '' }),
        decryptString: () => '',
      },
      (b64) => b64,
    );
    expect(cipher).toBeNull();
  });

  it('base64-encodes on encrypt and rehydrates on decrypt', () => {
    const encryptString = vi.fn((v: string) => ({ toString: (_: 'base64') => `b64(${v})` }));
    const decryptString = vi.fn((buf: unknown) => `plain-of-${String(buf)}`);
    const fromBase64 = vi.fn((b64: string) => `buf(${b64})`);

    const cipher = safeStorageCipher(
      { isEncryptionAvailable: () => true, encryptString, decryptString },
      fromBase64,
    )!;

    expect(cipher.encrypt('jwt')).toBe('b64(jwt)');
    expect(encryptString).toHaveBeenCalledWith('jwt');

    expect(cipher.decrypt('b64(jwt)')).toBe('plain-of-buf(b64(jwt))');
    expect(fromBase64).toHaveBeenCalledWith('b64(jwt)');
  });
});

// ── the bridge handler logic ─────────────────────────────────────────────────

describe('createAtlasBridge', () => {
  it('registers a handler per token channel', () => {
    const { ipcMain, handlers } = fakeIpcMain();
    createAtlasBridge({ ipcMain, storage: createInMemoryTokenStorage() });
    expect(handlers.has(ATLAS_TOKEN_CHANNELS.get)).toBe(true);
    expect(handlers.has(ATLAS_TOKEN_CHANNELS.set)).toBe(true);
    expect(handlers.has(ATLAS_TOKEN_CHANNELS.remove)).toBe(true);
  });

  it('reads/writes/clears the token through storage via IPC', async () => {
    const { ipcMain, invoke } = fakeIpcMain();
    const storage = createInMemoryTokenStorage();
    createAtlasBridge({ ipcMain, storage });

    expect(await invoke(ATLAS_TOKEN_CHANNELS.get)).toBeNull();

    await invoke(ATLAS_TOKEN_CHANNELS.set, 'jwt');
    expect(await invoke(ATLAS_TOKEN_CHANNELS.get)).toBe('jwt');
    // stored under the default key
    expect(await storage.get(DEFAULT_TOKEN_KEY)).toBe('jwt');

    await invoke(ATLAS_TOKEN_CHANNELS.remove);
    expect(await invoke(ATLAS_TOKEN_CHANNELS.get)).toBeNull();
  });

  it('honours a custom tokenKey', async () => {
    const { ipcMain, invoke } = fakeIpcMain();
    const storage = createInMemoryTokenStorage();
    createAtlasBridge({ ipcMain, storage, tokenKey: 'my.key' });
    await invoke(ATLAS_TOKEN_CHANNELS.set, 'jwt');
    expect(await storage.get('my.key')).toBe('jwt');
  });

  it('exposes a main-side getToken/setToken/clearToken mirroring the IPC', async () => {
    const { ipcMain } = fakeIpcMain();
    const bridge = createAtlasBridge({ ipcMain, storage: createInMemoryTokenStorage() });
    expect(await bridge.getToken()).toBeNull();
    await bridge.setToken('jwt');
    expect(await bridge.getToken()).toBe('jwt');
    await bridge.clearToken();
    expect(await bridge.getToken()).toBeNull();
  });

  it('rejects a non-string token on set', async () => {
    const { ipcMain, invoke } = fakeIpcMain();
    createAtlasBridge({ ipcMain, storage: createInMemoryTokenStorage() });
    await expect(invoke(ATLAS_TOKEN_CHANNELS.set, 123)).rejects.toThrow(/string token/);
  });

  it('enforces validateSender', async () => {
    const { ipcMain, invoke } = fakeIpcMain();
    createAtlasBridge({
      ipcMain,
      storage: createInMemoryTokenStorage(),
      validateSender: () => false,
    });
    await expect(invoke(ATLAS_TOKEN_CHANNELS.get)).rejects.toThrow(/validateSender/);
  });

  it('cleanup removes every handler', () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const bridge = createAtlasBridge({ ipcMain, storage: createInMemoryTokenStorage() });
    bridge.cleanup();
    expect(handlers.size).toBe(0);
  });

  it('bridges a persistent encrypted storage end to end', async () => {
    const { ipcMain, invoke } = fakeIpcMain();
    const store = fakeStore();
    const storage: TokenStorage = createTokenStorage({ store, cipher: reversibleCipher });
    createAtlasBridge({ ipcMain, storage });

    await invoke(ATLAS_TOKEN_CHANNELS.set, 'jwt');
    expect(store.data.get(DEFAULT_TOKEN_KEY)).toBe('enc:XjwtX');
    expect(await invoke(ATLAS_TOKEN_CHANNELS.get)).toBe('jwt');
  });
});

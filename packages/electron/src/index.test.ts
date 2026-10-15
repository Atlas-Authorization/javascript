import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignOutError } from '@atlasauth/js';
import { createAtlasBridge, type AtlasBridge } from './main';
import { exposeAtlasBridge } from './preload';
import { signOut } from './renderer';
import {
  ATLAS_TOKEN_CHANNELS,
  DEFAULT_TOKEN_KEY,
  type AtlasTokenBridge,
  type IpcMainInvokeEventLike,
  type IpcMainLike,
} from './shared';
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
    expect(handlers.has(ATLAS_TOKEN_CHANNELS.signOut)).toBe(true);
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

// ── sign-out (main revokes; renderer re-creates SignOutError) ────────────────

const FRONTEND = 'https://fapi.example.test';
const b64 = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwtFor = (sid: string) => `${b64({ alg: 'none' })}.${b64({ sid, sub: 'user_1', exp: 9999999999 })}.sig`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { method: string; path: string; auth: string | null; pk: string | null };

const bridges: AtlasBridge[] = [];
afterEach(() => {
  for (const b of bridges.splice(0)) b.cleanup();
});

/**
 * A main-process bridge with a fake FAPI, plus the renderer's view of it: the
 * real preload over a fake `ipcRenderer` that structured-clones like Electron
 * (so a thrown error would lose its class, exactly as in the real app).
 */
function signOutRig(
  route: (method: string, path: string, auth: string | null) => Response | undefined,
  storage: TokenStorage = createInMemoryTokenStorage(),
  extra: { signOutRetryDelaysMs?: number[]; frontendApi?: string | undefined } = {},
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization');
    calls.push({ method, path: url.pathname, auth, pk: headers.get('x-publishable-key') });
    return route(method, url.pathname, auth) ?? json(null, 404);
  }) as typeof fetch;
  const { ipcMain, invoke } = fakeIpcMain();
  const main = createAtlasBridge({
    ipcMain,
    storage,
    publishableKey: 'pk_test_123',
    frontendApi: 'frontendApi' in extra ? extra.frontendApi : FRONTEND,
    fetchImpl,
    ...(extra.signOutRetryDelaysMs ? { signOutRetryDelaysMs: extra.signOutRetryDelaysMs } : {}),
  });
  bridges.push(main);
  let bridge = null as AtlasTokenBridge | null;
  exposeAtlasBridge({
    contextBridge: {
      exposeInMainWorld: (_key, api) => {
        bridge = api as AtlasTokenBridge;
      },
    },
    ipcRenderer: {
      invoke: async (channel, ...args) => {
        try {
          return structuredClone(await invoke(channel, ...structuredClone(args)));
        } catch (e) {
          // Electron delivers only the message of an error thrown in a handler.
          throw new Error(`Error invoking remote method '${channel}': ${String(e)}`);
        }
      },
    },
  });
  return { main, bridge: bridge!, calls, storage };
}

const revokes = (calls: Call[]) => calls.filter((c) => c.path.endsWith('/revoke'));

describe('sign-out', () => {
  it('revokes with the stored token, clears it, and resolves { revoked: true } in the renderer', async () => {
    const token = jwtFor('sess_1');
    const rig = signOutRig((method, path) =>
      method === 'POST' && path === '/v1/client/sessions/sess_1/revoke' ? json({ status: 'revoked' }) : undefined,
    );
    await rig.bridge.setToken(token);

    await expect(signOut({ bridge: rig.bridge })).resolves.toEqual({ revoked: true });

    expect(revokes(rig.calls)).toHaveLength(1);
    expect(revokes(rig.calls)[0]).toMatchObject({ auth: `Bearer ${token}`, pk: 'pk_test_123' });
    expect(await rig.bridge.getToken()).toBeNull();
  });

  it('a failed revoke (503 twice) still clears the token, resolves { revoked: false }, and the token is never handed out again', async () => {
    const token = jwtFor('sess_1');
    const rig = signOutRig(
      (method, path) => (path.endsWith('/revoke') ? json({}, 503) : undefined),
      createInMemoryTokenStorage(),
      { signOutRetryDelaysMs: [5] },
    );
    await rig.bridge.setToken(token);

    await expect(signOut({ bridge: rig.bridge })).resolves.toEqual({ revoked: false });
    expect(revokes(rig.calls)).toHaveLength(2);
    expect(await rig.bridge.getToken()).toBeNull();
    // The background re-try authenticates with the token sign-out dropped.
    await expect.poll(() => revokes(rig.calls).length).toBe(3);
    expect(revokes(rig.calls)[2]?.auth).toBe(`Bearer ${token}`);

    // A late write (an in-flight refresh) does not resurrect it…
    await rig.bridge.setToken(token);
    expect(await rig.bridge.getToken()).toBeNull();
    // …nor does a token that reached storage some other way.
    await rig.storage.set(DEFAULT_TOKEN_KEY, token);
    expect(await rig.bridge.getToken()).toBeNull();
    expect(await rig.storage.get(DEFAULT_TOKEN_KEY)).toBeNull();
    // A new sign-in (another session) is accepted.
    await rig.bridge.setToken(jwtFor('sess_2'));
    expect(await rig.bridge.getToken()).toBe(jwtFor('sess_2'));
  });

  it('after a restart the persisted tombstone refuses the token; its background revoke clears the tombstone', async () => {
    const token = jwtFor('sess_1');
    const store = fakeStore();
    const storage = createTokenStorage({ store, cipher: reversibleCipher });
    let revokeWorks = false;
    const route = (method: string, path: string) =>
      path.endsWith('/sessions/sess_1/revoke') ? (revokeWorks ? json({ status: 'revoked' }) : json({}, 503)) : undefined;
    const first = signOutRig(route, storage);
    await first.bridge.setToken(token);
    await signOut({ bridge: first.bridge });
    first.main.cleanup();

    // Relaunch with the token back in storage (a clear that never reached disk).
    await storage.set(DEFAULT_TOKEN_KEY, token);
    revokeWorks = true;
    const relaunched = signOutRig(route, storage);
    expect(await relaunched.bridge.getToken()).toBeNull();
    await expect.poll(() => revokes(relaunched.calls).length).toBe(1);
    expect(revokes(relaunched.calls)[0]?.auth).toBe(`Bearer ${token}`);
    await expect
      .poll(async () => JSON.parse((await storage.get(`atlas:signed-out-sessions:${FRONTEND}`)) ?? '[]').length)
      .toBe(0);

    // Tombstone gone: a third launch accepts the token again.
    await storage.set(DEFAULT_TOKEN_KEY, token);
    const third = signOutRig(route, storage);
    expect(await third.bridge.getToken()).toBe(token);
  });

  it('{ strict: true } rejects with a real SignOutError in the renderer, after the token is cleared', async () => {
    const rig = signOutRig((method, path) => (path.endsWith('/revoke') ? json({}, 503) : undefined));
    await rig.bridge.setToken(jwtFor('sess_1'));

    const error = await signOut({ bridge: rig.bridge, strict: true }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SignOutError);
    expect(error).toMatchObject({ code: 'SIGN_OUT_REVOKE_FAILED', sessionId: 'sess_1', status: 503 });
    expect(await rig.bridge.getToken()).toBeNull();
  });

  it('main-side signOut({ strict: true }) rejects with SignOutError too', async () => {
    const rig = signOutRig(() => json({}, 503));
    await rig.main.setToken(jwtFor('sess_1'));
    await expect(rig.main.signOut({ strict: true })).rejects.toBeInstanceOf(SignOutError);
    expect(await rig.main.getToken()).toBeNull();
  });

  it('reports a promoted active_session_id across IPC', async () => {
    const rig = signOutRig((method, path) =>
      path.endsWith('/sessions/sess_1/revoke') ? json({ status: 'revoked', active_session_id: 'sess_2' }) : undefined,
    );
    await rig.bridge.setToken(jwtFor('sess_1'));
    await expect(signOut({ bridge: rig.bridge })).resolves.toEqual({ revoked: true, activeSessionId: 'sess_2' });
  });

  it('finds the session with GET /v1/client when the token carries no sid', async () => {
    const token = `${b64({ alg: 'none' })}.${b64({ sub: 'user_1' })}.sig`;
    const rig = signOutRig((method, path, auth) => {
      if (path === '/v1/client') return json({ session: auth ? { id: 'sess_9' } : null, user: null });
      if (path === '/v1/client/sessions/sess_9/revoke') return json({ status: 'revoked' });
    });
    await rig.bridge.setToken(token);
    await expect(signOut({ bridge: rig.bridge })).resolves.toEqual({ revoked: true });
    expect(revokes(rig.calls).map((c) => c.path)).toEqual(['/v1/client/sessions/sess_9/revoke']);
  });

  it('with no token there is nothing to revoke', async () => {
    const rig = signOutRig(() => undefined);
    await expect(signOut({ bridge: rig.bridge })).resolves.toEqual({ revoked: true });
    expect(rig.calls).toHaveLength(0);
  });

  it('without frontendApi it can only clear the token, and reports revoked: false', async () => {
    const rig = signOutRig(() => undefined, createInMemoryTokenStorage(), { frontendApi: undefined });
    await rig.bridge.setToken(jwtFor('sess_1'));
    await expect(signOut({ bridge: rig.bridge })).resolves.toEqual({ revoked: false });
    expect(rig.calls).toHaveLength(0);
    expect(await rig.bridge.getToken()).toBeNull();
  });

  it('a bridge from an older preload (no signOut) clears the token and resolves { revoked: false }', async () => {
    let token: string | null = 'jwt';
    const legacy: AtlasTokenBridge = {
      getToken: async () => token,
      setToken: async (t) => {
        token = t;
      },
      clearToken: async () => {
        token = null;
      },
    };
    await expect(signOut({ bridge: legacy })).resolves.toEqual({ revoked: false });
    expect(token).toBeNull();
    await expect(signOut({ bridge: legacy, strict: true })).rejects.toBeInstanceOf(SignOutError);
  });

  it('enforces validateSender on the sign-out channel', async () => {
    const { ipcMain, invoke } = fakeIpcMain();
    createAtlasBridge({ ipcMain, storage: createInMemoryTokenStorage(), validateSender: () => false });
    await expect(invoke(ATLAS_TOKEN_CHANNELS.signOut)).rejects.toThrow(/validateSender/);
  });
});

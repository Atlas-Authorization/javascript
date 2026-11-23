import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasWebAuthFlowError, createTabIdentity, firefoxRedirectUrl, signInWithWebAuthFlow, type ChromeIdentity, type TabsApi } from './web-auth-flow';
import { createMemoryStorageArea, StorageCache } from './storage';

// The timeout starts only after the redirect URL's SHA-1 resolves (a real event-loop turn), so wait for the tab
// before moving fake time; advancing first would race the timer's creation.
const tabOpened = async (f: { created: unknown[] }) => {
  while (f.created.length === 0) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r)); // and let the flow take the created tab's id
};

const ADDON = 'atlas-test@example.com';
const HASH = createHash('sha1').update(ADDON).digest('hex');
const REDIRECT = `https://${HASH}.extensions.allizom.org/`;
const BASE = 'https://fapi.example.test';
const base = { frontendApi: BASE, publishableKey: 'pk_test_x', clientId: 'ext_client' };

type Fn = (...a: never[]) => void;
function fakeTabs() {
  const updated = new Set<Fn>();
  const removedL = new Set<Fn>();
  const created: Array<{ url: string; active?: boolean }> = [];
  const removed: number[] = [];
  const tabs: TabsApi = {
    create: async (p) => {
      created.push(p);
      return { id: 7 };
    },
    remove: async (id) => {
      removed.push(id);
    },
    onUpdated: { addListener: (f) => updated.add(f as Fn), removeListener: (f) => updated.delete(f as Fn) },
    onRemoved: { addListener: (f) => removedL.add(f as Fn), removeListener: (f) => removedL.delete(f as Fn) },
  };
  const fireUpdated = (id: number, url: string) => [...updated].forEach((f) => (f as (a: number, b: { url?: string }, c: { url?: string }) => void)(id, { url }, {}));
  const fireRemoved = (id: number) => [...removedL].forEach((f) => (f as (a: number) => void)(id));
  return { tabs, created, removed, updated, removedL, fireUpdated, fireRemoved };
}
const AUTH = `${BASE}/oauth2/authorize?x=1`;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('firefoxRedirectUrl', () => {
  it('is the sha1 hex host of the add-on id', async () => {
    expect(await firefoxRedirectUrl(ADDON)).toBe(REDIRECT);
  });
});

describe('createTabIdentity', () => {
  it('resolves with the redirect seen on its own tab, then removes the tab and the listeners', async () => {
    const f = fakeTabs();
    const p = createTabIdentity(f.tabs, ADDON).launchWebAuthFlow({ url: AUTH, interactive: true });
    await tabOpened(f);
    f.fireUpdated(7, `${REDIRECT}?code=c&state=s`);
    expect(await p).toBe(`${REDIRECT}?code=c&state=s`);
    expect(f.created).toEqual([{ url: AUTH, active: true }]);
    expect(f.removed).toEqual([7]);
    expect(f.updated.size).toBe(0);
    expect(f.removedL.size).toBe(0);
  });

  it('keeps a redirect that arrives before tabs.create resolves', async () => {
    const f = fakeTabs();
    const create = f.tabs.create;
    f.tabs.create = async (p) => {
      const tab = await create(p);
      f.fireUpdated(7, `${REDIRECT}?code=c&state=s`); // the tab navigates before the flow learns its id
      return tab;
    };
    expect(await createTabIdentity(f.tabs, ADDON).launchWebAuthFlow({ url: AUTH, interactive: true })).toBe(`${REDIRECT}?code=c&state=s`);
    expect(f.removed).toEqual([7]);
  });

  it('ignores redirects on other tabs and look-alike hosts', async () => {
    const f = fakeTabs();
    const p = createTabIdentity(f.tabs, ADDON).launchWebAuthFlow({ url: AUTH, interactive: true });
    await tabOpened(f);
    f.fireUpdated(8, `${REDIRECT}?code=other`);
    f.fireUpdated(7, `https://${HASH}.extensions.allizom.org.evil.example/?code=evil`);
    f.fireUpdated(7, `https://evil.example/?u=${REDIRECT}`);
    f.fireUpdated(7, `${REDIRECT}?code=good`);
    expect(await p).toBe(`${REDIRECT}?code=good`);
  });

  it('rejects cancelled when the user closes the tab, and does not remove it again', async () => {
    const f = fakeTabs();
    const p = createTabIdentity(f.tabs, ADDON).launchWebAuthFlow({ url: AUTH, interactive: true });
    await tabOpened(f);
    f.fireRemoved(7);
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(f.removed).toEqual([]);
    expect(f.removedL.size).toBe(0);
  });

  it('a silent flow opens an inactive tab and times out with silent_unsupported after 20 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fakeTabs();
    const p = createTabIdentity(f.tabs, ADDON).launchWebAuthFlow({ url: AUTH, interactive: false });
    const assertion = expect(p).rejects.toMatchObject({ code: 'silent_unsupported' });
    await tabOpened(f);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(f.created[0]?.active).toBe(false);
    expect(f.removed).toEqual([7]);
    expect(f.updated.size).toBe(0);
  });

  it('an interactive flow times out as cancelled after 10 minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fakeTabs();
    const p = createTabIdentity(f.tabs, ADDON).launchWebAuthFlow({ url: AUTH, interactive: true });
    const assertion = expect(p).rejects.toMatchObject({ code: 'cancelled' });
    await tabOpened(f);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await assertion;
  });

  it('silentTabFlow: false throws silent_unsupported without opening a tab', async () => {
    const f = fakeTabs();
    await expect(createTabIdentity(f.tabs, ADDON, { silentTabFlow: false }).launchWebAuthFlow({ url: AUTH, interactive: false })).rejects.toMatchObject({ code: 'silent_unsupported' });
    expect(f.created).toEqual([]);
  });
});

describe('signInWithWebAuthFlow on the tab fallback', () => {
  const fetchOk = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body ?? ''));
    if (String(input) === `${BASE}/oauth2/token` && form.get('grant_type') === 'authorization_code') return Response.json({ access_token: 'op_access_1' });
    return Response.json({ access_token: 'sess.jwt.1', session_id: 'sess_1', refresh_token: 'refr_1', expires_in: 60 });
  }) as typeof fetch;

  it('signs in through a tab using the add-on redirect URL', async () => {
    const f = fakeTabs();
    vi.stubGlobal('browser', { tabs: f.tabs, runtime: { id: ADDON } });
    vi.stubGlobal('chrome', undefined);
    const store = new StorageCache({ area: createMemoryStorageArea() });
    const p = signInWithWebAuthFlow({ ...base, fetchImpl: fetchOk, store });
    await vi.waitFor(() => expect(f.created.length).toBe(1));
    const authorize = new URL(f.created[0]!.url);
    expect(authorize.searchParams.get('redirect_uri')).toBe(REDIRECT);
    f.fireUpdated(7, `${REDIRECT}?code=c1&state=${authorize.searchParams.get('state')}`);
    const manager = await p;
    expect(await manager.getToken()).toBe('sess.jwt.1');
    expect(f.removed).toEqual([7]);
  });

  it('a foreign state on the redirect still fails with state_mismatch', async () => {
    const f = fakeTabs();
    vi.stubGlobal('browser', { tabs: f.tabs, runtime: { id: ADDON } });
    vi.stubGlobal('chrome', undefined);
    const p = signInWithWebAuthFlow({ ...base, fetchImpl: fetchOk });
    await vi.waitFor(() => expect(f.created.length).toBe(1));
    f.fireUpdated(7, `${REDIRECT}?code=c1&state=forged`);
    await expect(p).rejects.toMatchObject({ code: 'state_mismatch' });
  });

  it('silent sign-in maps login_required from the redirect', async () => {
    const f = fakeTabs();
    vi.stubGlobal('browser', { tabs: f.tabs, runtime: { id: ADDON } });
    vi.stubGlobal('chrome', undefined);
    const p = signInWithWebAuthFlow({ ...base, interactive: false, fetchImpl: fetchOk });
    await vi.waitFor(() => expect(f.created.length).toBe(1));
    const state = new URL(f.created[0]!.url).searchParams.get('state');
    f.fireUpdated(7, `${REDIRECT}?error=login_required&state=${state}`);
    await expect(p).rejects.toMatchObject({ code: 'login_required' });
  });

  it('silentTabFlow: false is silent_unsupported', async () => {
    const f = fakeTabs();
    vi.stubGlobal('browser', { tabs: f.tabs, runtime: { id: ADDON } });
    vi.stubGlobal('chrome', undefined);
    await expect(signInWithWebAuthFlow({ ...base, interactive: false, silentTabFlow: false })).rejects.toMatchObject({ code: 'silent_unsupported' });
    expect(f.created).toEqual([]);
  });

  it('an explicit identity wins over the tab fallback', async () => {
    const f = fakeTabs();
    vi.stubGlobal('browser', { tabs: f.tabs, runtime: { id: ADDON } });
    const custom: ChromeIdentity = {
      getRedirectURL: () => 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/',
      launchWebAuthFlow: async () => undefined,
    };
    await expect(signInWithWebAuthFlow({ ...base, identity: custom, interactive: true })).rejects.toBeInstanceOf(AtlasWebAuthFlowError);
    expect(f.created).toEqual([]);
  });

  it('identity_unavailable names the tabs permission when neither exists', async () => {
    vi.stubGlobal('browser', undefined);
    vi.stubGlobal('chrome', undefined);
    await expect(signInWithWebAuthFlow(base)).rejects.toMatchObject({ code: 'identity_unavailable', message: expect.stringContaining('tabs') });
  });
});

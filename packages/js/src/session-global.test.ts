// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { announceSessionChange, createClientSessionSource, customerMetadataFor, installSessionGlobal, SESSION_EVENT } from './session-global';

const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '');
const jwt = (claims: object) => `h.${b64({ exp: Math.floor(Date.now() / 1000) + 60, ...claims })}.s`;

function fetchStub(routes: Record<string, () => unknown>) {
  return vi.fn(async (url: string, init?: { method?: string }) => {
    const path = new URL(url, 'https://x.test').pathname;
    const body = routes[`${init?.method ?? 'GET'} ${path}`]?.();
    return new Response(body === undefined ? '{}' : JSON.stringify(body), { status: body === undefined ? 401 : 200 });
  }) as unknown as typeof fetch;
}

describe('window.Atlas.session', () => {
  afterEach(() => {
    delete (window as { Atlas?: unknown }).Atlas;
  });

  it('extends an existing window.Atlas instead of replacing it', () => {
    const mount = () => 1;
    (window as { Atlas?: unknown }).Atlas = { mountSignIn: mount };
    const off = installSessionGlobal({ getToken: async () => 'tok', user: () => ({ id: 'user_1' }) });
    expect((window.Atlas as { mountSignIn?: unknown }).mountSignIn).toBe(mount);
    expect(window.Atlas?.session?.isSignedIn).toBe(true);
    off();
    expect(window.Atlas?.session).toBeUndefined();
    expect((window.Atlas as { mountSignIn?: unknown }).mountSignIn).toBe(mount);
  });

  it('getIdToken is the same token as getToken; signed out is null', async () => {
    installSessionGlobal({ getToken: async () => null, user: () => null });
    expect(await window.Atlas?.session?.getToken()).toBeNull();
    expect(await window.Atlas?.session?.getIdToken()).toBeNull();
    expect(window.Atlas?.session?.isSignedIn).toBe(false);
    expect(window.Atlas?.billing?.customerMetadata()).toBeNull();
  });

  it('boots from /v1/client, then caches and refreshes', async () => {
    const first = jwt({ sub: 'user_1', external_id: 'ext_9' });
    const fetchImpl = fetchStub({
      'GET /v1/client': () => ({ session: { id: 'sess_1' }, user: { id: 'user_1' }, jwt: first }),
      'POST /v1/client/sessions/sess_1/tokens': () => ({ jwt: jwt({ sub: 'user_1' }), session_id: 'sess_1' }),
    });
    const source = createClientSessionSource(new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://x.test', fetchImpl, exposeSession: false }));
    expect(await source.getToken()).toBe(first);
    expect(await source.getToken()).toBe(first); // cached
    expect(source.user()?.id).toBe('user_1');
    expect(source.externalId?.()).toBe('ext_9');
  });

  it('is null when signed out', async () => {
    const fetchImpl = fetchStub({ 'GET /v1/client': () => ({ session: null, user: null }) });
    const source = createClientSessionSource(new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://x.test', fetchImpl, exposeSession: false }));
    expect(await source.getToken()).toBeNull();
    expect(source.user()).toBeNull();
  });

  it('a FapiClient registers the global unless disabled', () => {
    new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://x.test', exposeSession: false });
    expect(window.Atlas?.session).toBeUndefined();
  });

  it('dispatches atlas:session only on change', () => {
    const seen: unknown[] = [];
    window.addEventListener(SESSION_EVENT, (e) => seen.push((e as CustomEvent).detail));
    announceSessionChange('user_a');
    announceSessionChange('user_a');
    announceSessionChange(null);
    expect(seen).toEqual([
      { signedIn: true, userId: 'user_a' },
      { signedIn: false, userId: null },
    ]);
  });

  it('customerMetadata omits atlas_external_id when there is none', () => {
    expect(customerMetadataFor({ id: 'u1' })).toEqual({ atlas_user_id: 'u1' });
    expect(customerMetadataFor({ id: 'u1', external_id: 'e1' })).toEqual({ atlas_user_id: 'u1', atlas_external_id: 'e1' });
  });
});

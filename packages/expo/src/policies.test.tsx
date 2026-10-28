import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from '@atlasauth/js';
import { DEFAULT_SESSION_KEY, createInMemoryTokenCache } from './token-cache';

/**
 * Policy acceptance on Expo: the hooks are bound to THIS package's provider
 * (the bearer client built over the token cache), and the native components are
 * `@atlasauth/react-native`'s, re-exported unchanged. `react-native` itself
 * cannot load in node, so the two packages this file sits on are mocked.
 */

let contextValue: unknown = null;
let atlasState: { status: string; locale?: string | null } = { status: 'signed_in', locale: 'fr' };

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useContext: () => contextValue,
    // The provider is a thin wrapper: run its one `useState` initializer directly.
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
  };
});

vi.mock('@atlasauth/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@atlasauth/react')>();
  return { ...actual, useAtlas: () => atlasState };
});

vi.mock('@atlasauth/react-native', () => ({
  PolicyAcceptStep: 'PolicyAcceptStep',
  PolicyClickwrap: 'PolicyClickwrap',
  PolicyConsent: 'PolicyConsent',
  PolicyDocument: 'PolicyDocument',
  PolicyGateView: 'PolicyGateView',
  PolicyScrollHost: 'PolicyScrollHost',
  PolicyScrollModal: 'PolicyScrollModal',
  PolicyViewer: 'PolicyViewer',
  parsePolicyHtml: () => [],
  policyPlainText: () => '',
  usePoliciesWith: vi.fn((env, options) => ({ env, options })),
  usePendingPoliciesWith: vi.fn((env, held, options) => ({ env, held, options })),
  usePolicyGateWith: vi.fn((env, enabled) => ({ env, enabled })),
}));

const BASE = 'https://fapi.example.test';
const client = new FapiClient({ publishableKey: 'pk_test_x', baseUrl: BASE, fetchImpl: (async () => new Response('{}')) as typeof fetch });

describe('the hooks', () => {
  it('use the provider client and the app language', async () => {
    const rn = await import('@atlasauth/react-native');
    const { usePolicies, usePendingPolicies } = await import('./policies');
    contextValue = client;
    const r = usePolicies({ combined: false, signIn: true }) as unknown as { env: unknown; options: unknown };
    expect(r.env).toEqual({ client, locale: 'fr' });
    expect(r.options).toEqual({ combined: false, signIn: true });
    expect(rn.usePoliciesWith).toHaveBeenCalledOnce();
    const held = { pendingPolicies: [] };
    const p = usePendingPolicies(held) as unknown as { held: unknown };
    expect(p.held).toBe(held);
  });

  it('the gate loads only for a signed-in user', async () => {
    const { usePolicyGate } = await import('./policies');
    contextValue = client;
    atlasState = { status: 'signed_in', locale: null };
    expect((usePolicyGate() as unknown as { enabled: boolean }).enabled).toBe(true);
    atlasState = { status: 'signed_out', locale: null };
    expect((usePolicyGate() as unknown as { enabled: boolean }).enabled).toBe(false);
  });

  it('refuse to run outside <AtlasProvider>', async () => {
    const { useExpoFapiClient, usePolicies } = await import('./policies');
    contextValue = null;
    expect(() => useExpoFapiClient()).toThrow('inside <AtlasProvider>');
    expect(() => usePolicies()).toThrow('inside <AtlasProvider>');
  });

  it('<PolicyGate> is the shared gate view over this provider\'s gate', async () => {
    const { PolicyGate } = await import('./policies');
    contextValue = client;
    atlasState = { status: 'signed_in', locale: null };
    const onAccepted = vi.fn();
    const el = PolicyGate({ onAccepted, children: null });
    expect(el.type).toBe('PolicyGateView');
    expect((el.props as { gate: unknown; onAccepted: unknown }).onAccepted).toBe(onAccepted);
    expect((el.props as { gate: { enabled: boolean } }).gate.enabled).toBe(true);
  });
});

describe('the components', () => {
  it('are the React Native package\'s, unchanged', async () => {
    const rn = await import('@atlasauth/react-native');
    const expo = await import('./policies');
    expect(expo.PolicyConsent).toBe(rn.PolicyConsent);
    expect(expo.PolicyClickwrap).toBe(rn.PolicyClickwrap);
    expect(expo.PolicyAcceptStep).toBe(rn.PolicyAcceptStep);
    expect(expo.PolicyScrollHost).toBe(rn.PolicyScrollHost);
    expect(expo.PolicyViewer).toBe(rn.PolicyViewer);
  });
});

describe('<AtlasProvider> (expo) provides a bearer client', () => {
  it('builds a FapiClient over the token cache and hands it to the tree', async () => {
    const { AtlasProvider } = await import('./AtlasProvider');
    const { ExpoFapiContext } = await import('./fapi-context');
    const cache = createInMemoryTokenCache();
    const jwt = 'eyJhbGciOiJub25lIn0.eyJzaWQiOiJzZXNzXzEiLCJleHAiOjk5OTk5OTk5OTl9.sig';
    await cache.saveToken(DEFAULT_SESSION_KEY, jwt);
    const seen: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '');
      return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const element = AtlasProvider({ publishableKey: 'pk_test_x', frontendApi: BASE, tokenCache: cache, fetchImpl, children: null });
    const wrapper = (element.props as { children: { type: unknown; props: { value: unknown } } }).children;
    expect(wrapper.type).toBe(ExpoFapiContext.Provider);
    const provided = wrapper.props.value as FapiClient;
    expect(provided).toBeInstanceOf(FapiClient);
    await provided.get('/v1/client/policies');
    expect(seen[0]).toBe(`Bearer ${jwt}`);
  });
});

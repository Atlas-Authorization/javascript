import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { ConvexProviderWithAtlas, convexAuthFromAtlas } from './react';

const { captured, getToken } = vi.hoisted(() => ({
  captured: {} as { useAuth?: () => unknown },
  getToken: async (opts?: { template?: string }) => `jwt-for-${opts?.template ?? 'session'}`,
}));
vi.mock('convex/react', () => ({
  ConvexProviderWithAuth: ({ useAuth, children }: { useAuth: () => unknown; children: ReactNode }) => {
    captured.useAuth = useAuth;
    const state = useAuth() as { isLoading: boolean; isAuthenticated: boolean };
    return (
      <div data-loading={String(state.isLoading)} data-authenticated={String(state.isAuthenticated)}>
        {children}
      </div>
    );
  },
}));

vi.mock('@atlasauth/react', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, getToken }),
}));


describe('convexAuthFromAtlas', () => {
  it('maps loading / signed-in state', () => {
    const loading = convexAuthFromAtlas({ isLoaded: false, isSignedIn: false, getToken: async () => null });
    expect(loading).toMatchObject({ isLoading: true, isAuthenticated: false });
    const signedIn = convexAuthFromAtlas({ isLoaded: true, isSignedIn: true, getToken: async () => 'x' });
    expect(signedIn).toMatchObject({ isLoading: false, isAuthenticated: true });
  });

  it('fetches a token from the template, null when signed out or on error', async () => {
    const fetchToken = vi.fn(async (o?: { template?: string }) => `t:${o?.template}`);
    expect(await convexAuthFromAtlas({ isLoaded: true, isSignedIn: true, getToken: fetchToken }).fetchAccessToken({ forceRefreshToken: true })).toBe('t:convex');
    expect(await convexAuthFromAtlas({ isLoaded: true, isSignedIn: true, getToken: fetchToken }, 'other').fetchAccessToken({ forceRefreshToken: false })).toBe('t:other');
    expect(await convexAuthFromAtlas({ isLoaded: true, isSignedIn: false, getToken: fetchToken }).fetchAccessToken({ forceRefreshToken: false })).toBeNull();
    const failing = async () => {
      throw new Error('network');
    };
    expect(await convexAuthFromAtlas({ isLoaded: true, isSignedIn: true, getToken: failing }).fetchAccessToken({ forceRefreshToken: false })).toBeNull();
  });
});

describe('<ConvexProviderWithAtlas>', () => {
  it('hands Convex an auth hook backed by the Atlas session', async () => {
    const html = renderToStaticMarkup(
      <ConvexProviderWithAtlas client={{} as never} template="convex-prod">
        <span>app</span>
      </ConvexProviderWithAtlas>,
    );
    expect(html).toContain('data-authenticated="true"');
    expect(html).toContain('<span>app</span>');
    expect(captured.useAuth).toBeTypeOf('function');
  });
});

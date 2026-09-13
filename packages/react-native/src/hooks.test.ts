import { describe, expect, it, vi } from 'vitest';
import type { AtlasStoreState } from './store';
// vitest hoists vi.mock above these imports, so `./hooks` binds to the mocked
// provider module below.
import { useAuth, useSession, useSignIn, useSignUp, useUser } from './hooks';

/**
 * The hooks are thin bindings over the store. Rather than stand up a React
 * renderer (which would drag in a runtime this DOM-free package deliberately
 * avoids), we mock the provider module so `useAtlasStore` / `useAtlasState`
 * return known values, then call the hooks as plain functions and assert the
 * mapping. This pins the parity surface — `isLoaded`, `isSignedIn`, the claim
 * projection, and the exact store methods each hook hands back.
 */

const fakeStore = {
  getToken: vi.fn(),
  getProviderToken: vi.fn(),
  signOut: vi.fn(),
  signInWithPassword: vi.fn(),
  attemptSecondFactor: vi.fn(),
  startOAuth: vi.fn(),
  completeOAuthRedirect: vi.fn(),
  signUpWithPassword: vi.fn(),
  verifyEmailCode: vi.fn(),
};

let snapshot: AtlasStoreState = { status: 'loading', user: null, session: null, claims: null };

vi.mock('./AtlasProvider', () => ({
  useAtlasStore: () => fakeStore,
  useAtlasState: () => snapshot,
}));

function setSnapshot(next: AtlasStoreState) {
  snapshot = next;
}

const SIGNED_IN: AtlasStoreState = {
  status: 'signed_in',
  user: {
    id: 'user_1',
    first_name: 'Ada',
    last_name: null,
    username: null,
    image_url: null,
    public_metadata: {},
    unsafe_metadata: {},
    mfa_enabled: false,
    has_password: true,
  },
  session: { id: 'sess_1', status: 'active', last_active_organization_id: null },
  claims: { sub: 'user_1', sid: 'sess_1', exp: 9999999999, org_id: 'org_1', org_role: 'admin' },
};

describe('useAuth', () => {
  it('reports loading before the store boots', () => {
    setSnapshot({ status: 'loading', user: null, session: null, claims: null });
    const auth = useAuth();
    expect(auth.isLoaded).toBe(false);
    expect(auth.isSignedIn).toBe(false);
    expect(auth.userId).toBeNull();
  });

  it('projects claims and passes the store auth methods when signed in', () => {
    setSnapshot(SIGNED_IN);
    const auth = useAuth();
    expect(auth.isLoaded).toBe(true);
    expect(auth.isSignedIn).toBe(true);
    expect(auth.userId).toBe('user_1');
    expect(auth.sessionId).toBe('sess_1');
    expect(auth.orgId).toBe('org_1');
    expect(auth.orgRole).toBe('admin');
    expect(auth.getToken).toBe(fakeStore.getToken);
    expect(auth.getProviderToken).toBe(fakeStore.getProviderToken);
    expect(auth.signOut).toBe(fakeStore.signOut);
  });
});

describe('useUser / useSession', () => {
  it('useUser reflects the signed-in user', () => {
    setSnapshot(SIGNED_IN);
    const { isLoaded, isSignedIn, user, getProviderToken } = useUser();
    expect(isLoaded).toBe(true);
    expect(isSignedIn).toBe(true);
    expect(user?.id).toBe('user_1');
    expect(getProviderToken).toBe(fakeStore.getProviderToken);
  });

  it('useSession reflects the active session', () => {
    setSnapshot(SIGNED_IN);
    const { isLoaded, session } = useSession();
    expect(isLoaded).toBe(true);
    expect(session?.id).toBe('sess_1');
  });
});

describe('useSignIn / useSignUp', () => {
  it('useSignIn hands back the store sign-in + OAuth methods', () => {
    const signIn = useSignIn();
    expect(signIn.signInWithPassword).toBe(fakeStore.signInWithPassword);
    expect(signIn.attemptSecondFactor).toBe(fakeStore.attemptSecondFactor);
    expect(signIn.startOAuth).toBe(fakeStore.startOAuth);
    expect(signIn.completeOAuthRedirect).toBe(fakeStore.completeOAuthRedirect);
  });

  it('useSignUp hands back the store sign-up methods', () => {
    const signUp = useSignUp();
    expect(signUp.signUpWithPassword).toBe(fakeStore.signUpWithPassword);
    expect(signUp.verifyEmailCode).toBe(fakeStore.verifyEmailCode);
  });
});

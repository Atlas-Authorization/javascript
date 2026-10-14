import { describe, expect, it } from 'vitest';
import {
  applySnapshot,
  initialStore,
  isLoaded,
  isSignedIn,
  orgId,
  orgRole,
  sessionId,
  userId,
  type AtlasStore,
} from './store';
import type { AtlasSnapshot } from './types';

/**
 * The store-sync logic is exactly what the provider's `subscribe` callback runs
 * on every client transition. Testing it directly — with a plain store object —
 * proves the reactive store reflects signed-in/out transitions without having
 * to stand up Qwik's full render.
 */

const signedIn: AtlasSnapshot = {
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
  claims: { sub: 'user_1', sid: 'sess_1', exp: 0, org_id: 'org_7', org_role: 'org:admin' },
  memberships: [],
};

const signedOut: AtlasSnapshot = {
  status: 'signed_out',
  user: null,
  session: null,
  claims: null,
  memberships: [],
};

describe('store initial state', () => {
  it('starts loading, not signed-out', () => {
    const store = initialStore('pk_test', 'https://fapi.example');
    expect(store.status).toBe('loading');
    expect(isLoaded(store)).toBe(false);
    expect(isSignedIn(store)).toBe(false);
    expect(store.publishableKey).toBe('pk_test');
    expect(store.frontendApi).toBe('https://fapi.example');
    expect(store.client).toBeUndefined();
  });
});

describe('applySnapshot mirrors a transition into the store', () => {
  it('reflects a signed-in snapshot and its derived selectors', () => {
    const store: AtlasStore = initialStore('pk_test', '');
    applySnapshot(store, signedIn);

    expect(isLoaded(store)).toBe(true);
    expect(isSignedIn(store)).toBe(true);
    expect(userId(store)).toBe('user_1');
    expect(sessionId(store)).toBe('sess_1');
    expect(orgId(store)).toBe('org_7');
    expect(orgRole(store)).toBe('org:admin');
    expect(store.user?.id).toBe('user_1');
  });

  it('reflects a signed-out transition and clears derived values', () => {
    const store: AtlasStore = initialStore('pk_test', '');
    applySnapshot(store, signedIn);
    applySnapshot(store, signedOut);

    expect(isLoaded(store)).toBe(true);
    expect(isSignedIn(store)).toBe(false);
    expect(userId(store)).toBeNull();
    expect(orgId(store)).toBeNull();
    expect(store.user).toBeNull();
  });
});

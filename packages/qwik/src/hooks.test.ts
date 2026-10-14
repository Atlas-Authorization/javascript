import { describe, expect, it, vi } from 'vitest';
import { initialStore } from './store';
import type { AtlasStore } from './store';
import type { AtlasSession } from './types';

/**
 * useAuth() reads the store from Qwik context; stub the context lookup so the
 * hook can be called as a plain function against a known store.
 */
let store: AtlasStore;
vi.mock('./context', () => ({ useAtlas: () => store }));

const { useAuth } = await import('./hooks');

describe('useAuth status/session', () => {
  // Field report: code destructured `status`/`session` from useAuth() and got
  // undefined. Both are present now and agree with isLoaded/isSignedIn.
  it('reports loading before boot', () => {
    store = initialStore('pk_test', '');
    const auth = useAuth();
    expect(auth.status).toBe('loading');
    expect(auth.session).toBeNull();
    expect(auth.isLoaded).toBe(false);
    expect(auth.isSignedIn).toBe(false);
  });

  it('reports signed_in with the active session', () => {
    const session = { id: 'sess_1', status: 'active' } as unknown as AtlasSession;
    store = { ...initialStore('pk_test', ''), status: 'signed_in', session };
    const auth = useAuth();
    expect(auth.status).toBe('signed_in');
    expect(auth.session).toBe(session);
    expect(auth.isSignedIn).toBe(true);
  });

  it('reports signed_out as loaded, not signed in', () => {
    store = { ...initialStore('pk_test', ''), status: 'signed_out' };
    const auth = useAuth();
    expect(auth.status).toBe('signed_out');
    expect(auth.isLoaded).toBe(true);
    expect(auth.isSignedIn).toBe(false);
  });
});

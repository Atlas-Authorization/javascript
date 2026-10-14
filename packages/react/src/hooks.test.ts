import { describe, expect, it } from 'vitest';
import { authFromContext, type UseAuthReturn } from './hooks';
import type { AtlasSession, SessionClaims } from './types';

const noop = {
  getToken: async () => null,
  getProviderToken: async () => null,
  signOut: async () => ({ revoked: true }),
};

const session = { id: 'sess_1', status: 'active' } as unknown as AtlasSession;
const claims = { sub: 'user_1', sid: 'sess_1', exp: 0, org_id: 'org_1', org_role: 'admin' } as SessionClaims;

describe('useAuth() shape', () => {
  /**
   * Field report: code destructured `status`/`session` from useAuth() (the
   * provider-context names), got undefined, and silently never signed anyone in.
   * Both now exist on useAuth() and agree with isLoaded/isSignedIn.
   */
  it('exposes status and session alongside isLoaded/isSignedIn while loading', () => {
    const auth = authFromContext({ ...noop, status: 'loading', session: null, claims: null });
    expect(auth.status).toBe('loading');
    expect(auth.session).toBeNull();
    expect(auth.isLoaded).toBe(false);
    expect(auth.isSignedIn).toBe(false);
    expect(auth.userId).toBeNull();
  });

  it('reports signed_in with the active session and claim-derived ids', () => {
    const auth = authFromContext({ ...noop, status: 'signed_in', session, claims });
    expect(auth.status).toBe('signed_in');
    expect(auth.session).toBe(session);
    expect(auth.isLoaded).toBe(true);
    expect(auth.isSignedIn).toBe(true);
    expect(auth.userId).toBe('user_1');
    expect(auth.sessionId).toBe('sess_1');
    expect(auth.orgId).toBe('org_1');
    expect(auth.orgRole).toBe('admin');
  });

  it('reports signed_out as loaded but not signed in', () => {
    const auth = authFromContext({ ...noop, status: 'signed_out', session: null, claims: null });
    expect(auth.status).toBe('signed_out');
    expect(auth.isLoaded).toBe(true);
    expect(auth.isSignedIn).toBe(false);
  });

  it('has an explicit return type that rejects unknown fields', () => {
    const auth: UseAuthReturn = authFromContext({ ...noop, status: 'signed_out', session: null, claims: null });
    // @ts-expect-error — not a field of UseAuthReturn; typecheck fails if it ever becomes `any`.
    void auth.user;
    expect(Object.keys(auth).sort()).toEqual(
      [
        'getProviderToken',
        'getToken',
        'has',
        'isLoaded',
        'isSignedIn',
        'orgId',
        'orgRole',
        'session',
        'sessionId',
        'signOut',
        'status',
        'userId',
      ].sort(),
    );
  });
});

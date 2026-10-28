import { describe, expect, it, vi } from 'vitest';
import { actorFromClaims, endImpersonation } from './impersonation';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('actorFromClaims', () => {
  it('reads act.sub, and null for an ordinary token', () => {
    expect(actorFromClaims({ sub: 'u', act: { sub: 'admin_1' } })).toEqual({ sub: 'admin_1' });
    expect(actorFromClaims({ sub: 'u' })).toBeNull();
    expect(actorFromClaims({ act: { sub: '' } })).toBeNull();
    expect(actorFromClaims({ act: 'admin' })).toBeNull();
    expect(actorFromClaims(null)).toBeNull();
  });
});

describe('endImpersonation', () => {
  it('posts to the session and reports the resumed admin session', async () => {
    const request = vi.fn(async () =>
      json({ object: 'session', id: 'sess_imp', status: 'revoked', resumed: true, active_session_id: 'sess_admin', jwt: 'j' }),
    );
    expect(await endImpersonation(request, 'sess_imp')).toEqual({
      ended: true,
      resumed: true,
      status: 200,
      activeSessionId: 'sess_admin',
      jwt: 'j',
    });
    expect(request).toHaveBeenCalledWith('/v1/client/sessions/sess_imp/end_impersonation', { method: 'POST' });
  });

  it('ended without a session to resume means signed out', async () => {
    const out = await endImpersonation(async () => json({ status: 'revoked', resumed: false }), 's');
    expect(out).toEqual({ ended: true, resumed: false, status: 200 });
  });

  it('a refusal or a network failure is not an end', async () => {
    expect(await endImpersonation(async () => json({}, 409), 's')).toEqual({ ended: false, resumed: false, status: 409 });
    expect(await endImpersonation(async () => Promise.reject(new TypeError('offline')), 's')).toEqual({
      ended: false,
      resumed: false,
      status: 0,
    });
  });
});

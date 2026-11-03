// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { SIGN_OUT_EVENT, SignOutNotifier, onAtlasSignOut, signOutReasonFromClient } from './sign-out-events';

describe('SignOutNotifier', () => {
  it('fires listeners and the window event with the hinted reason', () => {
    const n = new SignOutNotifier();
    const listener = vi.fn();
    const fromWindow = vi.fn();
    n.subscribe(listener);
    const off = onAtlasSignOut(fromWindow);
    n.expect('other_tab');
    n.signedOut('sess_1');
    expect(listener).toHaveBeenCalledWith({ reason: 'other_tab', sessionId: 'sess_1' });
    expect(fromWindow).toHaveBeenCalledWith({ reason: 'other_tab', sessionId: 'sess_1' });
    off();
  });

  it('the first hint wins, and is consumed by the event', () => {
    const n = new SignOutNotifier();
    const listener = vi.fn();
    n.subscribe(listener);
    n.expect('user');
    n.expect('other_tab');
    n.signedOut('s');
    n.signedOut('s', 'revoked');
    expect(listener.mock.calls.map((c) => c[0].reason)).toEqual(['user', 'revoked']);
  });

  it('a throwing listener does not stop the others; unsubscribe works', () => {
    const n = new SignOutNotifier();
    const ok = vi.fn();
    n.subscribe(() => {
      throw new Error('boom');
    });
    const off = n.subscribe(ok);
    n.signedOut(null);
    off();
    n.signedOut(null);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(ok.mock.calls[0]![0]).toEqual({ reason: 'unknown', sessionId: null });
  });

  it('the event name is atlas:signout', () => {
    const seen = vi.fn();
    window.addEventListener(SIGN_OUT_EVENT, seen);
    new SignOutNotifier().signedOut(null, 'session_expired');
    expect(SIGN_OUT_EVENT).toBe('atlas:signout');
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener(SIGN_OUT_EVENT, seen);
  });
});

describe('signOutReasonFromClient', () => {
  it('maps the boot body', () => {
    expect(signOutReasonFromClient({ signed_out_reason: 'revoked' })).toBe('revoked');
    expect(signOutReasonFromClient({ signed_out_reason: 'session_expired' })).toBe('session_expired');
    expect(signOutReasonFromClient({ signed_out_reason: null })).toBe('unknown');
    expect(signOutReasonFromClient(null)).toBe('unknown');
  });
});

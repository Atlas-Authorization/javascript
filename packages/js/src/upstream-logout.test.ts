// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { followUpstreamLogout, upstreamLogoutUrl, upstreamLogoutUrlFromBody } from './upstream-logout';
import { revokeSession } from './sign-out';
import { SignOutGuard } from './sign-out-guard';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const END_SESSION = 'https://idp.example/logout?id_token_hint=eyJ.x.y&state=s';

beforeEach(() => {
  localStorage.clear();
});

describe('upstream logout URL', () => {
  it('accepts https (and http on loopback) only', () => {
    expect(upstreamLogoutUrl(END_SESSION)).toBe(END_SESSION);
    expect(upstreamLogoutUrl('http://localhost:8080/logout')).toBe('http://localhost:8080/logout');
    for (const bad of ['http://idp.example/logout', 'javascript:alert(1)', '/relative', '', 42, null]) {
      expect(upstreamLogoutUrl(bad)).toBeUndefined();
    }
    expect(upstreamLogoutUrlFromBody({ upstream_logout_url: END_SESSION })).toBe(END_SESSION);
    expect(upstreamLogoutUrlFromBody(null)).toBeUndefined();
  });

  it('navigates only to a safe URL', () => {
    const navigate = vi.fn();
    expect(followUpstreamLogout(END_SESSION, navigate)).toBe(true);
    expect(navigate).toHaveBeenCalledWith(END_SESSION);
    expect(followUpstreamLogout('javascript:alert(1)', navigate)).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});

describe('revokeSession + SignOutGuard', () => {
  it('sends the return URL and reports the upstream end-session URL', async () => {
    const request = vi.fn(async (_path: string, _init?: RequestInit) =>
      json({ object: 'session', status: 'revoked', upstream_logout_url: END_SESSION }),
    );
    const outcome = await revokeSession(request, 'sess_1', { returnUrl: 'https://app.example/bye' });
    expect(outcome.upstreamLogoutUrl).toBe(END_SESSION);
    const init = request.mock.calls[0]![1]!;
    expect(JSON.parse(String(init.body))).toEqual({ return_url: 'https://app.example/bye' });
    // Without a return URL the request stays body-less, exactly as before.
    await revokeSession(request, 'sess_1');
    expect(request.mock.calls[1]![1]!.body).toBeUndefined();
  });

  it('follows the upstream logout after the local sign-out, unless told not to', async () => {
    const navigate = vi.fn();
    const guard = new SignOutGuard({
      request: async () => json({ object: 'session', status: 'revoked', upstream_logout_url: END_SESSION }),
      navigate,
    });
    const attempt = await guard.revoke('sess_1', { returnUrl: 'https://app.example/bye' });
    expect(guard.settle(attempt)).toEqual({ revoked: true, upstreamLogoutUrl: END_SESSION });
    expect(navigate).toHaveBeenCalledWith(END_SESSION);

    const quiet = vi.fn();
    const guard2 = new SignOutGuard({
      request: async () => json({ upstream_logout_url: END_SESSION }),
      navigate: quiet,
    });
    const attempt2 = await guard2.revoke('sess_2');
    expect(guard2.settle(attempt2, { upstreamLogout: false })).toEqual({ revoked: true, upstreamLogoutUrl: END_SESSION });
    expect(quiet).not.toHaveBeenCalled();
  });

  it('does nothing extra when the response carries no upstream URL', async () => {
    const navigate = vi.fn();
    const guard = new SignOutGuard({ request: async () => json({ object: 'session' }), navigate });
    expect(guard.settle(await guard.revoke('sess_3'))).toEqual({ revoked: true });
    expect(navigate).not.toHaveBeenCalled();
  });
});

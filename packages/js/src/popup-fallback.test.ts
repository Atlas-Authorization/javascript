// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { startOauthPopup } from './redirect';

/**
 * §oauth popup mode — a popup that closes without posting back is usually a
 * cancel, but it can also be a sign-in the popup finished on its own (the
 * browser severed `window.opener`, so the callback page completed via the
 * ordinary redirect and set the session cookies). The opener checks the
 * session once before calling it a cancel. (A popup that reads as closed
 * within the first 1.5 s is a SEVERED one, not a close — see
 * popup-severed.test.ts.)
 */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(clientBody: unknown) {
  const calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (init?.body) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    if (url.endsWith('/v1/client/sign_ins/oauth')) {
      return json({ authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }, 201);
    }
    if (url.endsWith('/v1/client')) return json(clientBody);
    return json({});
  }) as unknown as typeof fetch;
  const popup = { closed: false, close: vi.fn() };
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  const client = new FapiClient({
    publishableKey: 'pk_test_x',
    baseUrl: 'https://fapi.example',
    fetchImpl,
  });
  return { client, popup, calls, bodies };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startOauthPopup: popup closed without a message', () => {
  it('reports sessionDetected when the Frontend API now has a session', async () => {
    vi.useFakeTimers();
    const { client, popup, calls } = setup({ session: { id: 'sess_1' }, user: { id: 'user_1' } });
    const pending = startOauthPopup(client, { provider: 'google', redirectUrl: 'https://app.example/' });
    // The user closes it after a while (past the severed-detection window).
    await vi.advanceTimersByTimeAsync(2_000);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toEqual({ error: 'popup_closed', sessionDetected: true });
    expect(calls.filter((u) => u === 'https://fapi.example/v1/client')).toHaveLength(1);
  });

  it('is a plain cancel when there is still no session', async () => {
    vi.useFakeTimers();
    const { client, popup } = setup({ session: null, user: null });
    const pending = startOauthPopup(client, { provider: 'google', redirectUrl: 'https://app.example/' });
    await vi.advanceTimersByTimeAsync(2_000);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toEqual({ error: 'popup_closed' });
  });

  it('starts the flow in popup mode with a channel nonce and the opener origin', async () => {
    vi.useFakeTimers();
    const { client, popup, bodies } = setup({ session: null, user: null });
    const pending = startOauthPopup(client, { provider: 'google', redirectUrl: 'https://app.example/' });
    await vi.advanceTimersByTimeAsync(2_000);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(600);
    await pending;
    expect(bodies[0]).toMatchObject({
      provider: 'google',
      redirect_url: 'https://app.example/',
      mode: 'popup',
      opener_origin: window.location.origin,
    });
    expect(bodies[0]!.popup_nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(window.open).toHaveBeenCalledWith(expect.any(String), 'atlas:oauth', expect.any(String));
  });

  it('still resolves with the ticket when the popup posts back first', async () => {
    vi.useFakeTimers();
    const { client, calls } = setup({ session: null, user: null });
    const pending = startOauthPopup(client, { provider: 'google', redirectUrl: 'https://app.example/' });
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://fapi.example',
        data: { type: 'atlas:oauth:complete', ticket: 'tk', attemptId: 'att' },
      }),
    );
    await expect(pending).resolves.toEqual({ ticket: 'tk', attemptId: 'att' });
    expect(calls).not.toContain('https://fapi.example/v1/client');
  });
});

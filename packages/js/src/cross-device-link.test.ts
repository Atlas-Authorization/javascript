import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  confirmCrossDeviceLink,
  createEmailLinkConfirmation,
  emailLinkFromUrl,
  forgetLinkSecret,
  previewCrossDeviceLink,
  readLinkSecret,
  rememberLinkProof,
} from './email-link';
import { FapiClient, advance, initialFlow, pollAttempt, prepareFactor, resendSignUpVerification, shouldKeepPolling, signUpProvedByLink, startSignUp, type FlowState } from './fapi';
import { startPasskeySignUp } from './passkey-sign-up';
import { pollPasswordReset, startPasswordReset } from './password-reset';

function scripted(route: (path: string, body: Record<string, unknown> | null) => { status?: number; body?: unknown }) {
  const calls: { method: string; path: string; search: string; body: Record<string, unknown> | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, search: url.search, body });
    const out = route(url.pathname, body);
    return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://f.example', fetchImpl, referral: false }), calls };
}

const at = (id: string, status: string, over: Partial<FlowState> = {}, object?: 'sign_up_attempt'): FlowState => ({
  ...initialFlow,
  attempt: { id, status, ...(object ? { object } : {}) },
  ...over,
});
const LINK = { attempt: 'sia_1', token: 't/1' };
const live = { body: { requires_confirmation: true } };

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('the starting tab', () => {
  it('a sign-in link keeps the code to show and stores the secret for this browser', async () => {
    const { client, calls } = scripted(() => ({ body: { poll_secret: 'ps', match_code: '482113' } }));
    const next = await prepareFactor(client, at('sia_1', 'needs_first_factor'), 'email_link', { crossDevice: true });
    expect(next).toMatchObject({ pollSecret: 'ps', matchCode: '482113' });
    expect(calls[0]!.body).toEqual({ strategy: 'email_link' });
    expect(localStorage.getItem('atlas_link_sia_1')).toBe('ps');
  });

  it('an emailed code stores nothing', async () => {
    const { client } = scripted(() => ({ body: { poll_secret: 'ps' } }));
    const next = await prepareFactor(client, at('sia_1', 'needs_first_factor'), 'email_code');
    expect(next.matchCode).toBeNull();
    expect(readLinkSecret('sia_1')).toBeNull();
  });

  it('a sign-up that mailed a link does the same; one that mailed only a code stores nothing', async () => {
    const link = scripted(() => ({ status: 201, body: { id: 'sia_2', object: 'sign_up_attempt', status: 'needs_email_verification', poll_secret: 'ps2', match_code: '111222' } }));
    expect((await startSignUp(link.client, { email: 'a@b.c', password: 'pw' })).matchCode).toBe('111222');
    expect(readLinkSecret('sia_2')).toBe('ps2');
    const code = scripted(() => ({ status: 201, body: { id: 'sia_3', object: 'sign_up_attempt', status: 'needs_email_verification' } }));
    expect((await startSignUp(code.client, { email: 'a@b.c', password: 'pw' })).matchCode).toBeUndefined();
    expect(readLinkSecret('sia_3')).toBeNull();
  });

  it('a passkey sign-up stores only when a link was mailed: its secret alone also drives the ceremony', async () => {
    const noLink = scripted(() => ({ status: 201, body: { id: 'sia_4', status: 'needs_first_factor', poll_secret: 'ps4' } }));
    expect((await startPasskeySignUp(noLink.client, {})).pollSecret).toBe('ps4');
    expect(readLinkSecret('sia_4')).toBeNull();
    const link = scripted(() => ({ status: 201, body: { id: 'sia_5', status: 'needs_email_verification', poll_secret: 'ps5', match_code: '555555' } }));
    expect((await startPasskeySignUp(link.client, { email: 'a@b.c' })).matchCode).toBe('555555');
    expect(readLinkSecret('sia_5')).toBe('ps5');
  });

  it('a resend swaps in the new code and secret; a code-only resend keeps what the tab has', async () => {
    const state = at('sia_2', 'needs_email_verification', { pollSecret: 'old', matchCode: '000000' }, 'sign_up_attempt');
    const link = scripted(() => ({ body: { poll_secret: 'new', match_code: '999999' } }));
    expect(await resendSignUpVerification(link.client, state)).toMatchObject({ pollSecret: 'new', matchCode: '999999' });
    expect(readLinkSecret('sia_2')).toBe('new');
    const code = scripted(() => ({ body: {} }));
    expect(await resendSignUpVerification(code.client, state)).toMatchObject({ pollSecret: 'old', matchCode: '000000' });
  });

  it('a rotated secret with nothing mailed hides the code and drops the stored secret', async () => {
    rememberLinkProof('sia_2', { poll_secret: 'old', match_code: '000000' });
    const state = at('sia_2', 'needs_email_verification', { pollSecret: 'old', matchCode: '000000' }, 'sign_up_attempt');
    const { client } = scripted(() => ({ body: { poll_secret: 'new' } }));
    const next = await resendSignUpVerification(client, state);
    expect(next).toMatchObject({ pollSecret: 'new', matchCode: null });
    expect(readLinkSecret('sia_2')).toBeNull();
  });

  it('a sign-up answer that mailed nothing has a secret to poll with and no code to show', async () => {
    const { client } = scripted(() => ({ status: 201, body: { id: 'sia_7', object: 'sign_up_attempt', status: 'needs_email_verification', poll_secret: 'ps7' } }));
    const flow = await startSignUp(client, { email: 'a@b.c', password: 'pw' });
    expect(flow.pollSecret).toBe('ps7');
    expect(flow.matchCode).toBeUndefined();
    expect(readLinkSecret('sia_7')).toBeNull();
  });

  it('a password reset by link stores its secret and forgets it once the link moved it on', async () => {
    let moved = false;
    const { client } = scripted((path) =>
      path === '/v1/client/password_resets'
        ? { status: 201, body: { id: 'sia_6', status: 'needs_email_verification', poll_secret: 'ps6', match_code: '666666' } }
        : { body: { id: 'sia_6', status: moved ? 'needs_new_password' : 'needs_email_verification' } },
    );
    const started = await startPasswordReset(client, 'a@b.c');
    expect(started.attempt?.match_code).toBe('666666');
    expect(readLinkSecret('sia_6')).toBe('ps6');
    expect((await pollPasswordReset(client, started)).attempt?.match_code).toBe('666666');
    moved = true;
    expect((await pollPasswordReset(client, started)).attempt?.match_code).toBeUndefined();
    expect(readLinkSecret('sia_6')).toBeNull();
  });

  it('completion clears the secret and the code', async () => {
    rememberLinkProof('sia_1', { poll_secret: 'ps', match_code: '123456' });
    const { client } = scripted(() => ({ body: { id: 'sia_1', object: 'sign_in_attempt', status: 'complete', ticket: 'tk' } }));
    const { state, ticket } = await pollAttempt(client, at('sia_1', 'needs_first_factor', { pollSecret: 'ps', matchCode: '123456' }));
    expect(ticket).toBe('tk');
    expect(state.matchCode).toBeNull();
    expect(readLinkSecret('sia_1')).toBeNull();
  });

  it('the emailed code finishing a `both` sign-up clears the secret too', async () => {
    rememberLinkProof('sia_2', { poll_secret: 'ps', match_code: '123456' });
    const { client } = scripted(() => ({ body: { id: 'sia_2', object: 'sign_up_attempt', status: 'complete', ticket: 'tk' } }));
    await advance(client, at('sia_2', 'needs_email_verification', { pollSecret: 'ps', matchCode: '123456' }, 'sign_up_attempt'), { code: '424242' });
    expect(readLinkSecret('sia_2')).toBeNull();
  });

  it('a repeat sign-up whose earlier attempt finished stops waiting, gets no ticket, and is told to sign in', async () => {
    rememberLinkProof('sia_2', { poll_secret: 'ps', match_code: '123456' });
    const { client } = scripted(() => ({ body: { id: 'sia_2', object: 'sign_up_attempt', status: 'needs_email_verification', finished_elsewhere: true } }));
    const { state, ticket } = await pollAttempt(client, at('sia_2', 'needs_email_verification', { pollSecret: 'ps', matchCode: '123456' }, 'sign_up_attempt'));
    expect(ticket).toBeNull();
    expect(shouldKeepPolling(state)).toBe(false);
    expect(signUpProvedByLink(state.attempt)).toBe(true);
    expect(state.matchCode).toBeNull();
    expect(readLinkSecret('sia_2')).toBeNull();
  });

  it('storage that throws never breaks the flow', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(rememberLinkProof('sia_1', { poll_secret: 'ps', match_code: '123456' })).toBe('123456');
    expect(readLinkSecret('sia_1')).toBeNull();
    expect(() => forgetLinkSecret('sia_1')).not.toThrow();
  });
});

describe('the link page helpers', () => {
  it('reads a mailed link from a URL, and leaves an app’s own params alone', () => {
    expect(emailLinkFromUrl('https://a.example/x?attempt=sia_1&token=t', 'sign_up')).toEqual({ attempt: 'sia_1', token: 't', flow: 'sign_up' });
    expect(emailLinkFromUrl('https://a.example/x?attempt=7&token=t')).toBeNull();
    expect(emailLinkFromUrl('https://a.example/x?attempt=sia_1')).toBeNull();
    expect(emailLinkFromUrl('not a url')).toBeNull();
  });

  it('previews without a code, on each flow’s route', async () => {
    const { client, calls } = scripted(() => ({ body: { requires_confirmation: true, match_code: 'NEVER' } }));
    expect(await previewCrossDeviceLink(client, LINK)).toEqual({ requiresConfirmation: true });
    await previewCrossDeviceLink(client, { ...LINK, flow: 'sign_up' });
    await previewCrossDeviceLink(client, { ...LINK, flow: 'password_reset' });
    expect(calls.map((c) => c.path)).toEqual(['/v1/client/sign_ins/verify', '/v1/client/sign_ups/verify', '/v1/client/password_resets/verify']);
    expect(calls[0]!.search).toBe('?attempt=sia_1&token=t%2F1');
  });

  it('a refused preview is null', async () => {
    const { client } = scripted(() => ({ status: 400, body: { verified: false } }));
    expect(await previewCrossDeviceLink(client, LINK)).toBeNull();
  });

  it('confirms with exactly one proof', async () => {
    const { client, calls } = scripted(() => ({ body: { verified: true } }));
    expect(await confirmCrossDeviceLink(client, { ...LINK, matchCode: '482113' })).toBe(true);
    expect(await confirmCrossDeviceLink(client, { ...LINK, flow: 'sign_up', pollSecret: 'ps' })).toBe(true);
    expect(calls[0]).toMatchObject({ path: '/v1/client/sign_ins/verify/confirm', body: { attempt: 'sia_1', token: 't/1', match_code: '482113' } });
    expect(calls[1]).toMatchObject({ path: '/v1/client/sign_ups/verify/confirm', body: { attempt: 'sia_1', token: 't/1', poll_secret: 'ps' } });
    expect(calls[1]!.body).not.toHaveProperty('match_code');
  });
});

describe('createEmailLinkConfirmation', () => {
  it('same browser: one step, no typing, the secret is forgotten', async () => {
    rememberLinkProof('sia_1', { poll_secret: 'ps', match_code: '123456' });
    const { client, calls } = scripted((path) => (path.endsWith('/confirm') ? { body: { verified: true } } : live));
    const page = createEmailLinkConfirmation(client, LINK);
    await page.start();
    expect(page.state.status).toBe('confirmed');
    expect(calls[1]!.body).toMatchObject({ poll_secret: 'ps' });
    expect(readLinkSecret('sia_1')).toBeNull();
  });

  it('starting twice (a strict-mode remount) sends one confirmation', async () => {
    rememberLinkProof('sia_1', { poll_secret: 'ps', match_code: '123456' });
    const { client, calls } = scripted((path) => (path.endsWith('/confirm') ? { body: {} } : live));
    const page = createEmailLinkConfirmation(client, LINK);
    await Promise.all([page.start(), page.start()]);
    expect(calls.filter((c) => c.path.endsWith('/confirm'))).toHaveLength(1);
  });

  it('no secret here: asks for the code without any confirm', async () => {
    const { client, calls } = scripted(() => live);
    const page = createEmailLinkConfirmation(client, LINK);
    await page.start();
    expect(page.state.status).toBe('needs_code');
    expect(calls).toHaveLength(1);
  });

  it('a refused secret falls back to the typed code', async () => {
    rememberLinkProof('sia_1', { poll_secret: 'stale', match_code: '123456' });
    const { client } = scripted((path) => (path.endsWith('/confirm') ? { status: 400 } : live));
    const page = createEmailLinkConfirmation(client, LINK);
    await page.start();
    expect(page.state.status).toBe('needs_code');
  });

  it('a sign-up on an address with an account offers the reset, https only', async () => {
    const good = scripted((path) => (path.endsWith('/confirm') ? { body: { verified: true, reset_url: 'https://a.example/reset' } } : live));
    const page = createEmailLinkConfirmation(good.client, { ...LINK, flow: 'sign_up' });
    await page.start();
    await page.submitCode('482113');
    expect(page.state.resetUrl).toBe('https://a.example/reset');
    const bad = scripted((path) => (path.endsWith('/confirm') ? { body: { verified: true, reset_url: 'javascript:alert(1)' } } : live));
    const other = createEmailLinkConfirmation(bad.client, { ...LINK, flow: 'sign_up' });
    await other.start();
    await other.submitCode('482113');
    expect(other.state.status).toBe('confirmed');
    expect(other.state.resetUrl).toBeUndefined();
  });

  it('a dead link is refused, and no proof is sent', async () => {
    rememberLinkProof('sia_1', { poll_secret: 'ps', match_code: '123456' });
    const { client, calls } = scripted(() => ({ status: 400 }));
    const page = createEmailLinkConfirmation(client, LINK);
    await page.start();
    expect(page.state.status).toBe('invalid');
    expect(calls).toHaveLength(1);
  });

  it('a page that does not say requires_confirmation is refused', async () => {
    const { client } = scripted(() => ({ body: { verified: true } }));
    const page = createEmailLinkConfirmation(client, LINK);
    await page.start();
    expect(page.state.status).toBe('invalid');
  });

  it('the typed code confirms, spaces removed', async () => {
    const { client, calls } = scripted((path) => (path.endsWith('/confirm') ? { body: {} } : live));
    const page = createEmailLinkConfirmation(client, LINK);
    await page.start();
    await page.submitCode(' 482 113 ');
    expect(page.state.status).toBe('confirmed');
    expect(calls[1]!.body).toMatchObject({ match_code: '482113' });
  });

  it('an empty code never reaches the server (a wrong one burns the link)', async () => {
    const { client, calls } = scripted(() => live);
    const page = createEmailLinkConfirmation(client, LINK);
    await page.start();
    await page.submitCode('   ');
    expect(calls).toHaveLength(1);
    expect(page.state.status).toBe('needs_code');
  });

  it('a wrong code ends the page: the link is burned', async () => {
    const { client } = scripted((path) => (path.endsWith('/confirm') ? { status: 400 } : live));
    const page = createEmailLinkConfirmation(client, LINK);
    await page.start();
    await page.submitCode('000000');
    expect(page.state.status).toBe('invalid');
  });

  it('a rate limit keeps the input: the code was never checked', async () => {
    const { client } = scripted((path) =>
      path.endsWith('/confirm') ? { status: 429, body: { errors: [{ code: 'RATE_LIMITED', message: 'Slow down.' }] } } : live,
    );
    const page = createEmailLinkConfirmation(client, LINK);
    await page.start();
    await page.submitCode('482113');
    expect(page.state.status).toBe('needs_code');
    expect(page.state.busy).toBe(false);
    expect(page.state.errors[0]?.message).toBe('Slow down.');
  });
});

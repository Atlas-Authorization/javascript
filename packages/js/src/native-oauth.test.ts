import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { base64UrlEncode, createPkcePair, pkceChallengeFor, redeemOAuthCode, sha256, signInWithNativeBrowser, startOAuthSignIn } from './native-oauth';
import { readRedirectResult } from './redirect';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

function fakeFapi(handler: (path: string, body: any, headers: Record<string, string>) => Response, appId?: string) {
  const calls: Array<{ path: string; body: any; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body as string) : null;
    const headers = init.headers as Record<string, string>;
    calls.push({ path, body, headers });
    return handler(path, body, headers);
  }) as unknown as typeof fetch;
  return { calls, client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.test', fetchImpl, exposeSession: false, ...(appId ? { appId } : {}) }) };
}

describe('pkce', () => {
  it('pure-JS sha256 matches the known vectors', () => {
    expect(hex(sha256(new TextEncoder().encode('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex(sha256(new Uint8Array(0)))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    // Two-block message (56 bytes forces a second padding block).
    expect(hex(sha256(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('computes the RFC 7636 challenge with and without crypto.subtle', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(await pkceChallengeFor(verifier)).toBe(expected);
    expect(base64UrlEncode(sha256(Uint8Array.from(verifier, (c) => c.charCodeAt(0))))).toBe(expected);
  });

  it('creates a 43-char verifier and a 43-char challenge', async () => {
    const pair = await createPkcePair();
    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.codeChallenge).toBe(await pkceChallengeFor(pair.codeVerifier));
    expect(pair.codeChallengeMethod).toBe('S256');
  });
});

describe('readRedirectResult', () => {
  it('reads a code with no ticket', () => {
    expect(readRedirectResult('?__atlas_attempt=a1&__atlas_code=c1')).toEqual({ attemptId: 'a1', code: 'c1' });
  });
});

describe('startOAuthSignIn / redeemOAuthCode', () => {
  it('sends the wire fields and the app id header', async () => {
    const { client, calls } = fakeFapi(() => json(200, { authorization_url: 'https://p/auth', attempt_id: 'att_1', redirect_url: 'https://fapi.test/v1/oauth/native-callback/napp_1' }), 'napp_1');
    const out = await startOAuthSignIn(client, { provider: 'discord', nativeAppId: 'napp_1', codeChallenge: 'x'.repeat(43), callback: 'exampleapp://cb' });
    expect(out).toMatchObject({ authorizationUrl: 'https://p/auth', attemptId: 'att_1' });
    expect(calls[0]!.body).toMatchObject({ provider: 'discord', native_app_id: 'napp_1', code_challenge_method: 'S256', callback: 'exampleapp://cb' });
    expect(calls[0]!.body.redirect_url).toBeUndefined();
    expect(calls[0]!.headers['x-atlas-app-id']).toBe('napp_1');
  });

  it('surfaces server codes and a null session on refusal', async () => {
    const { client } = fakeFapi(() => json(400, { errors: [{ code: 'PKCE_MISMATCH', message: 'no' }] }));
    const out = await redeemOAuthCode(client, { attemptId: 'a', code: 'c', codeVerifier: 'v' });
    expect(out.session).toBeNull();
    expect(out.errors[0]!.code).toBe('PKCE_MISMATCH');
  });
});

describe('signInWithNativeBrowser', () => {
  const start = json(200, { authorization_url: 'https://p/auth', attempt_id: 'att_1', redirect_url: 'https://fapi.test/v1/oauth/native-callback/napp_1' });
  const browserReturning = (url: string) => ({ openAuthSession: vi.fn(async () => ({ type: 'success' as const, url })) });

  it('redeems the code with the verifier whose challenge it started with', async () => {
    const { client, calls } = fakeFapi((path) => (path.endsWith('/token') ? json(200, { object: 'session', jwt: 'a.b.c', session_id: 's1' }) : start.clone()));
    const browser = browserReturning('exampleapp://cb?__atlas_attempt=att_1&__atlas_code=code1');
    const onStarted = vi.fn();
    const out = await signInWithNativeBrowser(client, { provider: 'discord', browser, nativeAppId: 'napp_1', onStarted });
    expect(out).toMatchObject({ status: 'complete', session: { jwt: 'a.b.c' } });
    expect(browser.openAuthSession).toHaveBeenCalledWith('https://p/auth', 'https://fapi.test/v1/oauth/native-callback/napp_1', { preferEphemeralSession: false });
    expect(onStarted).toHaveBeenCalledWith({ redirectUrl: 'https://fapi.test/v1/oauth/native-callback/napp_1', attemptId: 'att_1' });
    const redeem = calls[1]!.body;
    expect(await pkceChallengeFor(redeem.code_verifier)).toBe(calls[0]!.body.code_challenge);
    expect(redeem).toMatchObject({ attempt_id: 'att_1', code: 'code1' });
  });

  it('cancel and dismiss are cancelled, not errors', async () => {
    for (const type of ['cancel', 'dismiss'] as const) {
      const { client } = fakeFapi(() => start.clone());
      expect(await signInWithNativeBrowser(client, { provider: 'discord', browser: { openAuthSession: async () => ({ type }) } })).toEqual({ status: 'cancelled' });
    }
  });

  it('reports a second factor, refuses a ticket and a foreign attempt, and refuses a WebView', async () => {
    const run = (url: string) => signInWithNativeBrowser(fakeFapi(() => start.clone()).client, { provider: 'discord', browser: browserReturning(url) });
    expect(await run('exampleapp://cb?__atlas_attempt=att_1&__atlas_status=needs_second_factor')).toMatchObject({ status: 'needs_second_factor', attemptId: 'att_1' });
    expect(await run('exampleapp://cb?__atlas_attempt=att_1&__atlas_status=needs_required_action&__atlas_policy_token=t')).toMatchObject({ status: 'needs_required_action', policyToken: 't' });
    expect(await run('exampleapp://cb?__atlas_attempt=att_1&__atlas_ticket=t')).toMatchObject({ status: 'error', errors: [{ code: 'PKCE_REQUIRED' }] });
    expect(await run('exampleapp://cb?__atlas_attempt=other&__atlas_code=c')).toMatchObject({ status: 'error', errors: [{ code: 'ATTEMPT_MISMATCH' }] });
    const { client, calls } = fakeFapi(() => start.clone());
    const out = await signInWithNativeBrowser(client, { provider: 'discord', browser: browserReturning('x'), inWebView: true });
    expect(out).toMatchObject({ status: 'error', errors: [{ code: 'WEBVIEW_NOT_ALLOWED' }] });
    expect(calls).toHaveLength(0);
  });

  it('returns the server refusal from start', async () => {
    const { client } = fakeFapi(() => json(400, { errors: [{ code: 'CALLBACK_NOT_REGISTERED', message: 'nope' }] }));
    expect(await signInWithNativeBrowser(client, { provider: 'discord', browser: browserReturning('x') })).toMatchObject({ status: 'error', errors: [{ code: 'CALLBACK_NOT_REGISTERED' }] });
  });
});

describe('browser watch URL', () => {
  it('watches the app callback, not the hosted https hop', async () => {
    const { client } = fakeFapi(() => json(200, { authorization_url: 'https://p/auth', attempt_id: 'att_1', redirect_url: 'https://fapi.test/v1/oauth/native-callback/napp_1' }));
    const openAuthSession = vi.fn(async () => ({ type: 'cancel' as const }));
    await signInWithNativeBrowser(client, { provider: 'discord', browser: { openAuthSession }, callback: 'exampleapp://cb' });
    expect(openAuthSession).toHaveBeenCalledWith('https://p/auth', 'exampleapp://cb', { preferEphemeralSession: false });
  });
});

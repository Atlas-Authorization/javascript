import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from '@atlasauth/js';
import { exchangeLegacyToken } from './bridge';
import { createAppApprovalActions } from './app-approval';
import { signInWithApple } from './social';
import { createInMemoryStorage } from './token-cache';

// app-approval's hook module imports the React Native views; the actions under test need none of it.
vi.mock('./policies', () => ({ useExpoFapiClient: () => null }));

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const clientFor = (fn: (url: string, init: RequestInit) => Response) =>
  new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.test', fetchImpl: (async (u: string, i: RequestInit) => fn(u, i)) as unknown as typeof fetch });

describe('exchangeLegacyToken', () => {
  it('asks for body delivery, stores the session and clears the old token', async () => {
    let sent: any;
    const client = clientFor((_u, init) => { sent = JSON.parse(init.body as string); return reply({ object: 'session_tokens', session_id: 'sess_1', user_id: 'user_1', jwt: 'a.b.c', refresh_token: 'r1', expires_in: 60 }); });
    const storage = createInMemoryStorage();
    const clear = vi.fn();
    const out = await exchangeLegacyToken(client, { source: 'better_auth', token: 'legacy', clear, storage });
    expect(sent).toEqual({ token: 'legacy', delivery: 'body' });
    expect(out).toMatchObject({ status: 'complete', userId: 'user_1', session: { sessionId: 'sess_1', refreshToken: 'r1' } });
    expect(clear).toHaveBeenCalled();
    expect(await storage.getToken()).toContain('r1');
  });

  it('does nothing without a token and keeps the token on a retryable refusal', async () => {
    const client = clientFor(() => reply({ errors: [{ code: 'x', message: 'm', meta: { bridge_outcome: 'closed' } }] }, 400));
    expect(await exchangeLegacyToken(client, { source: 'firebase', token: null })).toEqual({ status: 'none' });
    const clear = vi.fn();
    expect(await exchangeLegacyToken(client, { source: 'firebase', token: 't', clear })).toEqual({ status: 'refused', outcome: 'closed' });
    expect(clear).not.toHaveBeenCalled();
  });
});

describe('createAppApprovalActions', () => {
  it('approves with the chosen number and denies', async () => {
    const calls: Array<[string, any]> = [];
    const client = clientFor((u, init) => { calls.push([u, JSON.parse((init.body as string) ?? 'null')]); return reply({ status: 'approved' }); });
    const a = createAppApprovalActions(client, 'apr_1');
    expect(await a.approve('42')).toBe(true);
    expect(await a.deny()).toBe(true);
    expect(calls[0]).toEqual(['https://fapi.test/v1/client/app_approvals/apr_1/respond', { action: 'approve', selected_number: '42' }]);
    expect(calls[1]![1]).toEqual({ action: 'deny' });
  });
});

describe('signInWithApple', () => {
  it('mints a nonce, sends the token and exchanges the ticket', async () => {
    const urls: string[] = [];
    const client = clientFor((u) => {
      urls.push(u);
      if (u.endsWith('/id_token/nonce')) return reply({ nonce: 'n1' });
      if (u.endsWith('/sign_ins/id_token')) return reply({ id: 'att_1', status: 'complete', ticket: 'tk' });
      return reply({ jwt: 'sess.jwt.x' });
    });
    const apple = { AppleAuthenticationScope: { EMAIL: 1, FULL_NAME: 0 }, signInAsync: vi.fn(async () => ({ identityToken: 'idt' })) };
    expect(await signInWithApple(client, apple)).toMatchObject({ status: 'complete', jwt: 'sess.jwt.x' });
    expect(apple.signInAsync).toHaveBeenCalledWith(expect.objectContaining({ nonce: 'n1' }));
    expect(urls).toHaveLength(3);
  });

  it('reports a dismissed sheet as cancelled', async () => {
    const client = clientFor(() => reply({ nonce: 'n1' }));
    const apple = { AppleAuthenticationScope: { EMAIL: 1, FULL_NAME: 0 }, signInAsync: vi.fn(async () => { throw new Error('cancel'); }) };
    expect((await signInWithApple(client, apple)).status).toBe('cancelled');
  });
});

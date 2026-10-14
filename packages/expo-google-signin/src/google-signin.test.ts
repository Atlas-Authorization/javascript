import { describe, expect, it } from 'vitest';
import { extractIdToken, signInWithGoogle } from './index';
import type { GoogleSignin } from './google-native';

describe('extractIdToken', () => {
  it('reads the v13 success envelope', () => {
    expect(extractIdToken({ type: 'success', data: { idToken: 'idt_1' } })).toBe('idt_1');
  });
  it('reads the older flat shape', () => {
    expect(extractIdToken({ idToken: 'idt_2' })).toBe('idt_2');
  });
  it('is null on cancel / absence', () => {
    expect(extractIdToken({ type: 'cancelled' })).toBeNull();
    expect(extractIdToken(null)).toBeNull();
    expect(extractIdToken({})).toBeNull();
  });
});

/** Route fake JSON responses by `METHOD /path`, recording request bodies. */
function router(handlers: Record<string, unknown>): {
  fetchImpl: typeof fetch;
  calls: Array<{ path: string; body: unknown }>;
} {
  const calls: Array<{ path: string; body: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
    calls.push({ path, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const data = handlers[path];
    return new Response(JSON.stringify(data ?? null), {
      status: data === undefined ? 404 : 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const google = (idToken: string | null): GoogleSignin => ({
  hasPlayServices: async () => true,
  signIn: async () => ({ type: 'success', data: { idToken } }),
});

const config = (fetchImpl: typeof fetch) => ({
  frontendApi: 'https://fapi.example.test',
  publishableKey: 'pk_test',
  fetchImpl,
});

describe('signInWithGoogle', () => {
  it('mints a nonce, signs in, and exchanges the ticket for a jwt', async () => {
    const { fetchImpl, calls } = router({
      '/v1/client/sign_ins/id_token/nonce': { nonce: 'nonce_1' },
      '/v1/client/sign_ins/id_token': { id: 'att_1', status: 'complete', ticket: 'tkt_1' },
      '/v1/client/tickets/exchange': { jwt: 'sess.jwt' },
    });

    const result = await signInWithGoogle({ config: config(fetchImpl), googleSignin: google('idt') });

    expect(result).toMatchObject({ status: 'complete', jwt: 'sess.jwt', ticket: 'tkt_1', attemptId: 'att_1' });
    // The id_token POST carried the minted nonce.
    const idTokenCall = calls.find((c) => c.path === '/v1/client/sign_ins/id_token');
    expect(idTokenCall?.body).toMatchObject({ provider: 'google', id_token: 'idt', nonce: 'nonce_1' });
  });

  it('is cancelled when Google returns no id_token', async () => {
    const { fetchImpl } = router({ '/v1/client/sign_ins/id_token/nonce': { nonce: 'n' } });
    const result = await signInWithGoogle({
      config: config(fetchImpl),
      googleSignin: google(null),
    });
    expect(result.status).toBe('cancelled');
  });

  it('returns needs_more when a second factor is owed', async () => {
    const { fetchImpl } = router({
      '/v1/client/sign_ins/id_token/nonce': { nonce: 'n' },
      '/v1/client/sign_ins/id_token': { id: 'att_2', status: 'needs_second_factor' },
    });
    const result = await signInWithGoogle({
      config: config(fetchImpl),
      googleSignin: google('idt'),
      useNonce: true,
    });
    expect(result).toMatchObject({ status: 'needs_more', attemptId: 'att_2', attemptStatus: 'needs_second_factor' });
  });
});

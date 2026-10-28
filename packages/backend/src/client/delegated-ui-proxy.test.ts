import { describe, expect, it, vi } from 'vitest';
import { delegatedUiProxy } from './delegated-ui-proxy';

const atlas = () => ({
  oauthClients: {
    loginRequests: { get: vi.fn(async () => ({ ok: 1 })), accept: vi.fn(async (_c: string, b: unknown) => b), reject: vi.fn(async () => ({ r: 1 })) },
    consentRequests: { get: vi.fn(async () => ({ ok: 2 })), accept: vi.fn(async () => ({ a: 1 })), reject: vi.fn(async () => ({ r: 2 })) },
  },
}) as never;

describe('delegatedUiProxy', () => {
  it('the subject comes from authorize(), never from the browser body', async () => {
    const a = atlas();
    const h = delegatedUiProxy(a, { authorize: () => 'usr_real' });
    const res = await h({ method: 'POST', path: 'login/accept', query: { login_challenge: 'c' }, body: { subject: 'usr_forged', remember: true } });
    expect(res.body).toEqual({ subject: 'usr_real', remember: true });
  });
  it('refuses an accept when authorize returns null, and 404s unknown routes', async () => {
    const h = delegatedUiProxy(atlas(), { authorize: () => null });
    expect((await h({ method: 'POST', path: 'consent/accept', query: { consent_challenge: 'c' } })).status).toBe(401);
    expect((await h({ method: 'GET', path: 'nope', query: {} })).status).toBe(404);
    expect((await h({ method: 'GET', path: '/login', query: { login_challenge: 'c' } })).body).toEqual({ ok: 1 });
  });
});

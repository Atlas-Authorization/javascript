import { describe, expect, it } from 'vitest';
import { createDpopClient } from './dpop';
import { hasToken } from './has-token';

const dec = (p: string) => JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));

describe('createDpopClient', () => {
  it('signs a verifiable proof with ath and htu without the query', async () => {
    const c = createDpopClient();
    const jwt = await c.proof('post', 'https://api.example.com/a?x=1', { accessToken: 'tok' });
    const [h, p, s] = jwt.split('.');
    const header = dec(h!);
    expect(header.typ).toBe('dpop+jwt');
    const payload = dec(p!);
    expect(payload).toMatchObject({ htm: 'POST', htu: 'https://api.example.com/a' });
    expect(payload.ath).toBeTruthy();
    const pub = await crypto.subtle.importKey('jwk', header.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const sig = Uint8Array.from(atob(s!.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, new TextEncoder().encode(`${h}.${p}`));
    expect(ok).toBe(true);
  });

  it('retries once with the server nonce', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const f = (async (_u: unknown, init: RequestInit) => {
      const proof = new Headers(init.headers).get('DPoP')!;
      seen.push(dec(proof.split('.')[1]!));
      return seen.length === 1
        ? new Response('{}', { status: 401, headers: { 'DPoP-Nonce': 'n1' } })
        : new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const res = await createDpopClient({ fetch: f }).fetch('https://api.example.com/r', { accessToken: 't' });
    expect(res.status).toBe(200);
    expect(seen[0]!.nonce).toBeUndefined();
    expect(seen[1]!.nonce).toBe('n1');
  });
});

describe('hasToken', () => {
  it('answers has({feature}) from a token payload', () => {
    const b = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '');
    const jwt = `${b({ alg: 'none' })}.${b({ sub: 'u', pla: 'pro', fea: ['exports'] })}.x`;
    expect(hasToken(jwt, { feature: 'exports' })).toBe(true);
    expect(hasToken(jwt, { plan: 'free' })).toBe(false);
    expect(hasToken(null, { feature: 'exports' })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { captureAttributionFields } from './attribution-fields';

describe('captureAttributionFields', () => {
  it('reads read(), skips empty and swallows throwing sources', () => {
    expect(
      captureAttributionFields({
        a: { read: () => 'tok' },
        b: { read: () => '' },
        c: { read: () => { throw new Error('x'); } },
      }),
    ).toEqual({ a: 'tok' });
  });
  it('reads a cookie, a query parameter and a global function', () => {
    const doc = { cookie: 'x=1; sv=a%20b' };
    (globalThis as any).window = { location: { search: '?q=z' }, seo: (a: string) => `v-${a}` };
    (globalThis as any).document = doc;
    try {
      expect(
        captureAttributionFields({ c: { cookie: 'sv' }, q: { query: 'q' }, g: { global: 'seo', globalArg: 'visit' } }),
      ).toEqual({ c: 'a b', q: 'z', g: 'v-visit' });
    } finally {
      delete (globalThis as any).window;
      delete (globalThis as any).document;
    }
  });
  it('is empty with no options', () => {
    expect(captureAttributionFields(undefined)).toEqual({});
  });
});

import { FapiClient, startSignUp, updateSignUp } from './fapi';

describe('attribution on sign-up', () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: 'att_1', object: 'sign_up_attempt', status: 'needs_email_verification' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const client = new FapiClient({
    publishableKey: 'pk_test_abc',
    baseUrl: 'https://fapi.test',
    fetchImpl,
    referral: false,
    attribution: { seolyticize_visit: { read: () => 'v_9' } },
  });

  it('writes captured values to unsafe_metadata; the caller wins', async () => {
    calls.length = 0;
    await startSignUp(client, { email: 'a@b.co', password: 'pw', unsafeMetadata: { plan: 'x', seolyticize_visit: 'mine' } });
    expect(JSON.parse(String(calls[0]!.init.body)).unsafe_metadata).toEqual({ seolyticize_visit: 'mine', plan: 'x' });
    calls.length = 0;
    await startSignUp(client, { email: 'a@b.co', password: 'pw' });
    expect(JSON.parse(String(calls[0]!.init.body)).unsafe_metadata).toEqual({ seolyticize_visit: 'v_9' });
  });

  it('updateSignUp PATCHes the attempt', async () => {
    calls.length = 0;
    await updateSignUp(client, 'att_1', { unsafeMetadata: { a: 1 } });
    expect(calls[0]!.url).toContain('/v1/client/sign_ups/att_1');
    expect(calls[0]!.init.method).toBe('PATCH');
  });
});

describe('attribution on every account-creating start', () => {
  it('rides on OAuth, SSO and native starts, not on other calls', async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const c = new FapiClient({
      publishableKey: 'pk_test_abc',
      baseUrl: 'https://fapi.test',
      referral: false,
      attribution: { v: { read: () => 't' } },
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, body: String(init.body) });
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
    });
    for (const p of ['/v1/client/sign_ins/oauth', '/v1/client/sign_ins/saml', '/v1/client/sign_ins/id_token', '/v1/client/sign_ins']) await c.post(p, { x: 1 });
    await c.post('/v1/client/me', { x: 1 });
    expect(seen.slice(0, 4).every((s) => JSON.parse(s.body).unsafe_metadata?.v === 't')).toBe(true);
    expect(JSON.parse(seen[4]!.body).unsafe_metadata).toBeUndefined();
  });
});

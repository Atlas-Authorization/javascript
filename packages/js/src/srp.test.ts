import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { signInWithSrp, srpClientStart } from './srp';

/**
 * Known-answer vector from an independent SRP implementation (the srptools reference
 * library: RFC 5054 3072-bit group, SHA-256), with the client/server proofs the Atlas
 * server computes for it.
 */
const V = {
  I: 'user-0001',
  P: 'correct horse battery staple',
  s: '7A1C4E90B2D35F68A9E01C7B3D5F2A84',
  a: '5E3B1A9C7D2F4860B3A5C1E7D9F20846A1B3C5D7E9F0123456789ABCDEF01234',
  A: 'c1da92fed3cfffc93c8b4ac34a28443302bf71ae2c21c2c051bd5b5d89b5cc8d0ab7b3235a58a62dbeb75d181a9c4db706ff990dabccca489aa512d1daf1b999f187b9bab8f6dfe33d45464e87903880e63a127e755aa601a056b005976f84a3d48580e240fa554fcd7f46e8a9225c5c6bd12baa3767772f179f2f2d6f5e02c7974d6d6caf5f7ed1d087c35d57f438f60f7763c45886d47aaf4906ca935a2e1a52aa3be450e710bf96ba21a810da5fac9a806649459eb92f846f3e31995d98ef87cb43f6404de056b41b460d99433d1c1d87e77bdc54ca80e3b84177c9757c01225c3d3cf1f76951acc36ec3ba4ce14bcae455ee9f5b9be15e10730cd98eb020b5a1d91433c7a18e1d5c82d9f48c8df012657183d214542da87700b8d3cdfdb877331e79b801da809ee404fd17c24529cfee84094f8228e7252bd9d49220809cb6525bdcc24f38a0ff066584adfd9652982becb71c83b11b4d77ab768b29112ab8ca5cb58e7de0542de1989827ee69d43aa878eee2be7a3db4fd3ee36da0c5e7',
  B: '5ac16975cb584bcad303afee289d84edf2dddcb6994429e5c35871fd30db3da8e92f89fd0a9f6f7970d3e0e25b2a33bd361fbd514c1cd2d4131c4ca821c658ebb088becac3460ad577fde7693a53a1bee799d9f1ce36e8dc139d2baa5108c22a2bb825d59181cd3194d76e8e5c01372de118ade1f9c0a0042aa533902cb7fc6515ba5f31832906be6abda55a6d5633204118ca3f3a6dff84a07a1c85c4a618b907361c77b60d45a650f3cb5789ac95372a31684da812c49d2784371be574e4c0d6490ab46d6213915ac3ae312abfe4d59a0cc7aab6dee2660c50694996c77301c69b038678d15d9dba6a14169e92f95a36758ef3b08c95632fcaf610057eb353679621166c5218eb76cf04af25369e328bfdcfe73b7ecea95bc96ce81ef0edb3bde0336522e4c49bc2e0ec7168c1847a40ad01da2df346b36aa1fff2296bc80f1806cd38c2f268101776e615ef0defab0ee449d13f68a957f4cc4dfb9a3e2bdce5bb9a8f94fba852ae906c3f108f783d6ee263a489814b62dcc582d252e70c43',
  M1: '85c66379f8a80b2127f8b4fdcb92003666ed2f2459d0b72de20fc650bcea8d17',
  M2: 'bc56df87a7b2c6962feaf8d1ee054152684335808c1876891c9106ef8a79e541',
};
const strip0 = (h: string) => h.replace(/^0+/, '');

describe('SRP client', () => {
  it('matches the reference public value and produces the server-compatible proofs', async () => {
    const c = srpClientStart(BigInt('0x' + V.a));
    expect(c.A).toBe(strip0(V.A));
    const r = await c.respond({ salt: V.s.toLowerCase(), srp_b: V.B, user_id_for_srp: V.I }, V.P);
    expect(r).toEqual({ M1: V.M1, M2: V.M2 });
  });

  it('rejects a server public value of zero', async () => {
    const c = srpClientStart(BigInt(5));
    await expect(c.respond({ salt: 'aa', srp_b: '0', user_id_for_srp: 'u' }, 'p')).rejects.toThrow();
  });

  it('a wrong password gives a different proof', async () => {
    const c = srpClientStart(BigInt('0x' + V.a));
    const r = await c.respond({ salt: V.s.toLowerCase(), srp_b: V.B, user_id_for_srp: V.I }, 'wrong');
    expect(r.M1).not.toBe(V.M1);
  });
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function server(handlers: Record<string, (body: Record<string, unknown>) => Response>) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path, body });
    const h = handlers[path];
    return h ? h(body) : json(404, { errors: [{ code: 'NOT_FOUND', message: 'no' }] });
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl, referral: false }), calls };
}

const challenge = () => json(200, { object: 'srp_challenge', srp_session: 'sess1', user_id_for_srp: V.I, salt: V.s.toLowerCase(), srp_b: V.B });

describe('signInWithSrp', () => {
  it('runs challenge then verify and checks the server proof', async () => {
    const { client, calls } = server({
      '/v1/client/sign_ins/att1/srp_challenge': () => challenge(),
      '/v1/client/sign_ins/att1/srp_verify': (b) =>
        b.srp_m1 === V.M1 ? json(200, { id: 'att1', status: 'complete', ticket: 't1', srp_m2: V.M2 }) : json(400, { errors: [{ code: 'VERIFICATION_FAILED', message: 'x' }] }),
    });
    const r = await signInWithSrp(client, { identifier: V.I, password: V.P, attemptId: 'att1', privateKey: BigInt('0x' + V.a) });
    expect(r.ok).toBe(true);
    expect(r.serverVerified).toBe(true);
    expect(r.method).toBe('srp');
    expect((r.data as { ticket: string }).ticket).toBe('t1');
    expect(calls[0]!.body.srp_a).toBe(strip0(V.A));
    expect(JSON.stringify(calls)).not.toContain(V.P);
  });

  it('refuses a server that cannot prove the verifier', async () => {
    const { client } = server({
      '/v1/client/sign_ins/att1/srp_challenge': () => challenge(),
      '/v1/client/sign_ins/att1/srp_verify': () => json(200, { id: 'att1', status: 'complete', ticket: 't1', srp_m2: '00' }),
    });
    const r = await signInWithSrp(client, { identifier: V.I, password: V.P, attemptId: 'att1', privateKey: BigInt('0x' + V.a) });
    expect(r.ok).toBe(false);
    expect(r.serverVerified).toBe(false);
  });

  it('starts an attempt when none is given and can fall back to the password', async () => {
    const { client, calls } = server({
      '/v1/client/sign_ins': () => json(201, { id: 'att2', status: 'needs_first_factor' }),
      '/v1/client/sign_ins/att2/srp_challenge': () => challenge(),
      '/v1/client/sign_ins/att2/srp_verify': () => json(400, { errors: [{ code: 'VERIFICATION_FAILED', message: 'no' }] }),
      '/v1/client/sign_ins/att2/attempt_first_factor': () => json(200, { id: 'att2', status: 'complete', ticket: 't2' }),
    });
    const noFallback = await signInWithSrp(client, { identifier: 'a@b.c', password: V.P });
    expect(noFallback.ok).toBe(false);
    expect(noFallback.method).toBe('srp');
    const r = await signInWithSrp(client, { identifier: 'a@b.c', password: V.P, attemptId: 'att2', fallbackToPassword: true });
    expect(r.ok).toBe(true);
    expect(r.method).toBe('password');
    expect(calls.at(-1)!.body).toEqual({ strategy: 'password', password: V.P });
  });

  it('falls back when SRP is not enabled for the app', async () => {
    const { client } = server({
      '/v1/client/sign_ins/att3/srp_challenge': () => json(422, { errors: [{ code: 'STRATEGY_DISABLED', message: 'off' }] }),
      '/v1/client/sign_ins/att3/attempt_first_factor': () => json(200, { id: 'att3', status: 'complete', ticket: 't3' }),
    });
    const r = await signInWithSrp(client, { identifier: 'a@b.c', password: 'pw', attemptId: 'att3', fallbackToPassword: true });
    expect(r.method).toBe('password');
    expect(r.ok).toBe(true);
  });
});

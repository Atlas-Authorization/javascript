import { describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { StepUpAssertion } from './client/step-up';
import { requireStepUp, verifyStepUpReceipt } from './step-up-gate';

const allowed: StepUpAssertion = {
  object: 'step_up_assertion',
  allowed: true,
  reason: null,
  policy: 'wire_transfer',
  user_id: 'user_1',
  session_id: 'sess_1',
  seconds_since_authentication: 5,
  receipt: 'r.e.c',
};
const denied = (reason: StepUpAssertion['reason'], step_up?: StepUpAssertion['step_up']): StepUpAssertion => ({ ...allowed, allowed: false, reason, receipt: undefined, step_up });
const gate = (assertion: StepUpAssertion) => {
  const assert = vi.fn(async () => assertion);
  return { assert, check: requireStepUp({ client: { stepUp: { assert } }, policy: 'wire_transfer', audience: 'payments' }) };
};

describe('requireStepUp', () => {
  it('lets an allowed assertion through and sends the token, policy and audience', async () => {
    const { assert, check } = gate(allowed);
    const out = await check({ headers: { authorization: 'Bearer tok' } });
    expect(out.allowed).toBe(true);
    expect(assert).toHaveBeenCalledWith({ token: 'tok', policy: 'wire_transfer', audience: 'payments' });
  });

  it('reads the token from the __session cookie too', async () => {
    const { assert, check } = gate(allowed);
    await check({ headers: { cookie: 'a=1; __session=cookietok' } });
    expect(assert).toHaveBeenCalledWith(expect.objectContaining({ token: 'cookietok' }));
  });

  it('a request with no token is 401 and never asks Atlas', async () => {
    const { assert, check } = gate(allowed);
    expect(await check({ headers: {} })).toMatchObject({ allowed: false, status: 401 });
    expect(assert).not.toHaveBeenCalled();
  });

  it('a denial is 403 STEP_UP_REQUIRED carrying the policy and the factors to ask for', async () => {
    const meta = { action: 'policy', policy: 'wire_transfer', accepted_factors: ['passkey'], max_age_seconds: 120 };
    const { check } = gate(denied('stale', meta));
    const out = await check({ headers: { authorization: 'Bearer tok' } });
    expect(out).toMatchObject({ allowed: false, status: 403 });
    if (!out.allowed) expect(out.body.errors[0]).toMatchObject({ code: 'STEP_UP_REQUIRED', meta });
  });

  it('a dead or foreign session is 401, not a step-up prompt', async () => {
    expect(await gate(denied('session_inactive')).check({ headers: { authorization: 'Bearer t' } })).toMatchObject({ allowed: false, status: 401 });
    expect(await gate(denied('invalid_token')).check({ headers: { authorization: 'Bearer t' } })).toMatchObject({ allowed: false, status: 401 });
  });

  it('a failing call is an error, never an allow', async () => {
    const check = requireStepUp({ client: { stepUp: { assert: async () => { throw new Error('boom'); } } }, policy: 'p' });
    await expect(check({ headers: { authorization: 'Bearer t' } })).rejects.toThrow('boom');
  });

  it('an allowed answer without a receipt is not an allow', async () => {
    const out = await gate({ ...allowed, receipt: undefined }).check({ headers: { authorization: 'Bearer t' } });
    expect(out.allowed).toBe(false);
  });
});

describe('verifyStepUpReceipt', () => {
  const ISS = 'https://auth.example.com';
  async function setup() {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' }] };
    const mint = (over: Record<string, unknown> = {}, typ = 'step-up-receipt+jwt', aud = 'payments', key = privateKey) =>
      new SignJWT({ token_use: 'step_up_receipt', policy: 'wire_transfer', sid: 'sess_1', jti: 'j1', auth_time: 1, amr: ['webauthn'], acr: 'urn:atlas:acr:step_up', ...over })
        .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ })
        .setIssuer(ISS)
        .setSubject('user_1')
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime('1m')
        .sign(key);
    return { jwks, mint };
  }

  it('accepts a good receipt and checks the policy, audience, user and session when asked', async () => {
    const { jwks, mint } = await setup();
    const r = await verifyStepUpReceipt(await mint(), { issuer: ISS, jwks, policy: 'wire_transfer', audience: 'payments', userId: 'user_1', sessionId: 'sess_1' });
    expect(r.ok && r.claims.jti).toBe('j1');
  });

  it('refuses another policy, audience, user, a wrong typ, a session-style token and a foreign signer', async () => {
    const { jwks, mint } = await setup();
    const base = { issuer: ISS, jwks };
    expect((await verifyStepUpReceipt(await mint(), { ...base, policy: 'other' })).ok).toBe(false);
    expect((await verifyStepUpReceipt(await mint(), { ...base, audience: 'elsewhere' })).ok).toBe(false);
    expect((await verifyStepUpReceipt(await mint(), { ...base, userId: 'user_2' })).ok).toBe(false);
    expect((await verifyStepUpReceipt(await mint({}, 'JWT'), base)).ok).toBe(false);
    expect((await verifyStepUpReceipt(await mint({ token_use: 'session' }), base)).ok).toBe(false);
    const foreign = await generateKeyPair('ES256');
    expect((await verifyStepUpReceipt(await mint({}, 'step-up-receipt+jwt', 'payments', foreign.privateKey), base)).ok).toBe(false);
  });
});

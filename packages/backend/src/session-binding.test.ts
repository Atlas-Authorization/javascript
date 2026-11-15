import { describe, expect, it } from 'vitest';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { memoryDpopReplayStore } from './oauth-resource';
import { sessionBindingOf, verifyBoundSession } from './session-binding';

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const sha = async (s: string) => b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  const jkt = await calculateJwkThumbprint(jwk, 'sha256');
  const token = 'session.jwt.value';
  const proof = async (over: Record<string, unknown> = {}, key = privateKey, k = jwk) =>
    new SignJWT({ jti: crypto.randomUUID(), htm: 'GET', htu: 'https://api.example.test/orders', iat: Math.floor(Date.now() / 1000), ath: await sha(token), ...over })
      .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: k })
      .sign(key);
  return { jkt, token, proof };
}

describe('session token binding', () => {
  it('reads cnf.jkt', () => {
    expect(sessionBindingOf({ cnf: { jkt: 'abc' } })).toEqual({ jkt: 'abc' });
    expect(sessionBindingOf({})).toBeNull();
  });

  it('passes a bearer session token', async () => {
    const r = await verifyBoundSession({ claims: {}, token: 't', proof: undefined, method: 'GET', url: 'https://x.test/a' });
    expect(r).toEqual({ ok: true, bound: false, jkt: null });
  });

  it('refuses a bound token with no proof', async () => {
    const { jkt, token } = await setup();
    const r = await verifyBoundSession({ claims: { cnf: { jkt } }, token, proof: undefined, method: 'GET', url: 'https://api.example.test/orders' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('missing_proof');
  });

  it('accepts a proof from the bound key and refuses its replay', async () => {
    const { jkt, token, proof } = await setup();
    const replayStore = memoryDpopReplayStore();
    const p = await proof();
    const input = { claims: { cnf: { jkt } }, token, proof: p, method: 'GET', url: 'https://api.example.test/orders?x=1', replayStore };
    expect((await verifyBoundSession(input)).ok).toBe(true);
    const again = await verifyBoundSession(input);
    expect(again.ok).toBe(false);
  });

  it('refuses a proof from another key, for another URL, method or token', async () => {
    const { jkt, token, proof } = await setup();
    const other = await generateKeyPair('ES256');
    const otherJwk = await exportJWK(other.publicKey);
    const wrongKey = await proof({}, other.privateKey, otherJwk);
    const base = { claims: { cnf: { jkt } }, token, method: 'GET', url: 'https://api.example.test/orders', replayStore: memoryDpopReplayStore() };
    expect((await verifyBoundSession({ ...base, proof: wrongKey })).ok).toBe(false);
    expect((await verifyBoundSession({ ...base, proof: await proof({ htu: 'https://api.example.test/other' }) })).ok).toBe(false);
    expect((await verifyBoundSession({ ...base, proof: await proof({ htm: 'POST' }) })).ok).toBe(false);
    expect((await verifyBoundSession({ ...base, proof: await proof({ ath: await sha('another.token') }) })).ok).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createDpopProof, dpopThumbprint, generateDpopKey } from './machine-dpop';
import { awsIdentityProof, federateMachineToken, githubActionsToken } from './machine-workload';
import { createMachineClient, memoryMachineStore } from './machine-client';

describe('DPoP proofs for a machine', () => {
  it('signs a proof that verifies against its own key, names the request and the token, and matches the thumbprint', async () => {
    const pem = generateDpopKey();
    const proof = createDpopProof({ privateKeyPem: pem, method: 'get', url: 'https://api.example.com/orders?x=1', accessToken: 'tok', nonce: 'n1', now: () => 1_700_000_000_000 });
    const header = decodeProtectedHeader(proof);
    expect(header).toMatchObject({ typ: 'dpop+jwt', alg: 'EdDSA' });
    const key = await importJWK(header.jwk!, 'EdDSA');
    const { payload } = await jwtVerify(proof, key, { typ: 'dpop+jwt', currentDate: new Date(1_700_000_000_000) });
    expect(payload).toMatchObject({ htm: 'GET', htu: 'https://api.example.com/orders', iat: 1_700_000_000, nonce: 'n1', ath: createHash('sha256').update('tok').digest('base64url') });
    expect(payload.jti).toEqual(expect.any(String));
    expect(await calculateJwkThumbprint(header.jwk!, 'sha256')).toBe(dpopThumbprint(pem));
  });

  it('supports a P-256 key and refuses other key types', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const proof = createDpopProof({ privateKeyPem: ec, method: 'POST', url: 'https://x.example.com/' });
    expect(decodeProtectedHeader(proof).alg).toBe('ES256');
    const header = decodeProtectedHeader(proof);
    await expect(jwtVerify(proof, await importJWK(header.jwk!, 'ES256'), { typ: 'dpop+jwt' })).resolves.toBeDefined();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => createDpopProof({ privateKeyPem: rsa, method: 'GET', url: 'https://x.example.com/' })).toThrow(/Ed25519 or P-256/);
  });
});

describe('the machine client with a DPoP key', () => {
  it('sends a proof for the token request and reports the token type', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const identity = { issuer: 'https://id.example.com', machine_id: 'mch_1', private_key_pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), enrolled_at: 1 };
    const seen: Array<{ url: string; dpop?: string }> = [];
    const f = (async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url, dpop: headers.dpop });
      return Response.json(url.endsWith('/challenge') ? { nonce: 'n' } : { token: 't', token_type: 'DPoP', expires_in: 600 });
    }) as unknown as typeof fetch;
    const client = createMachineClient({ issuer: 'https://id.example.com', store: memoryMachineStore(identity), fetch: f, dpopKey: true });
    const t = await client.getToken();
    expect(t.tokenType).toBe('DPoP');
    expect(seen[0]!.dpop).toBeUndefined();
    expect(decodeProtectedHeader(seen[1]!.dpop!)).toMatchObject({ typ: 'dpop+jwt' });
    expect(client.dpopThumbprint()).toEqual(expect.any(String));
    expect(client.dpopProof({ token: t.token, method: 'GET', url: 'https://api.example.com/x' })).toEqual(expect.any(String));
    const plain = createMachineClient({ issuer: 'https://id.example.com', store: memoryMachineStore(identity), fetch: f });
    expect(() => plain.dpopProof({ token: 't', method: 'GET', url: 'https://x.example.com/' })).toThrow(/dpopKey/);
  });
});

describe('workload federation helpers', () => {
  it('signs a GetCallerIdentity request that names the audience in its signed headers', () => {
    const proof = awsIdentityProof({ audience: 'my-aud', region: 'eu-west-1', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'st' }, now: () => Date.UTC(2026, 0, 2, 3, 4, 5) });
    expect(proof).toMatchObject({ method: 'POST', url: 'https://sts.eu-west-1.amazonaws.com/', body: 'Action=GetCallerIdentity&Version=2011-06-15' });
    expect(proof.headers['x-amz-date']).toBe('20260102T030405Z');
    expect(proof.headers['x-atlas-audience']).toBe('my-aud');
    expect(proof.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260102\/eu-west-1\/sts\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-atlas-audience, Signature=[0-9a-f]{64}$/);
  });

  it('exchanges a platform token and reads the GitHub token from the runner environment', async () => {
    const calls: Array<{ url: string; body?: string; headers: Record<string, string> }> = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.includes('actions.example')) return Response.json({ value: 'gh-jwt' });
      return Response.json({ token: 'm2m', token_type: 'Bearer', expires_in: 120, audience: 'https://api' });
    }) as unknown as typeof fetch;
    const gh = await githubActionsToken('https://id.example.com', { env: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example/token?x=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'rt' }, fetch: f });
    expect(gh).toBe('gh-jwt');
    expect(calls[0]!.url).toBe('https://actions.example/token?x=1&audience=https%3A%2F%2Fid.example.com');
    const out = await federateMachineToken({ issuer: 'https://id.example.com/', machineId: 'mch_1', token: gh, audience: 'https://api', scopes: ['a'], fetch: f, now: () => 1000 });
    expect(out).toMatchObject({ token: 'm2m', tokenType: 'Bearer', expiresAt: 121_000, audience: 'https://api' });
    expect(calls[1]!.url).toBe('https://id.example.com/v1/machines/federate');
    expect(JSON.parse(calls[1]!.body!)).toEqual({ machine_id: 'mch_1', token: 'gh-jwt', audience: 'https://api', scopes: ['a'] });
    await expect(githubActionsToken('a', { env: {}, fetch: f })).rejects.toThrow(/id-token/);
    await expect(federateMachineToken({ issuer: 'https://id.example.com', machineId: 'm', fetch: f })).rejects.toThrow(/token.*aws/);
    const denied = (async () => Response.json({ errors: [{ message: 'No trust policy of this machine accepts that token.' }] }, { status: 403 })) as unknown as typeof fetch;
    await expect(federateMachineToken({ issuer: 'https://id.example.com', machineId: 'm', token: 't', fetch: denied })).rejects.toMatchObject({ status: 403 });
  });
});

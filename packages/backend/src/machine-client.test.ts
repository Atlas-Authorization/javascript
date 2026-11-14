import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MachineClientError,
  createMachineClient,
  fileMachineStore,
  memoryMachineStore,
  publicKeyPemOf,
  signMachineChallenge,
  type MachineIdentity,
} from './machine-client';

// RFC 8032 section 7.1, TEST 1: a published Ed25519 key and the signature over the empty message.
const PRIVATE_PEM = `-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g\n-----END PRIVATE KEY-----\n`;
const PUBLIC_PEM = `-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=\n-----END PUBLIC KEY-----\n`;
const RFC8032_TEST1_SIG =
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';

describe('challenge signature (wire spec)', () => {
  it('is pure Ed25519 over the nonce bytes, base64url: the RFC 8032 vector for the empty message', () => {
    expect(signMachineChallenge(PRIVATE_PEM, '')).toBe(Buffer.from(RFC8032_TEST1_SIG, 'hex').toString('base64url'));
  });
  it('verifies for a real nonce with a stock Ed25519 verifier, and re-derives the public key', () => {
    const nonce = 'eyJtY2giOiJtY2hfMSJ9.c2lnbmF0dXJl';
    const sig = signMachineChallenge(PRIVATE_PEM, nonce);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(cryptoVerify(null, Buffer.from(nonce), createPublicKey(PUBLIC_PEM), Buffer.from(sig, 'base64url'))).toBe(true);
    expect(cryptoVerify(null, Buffer.from(`${nonce}x`), createPublicKey(PUBLIC_PEM), Buffer.from(sig, 'base64url'))).toBe(false);
    expect(publicKeyPemOf(PRIVATE_PEM).trim()).toBe(PUBLIC_PEM.trim());
  });
});

/** A fake Atlas: enrol, challenge, token. The challenge is verified with the key the device registered. */
function fakeServer() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let publicPem = '';
  let mints = 0;
  const handler = (async (url: string, init: { body: string }) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ path, body });
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status });
    if (path === '/v1/machines/enroll') {
      if (body.enrolment_token === 'bad') return json(401, { errors: [{ code: 'enrolment_token_invalid', message: 'The enrolment token is invalid or expired.' }] });
      publicPem = body.public_key_pem as string;
      return json(201, { object: 'machine', id: 'mch_1', status: 'active', approval_required: false, enrolled_at: 1000 });
    }
    if (path === '/v1/machines/challenge') return json(200, { object: 'machine_challenge', nonce: `nonce-${calls.length}`, expires_in_seconds: 120 });
    if (path === '/v1/machines/token') {
      const ok = cryptoVerify(null, Buffer.from(body.nonce as string), createPublicKey(publicPem), Buffer.from(body.signature as string, 'base64url'));
      if (!ok) return json(400, { errors: [{ code: 'validation_failed', message: 'The signature does not verify against the registered key.' }] });
      mints++;
      return json(200, { object: 'machine_token', token: `tok-${mints}`, token_type: 'Bearer', expires_in: 600, machine_id: 'mch_1', ...(body.audience ? { audience: body.audience } : {}) });
    }
    return json(404, {});
  }) as unknown as typeof fetch;
  return { calls, handler, mints: () => mints };
}

describe('createMachineClient', () => {
  it('enrols with a generated key, stores the identity, and mints tokens that verify', async () => {
    const server = fakeServer();
    const store = memoryMachineStore();
    const c = createMachineClient({ issuer: 'https://id.example.com/', store, fetch: server.handler, now: () => 1_000_000 });
    expect(await c.isEnrolled()).toBe(false);
    await expect(c.getToken()).rejects.toMatchObject({ code: 'not_enrolled' });
    expect(await c.enroll({ credential: ' ABCD-EFGH ', name: 'edge-1', deviceKey: 'dev-1' })).toEqual({ machineId: 'mch_1', status: 'active', approvalRequired: false });
    expect(server.calls[0]).toMatchObject({ path: '/v1/machines/enroll', body: { enrolment_token: 'ABCD-EFGH', name: 'edge-1', device_key: 'dev-1' } });
    expect(String(server.calls[0]!.body.public_key_pem)).toContain('BEGIN PUBLIC KEY');
    const id = (await store.load()) as MachineIdentity;
    expect(id).toMatchObject({ issuer: 'https://id.example.com', machine_id: 'mch_1' });
    expect(publicKeyPemOf(id.private_key_pem)).toBe(id.public_key_pem);
    expect((await c.getToken({ audience: 'https://api.example.com' })).token).toBe('tok-1');
  });

  it('caches a token until shortly before it expires, per request shape, and shares concurrent mints', async () => {
    const server = fakeServer();
    let t = 0;
    const c = createMachineClient({ issuer: 'https://id.example.com', store: memoryMachineStore(), fetch: server.handler, now: () => t });
    await c.enroll({ credential: 'met_x', name: 'm' });
    const [a, b] = await Promise.all([c.getToken({ audience: 'api' }), c.getToken({ audience: 'api' })]);
    expect(a.token).toBe(b.token);
    expect(server.mints()).toBe(1);
    t = 530_000; // 70 s left: still cached
    expect((await c.getToken({ audience: 'api' })).token).toBe('tok-1');
    t = 545_000; // inside the 60 s refresh window
    expect((await c.getToken({ audience: 'api' })).token).toBe('tok-2');
    expect((await c.getToken({ audience: 'other' })).token).toBe('tok-3');
    expect((await c.getToken({ audience: 'api', scopes: ['b', 'a'] })).token).toBe('tok-4');
    expect((await c.getToken({ audience: 'api', scopes: ['a', 'b'] })).token).toBe('tok-4');
    const last = server.calls.filter((x) => x.path === '/v1/machines/token').at(-1)!;
    expect(last.body).toMatchObject({ machine_id: 'mch_1', audience: 'api', scopes: ['b', 'a'] });
    c.clearTokens();
    expect((await c.getToken({ audience: 'api' })).token).toBe('tok-5');
  });

  it('surfaces a refusal with its status and code, and ignores an identity from another issuer', async () => {
    const server = fakeServer();
    const store = memoryMachineStore();
    const c = createMachineClient({ issuer: 'https://id.example.com', store, fetch: server.handler });
    await expect(c.enroll({ credential: 'bad', name: 'm' })).rejects.toEqual(expect.objectContaining({ status: 401, code: 'enrolment_token_invalid' }));
    expect(await store.load()).toBeNull();
    await c.enroll({ credential: 'ok', name: 'm' });
    const other = createMachineClient({ issuer: 'https://other.example.com', store, fetch: server.handler });
    expect(await other.isEnrolled()).toBe(false);
    await c.reset();
    expect(await c.isEnrolled()).toBe(false);
    expect(new MachineClientError(1, null, 'x').name).toBe('MachineClientError');
  });

  it('keeps the identity file private', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machine-'));
    const file = join(dir, 'sub', 'machine.json');
    const store = fileMachineStore(file);
    expect(await store.load()).toBeNull();
    await store.save({ issuer: 'https://id.example.com', machine_id: 'mch_1', private_key_pem: PRIVATE_PEM, public_key_pem: PUBLIC_PEM, enrolled_at: 1 });
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe('600');
    expect(JSON.parse(await readFile(file, 'utf8')).machine_id).toBe('mch_1');
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});

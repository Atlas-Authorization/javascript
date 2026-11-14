import { describe, expect, it } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { createEdgeRevocationChecker, StatusListError, verifyStatusListToken } from './status-list';

const b64 = (b: Uint8Array | string) => Buffer.from(b).toString('base64url');
const hashOf = (sid: string) => createHash('sha256').update(sid).digest().subarray(0, 8);

async function rsaKey() {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  return { pair, jwk };
}

async function ecKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k2', alg: 'ES256', use: 'sig' };
  return { pair, jwk };
}

async function sign(
  pair: { privateKey: webcrypto.CryptoKey; publicKey: webcrypto.CryptoKey },
  alg: 'RS256' | 'ES256',
  kid: string,
  sids: string[],
  over: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  nowSec = 1_800_000_000,
) {
  const hashes = sids.map(hashOf).sort(Buffer.compare);
  const claims = {
    iss: 'https://atlas.test',
    sub: 'session-status-list',
    aud: 'atlas:session-status-list',
    token_use: 'session_status_list',
    iat: nowSec,
    nbf: nowSec - 5,
    exp: nowSec + 120,
    since: (nowSec - 3600) * 1000,
    window_seconds: 3600,
    hash_bytes: 8,
    count: hashes.length,
    truncated: false,
    h: b64(Buffer.concat(hashes)),
    ...over,
  };
  const head = b64(JSON.stringify({ alg, kid, typ: 'statuslist+jwt', ...header }));
  const body = b64(JSON.stringify(claims));
  const data = new TextEncoder().encode(`${head}.${body}`);
  const sig = new Uint8Array(await crypto.subtle.sign(alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data));
  return `${head}.${body}.${b64(sig)}`;
}

const NOW = 1_800_000_010_000;

describe('verifyStatusListToken', () => {
  it('verifies an RS256 list and finds exactly the listed sessions', async () => {
    const { pair, jwk } = await rsaKey();
    const token = await sign(pair, 'RS256', 'k1', ['sess_a', 'sess_b', 'sess_c']);
    const list = await verifyStatusListToken(token, { jwks: { keys: [jwk] }, issuer: 'https://atlas.test', now: () => NOW });
    expect(list.count).toBe(3);
    expect(list.truncated).toBe(false);
    for (const sid of ['sess_a', 'sess_b', 'sess_c']) expect(list.has(sid)).toBe(true);
    expect(list.has('sess_d')).toBe(false);
    expect(list.expiresAt).toBe((1_800_000_000 + 120) * 1000);
  });

  it('verifies an ES256 list and an empty one', async () => {
    const { pair, jwk } = await ecKey();
    const list = await verifyStatusListToken(await sign(pair, 'ES256', 'k2', []), { jwks: { keys: [jwk] }, now: () => NOW });
    expect(list.count).toBe(0);
    expect(list.has('anything')).toBe(false);
  });

  it('refuses a bad signature, a tampered payload, a wrong issuer, an expired list and the wrong kind of token', async () => {
    const { pair, jwk } = await rsaKey();
    const other = await rsaKey();
    const opts = { jwks: { keys: [jwk] }, issuer: 'https://atlas.test', now: () => NOW };
    const good = await sign(pair, 'RS256', 'k1', ['sess_a']);
    await expect(verifyStatusListToken(await sign(other.pair, 'RS256', 'k1', ['sess_a']), opts)).rejects.toMatchObject({ reason: 'bad_signature' });
    const [h, , s] = good.split('.');
    const forged = b64(JSON.stringify({ ...JSON.parse(Buffer.from(good.split('.')[1]!, 'base64url').toString()), count: 0, h: '' }));
    await expect(verifyStatusListToken(`${h}.${forged}.${s}`, opts)).rejects.toMatchObject({ reason: 'bad_signature' });
    await expect(verifyStatusListToken(good, { ...opts, issuer: 'https://evil.test' })).rejects.toMatchObject({ reason: 'bad_claims' });
    await expect(verifyStatusListToken(good, { ...opts, now: () => NOW + 3_600_000 })).rejects.toMatchObject({ reason: 'expired' });
    await expect(verifyStatusListToken(await sign(pair, 'RS256', 'k1', [], {}, { typ: 'JWT' }), opts)).rejects.toMatchObject({ reason: 'unsupported' });
    await expect(verifyStatusListToken(await sign(pair, 'RS256', 'k1', [], { aud: 'someone' }), opts)).rejects.toMatchObject({ reason: 'bad_claims' });
    await expect(verifyStatusListToken(await sign(pair, 'RS256', 'k1', ['sess_a'], { count: 5 }), opts)).rejects.toMatchObject({ reason: 'bad_claims' });
    await expect(verifyStatusListToken('a.b', opts)).rejects.toBeInstanceOf(StatusListError);
    await expect(verifyStatusListToken(good, { jwks: { keys: [] }, now: () => NOW })).rejects.toMatchObject({ reason: 'no_key' });
  });

  it('flags a truncated list', async () => {
    const { pair, jwk } = await rsaKey();
    const list = await verifyStatusListToken(await sign(pair, 'RS256', 'k1', ['sess_a'], { truncated: true }), { jwks: { keys: [jwk] }, now: () => NOW });
    expect(list.truncated).toBe(true);
  });
});

describe('createEdgeRevocationChecker', () => {
  async function setup(opts: Record<string, unknown> = {}) {
    const { pair, jwk } = await rsaKey();
    let t = NOW;
    let revoked = ['sess_gone'];
    let healthy = true;
    let truncated = false;
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.endsWith('jwks.json')) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      if (!healthy) return new Response('nope', { status: 500 });
      const token = await sign(pair, 'RS256', 'k1', revoked, { truncated }, {}, Math.floor(t / 1000));
      return new Response(JSON.stringify({ token }), { status: 200 });
    }) as unknown as typeof fetch;
    const checker = createEdgeRevocationChecker({ secretKey: 'sk_x', baseUrl: 'https://api.test', jwksUrl: 'https://atlas.test/jwks.json', issuer: 'https://atlas.test', fetchImpl, now: () => t, refreshMs: 30_000, staleAfterMs: 60_000, ...opts });
    return { checker, calls, advance: (ms: number) => (t += ms), down: () => (healthy = false), setTruncated: () => (truncated = true), revoke: (sid: string) => revoked.push(sid) };
  }

  it('answers ok and revoked, refreshes after refreshMs, and shares one fetch between concurrent calls', async () => {
    const s = await setup();
    const [a, b] = await Promise.all([s.checker.check('sess_gone'), s.checker.check('sess_live')]);
    expect(a).toBe('revoked');
    expect(b).toBe('ok');
    expect(s.calls.filter((c) => c.includes('status-list')).length).toBe(1);
    s.revoke('sess_live');
    expect(await s.checker.check('sess_live')).toBe('ok'); // still the cached list
    s.advance(31_000);
    expect(await s.checker.check('sess_live')).toBe('revoked');
  });

  it('fails closed when the list cannot be fetched or has gone stale, unless told otherwise', async () => {
    const s = await setup();
    s.down();
    expect(await s.checker.check('sess_live')).toBe('unavailable'); // never fetched

    const t = await setup();
    expect(await t.checker.check('sess_live')).toBe('ok');
    t.down();
    t.advance(120_000);
    expect(await t.checker.check('sess_live')).toBe('unavailable');
    expect(await t.checker.check('sess_gone')).toBe('revoked'); // a listed session is still refused

    const u = await setup({ onStale: 'allow' });
    expect(await u.checker.check('sess_live')).toBe('ok');
    u.down();
    u.advance(120_000);
    expect(await u.checker.check('sess_live')).toBe('ok');
  });

  it('serves the last list for the grace after it goes stale', async () => {
    const seen: number[] = [];
    const s = await setup({ serveStaleForMs: 20_000, onServeStale: (i: { staleForMs: number }) => seen.push(i.staleForMs) });
    await s.checker.check('sess_live');
    s.down();
    s.advance(70_000);
    expect(await s.checker.check('sess_live')).toBe('ok');
    expect(seen.length).toBe(1);
    s.advance(20_000);
    expect(await s.checker.check('sess_live')).toBe('unavailable');
  });

  it('will not clear a session from a truncated list', async () => {
    const s = await setup();
    s.setTruncated();
    expect(await s.checker.check('sess_live')).toBe('unavailable');
    expect(await s.checker.check('sess_gone')).toBe('revoked');
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose';
import {
  BACKCHANNEL_LOGOUT_EVENT,
  LogoutTokenVerifier,
  memoryLogoutReplayStore,
  verifyLogoutToken,
} from './logout-token';
import { AtlasBackend } from './verify';
import type { Jwks } from './jwks-cache';

const ISSUER = 'https://clerk.example.test';
const CLIENT_ID = 'app_client_123';
const KID = 'kid_logout_test';
const NOW_MS = 1_800_000_000_000;
const now = () => NOW_MS;
const nowSec = Math.floor(NOW_MS / 1000);

async function keypair(): Promise<{ privateKey: KeyLike; jwks: Jwks }> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwks: { keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] } };
}

let good: { privateKey: KeyLike; jwks: Jwks };
let other: { privateKey: KeyLike; jwks: Jwks };
beforeAll(async () => {
  good = await keypair();
  other = await keypair();
});

interface MintOptions {
  claims?: Record<string, unknown>;
  omit?: string[];
  typ?: string | null;
  key?: KeyLike;
}

async function mint(opts: MintOptions = {}): Promise<string> {
  const base: Record<string, unknown> = {
    iss: ISSUER,
    aud: CLIENT_ID,
    iat: nowSec,
    exp: nowSec + 120,
    jti: 'jti_1',
    sub: 'user_1',
    sid: 'sess_1',
    events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
    ...opts.claims,
  };
  for (const k of opts.omit ?? []) delete base[k];
  const header: { alg: string; kid: string; typ?: string } = { alg: 'RS256', kid: KID };
  if (opts.typ !== null) header.typ = opts.typ ?? 'logout+jwt';
  return new SignJWT(base).setProtectedHeader(header).sign(opts.key ?? good.privateKey);
}

function verifier(extra: Partial<ConstructorParameters<typeof LogoutTokenVerifier>[0]> = {}) {
  return new LogoutTokenVerifier({ issuer: ISSUER, clientId: CLIENT_ID, jwks: good.jwks, now, ...extra });
}

describe('logout_token verification', () => {
  it('accepts a valid token and returns sub, sid, jti, iat', async () => {
    const result = await verifier().verify(await mint());
    expect(result).toEqual({
      ok: true,
      claims: { sub: 'user_1', sid: 'sess_1', jti: 'jti_1', iat: nowSec },
    });
  });

  it('accepts a token without a typ header, and with only sid', async () => {
    const result = await verifier().verify(await mint({ typ: null, omit: ['sub'] }));
    expect(result).toEqual({ ok: true, claims: { sid: 'sess_1', jti: 'jti_1', iat: nowSec } });
  });

  it('rejects the wrong typ', async () => {
    const result = await verifier().verify(await mint({ typ: 'JWT' }));
    expect(result).toMatchObject({ ok: false, reason: 'invalid', detail: 'typ is not logout+jwt' });
  });

  it('rejects a token carrying a nonce', async () => {
    const result = await verifier().verify(await mint({ claims: { nonce: 'n' } }));
    expect(result).toMatchObject({ ok: false, reason: 'invalid', detail: 'nonce must not be present' });
  });

  it('rejects a token without the back-channel logout event', async () => {
    expect(await verifier().verify(await mint({ omit: ['events'] }))).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    // The event value must be an object.
    expect(
      await verifier().verify(await mint({ claims: { events: { [BACKCHANNEL_LOGOUT_EVENT]: 'x' } } })),
    ).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('rejects the wrong audience', async () => {
    const result = await verifier().verify(await mint({ claims: { aud: 'someone_else' } }));
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('rejects the wrong issuer', async () => {
    const result = await verifier().verify(await mint({ claims: { iss: 'https://evil.test' } }));
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('rejects an expired token', async () => {
    const result = await verifier().verify(
      await mint({ claims: { iat: nowSec - 200, exp: nowSec - 60 } }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'invalid', detail: 'expired' });
  });

  it('rejects an iat in the future and a too-old iat', async () => {
    expect(
      await verifier().verify(await mint({ claims: { iat: nowSec + 600, exp: nowSec + 700 } })),
    ).toMatchObject({ ok: false, reason: 'invalid' });
    expect(
      await verifier().verify(await mint({ claims: { iat: nowSec - 3600 }, omit: ['exp'] })),
    ).toMatchObject({ ok: false, reason: 'invalid', detail: 'iat is too old' });
  });

  it('rejects missing iat, jti, or both sub and sid', async () => {
    for (const omit of [['iat'], ['jti'], ['sub', 'sid']]) {
      expect(await verifier().verify(await mint({ omit }))).toMatchObject({ ok: false, reason: 'invalid' });
    }
  });

  it('rejects a bad signature', async () => {
    const result = await verifier().verify(await mint({ key: other.privateKey }));
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('rejects a non-RS256 algorithm', async () => {
    const token = await new SignJWT({
      iss: ISSUER,
      aud: CLIENT_ID,
      iat: nowSec,
      jti: 'j',
      sub: 'u',
      events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
    })
      .setProtectedHeader({ alg: 'HS256', kid: KID, typ: 'logout+jwt' })
      .sign(new TextEncoder().encode('a-shared-secret-of-sufficient-length!!'));
    expect(await verifier().verify(token)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('rejects malformed input', async () => {
    expect(await verifier().verify('not-a-jwt')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a replayed jti with a replay store', async () => {
    const v = verifier({ replayStore: memoryLogoutReplayStore(now) });
    const token = await mint();
    expect((await v.verify(token)).ok).toBe(true);
    expect(await v.verify(token)).toEqual({ ok: false, reason: 'replayed' });
  });

  it('accepts any of several client ids, via the one-off helper', async () => {
    const result = await verifyLogoutToken(await mint(), {
      issuer: ISSUER,
      clientId: ['other', CLIENT_ID],
      jwks: good.jwks,
      now,
    });
    expect(result.ok).toBe(true);
  });

  it('AtlasBackend.verifyLogoutToken reuses the instance issuer and keys', async () => {
    const backend = new AtlasBackend({ issuer: ISSUER, jwks: good.jwks, now });
    expect((await backend.verifyLogoutToken(await mint(), { clientId: CLIENT_ID })).ok).toBe(true);
    expect(
      await backend.verifyLogoutToken(await mint(), { clientId: 'nope' }),
    ).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('requires issuer and clientId', () => {
    expect(() => new LogoutTokenVerifier({ issuer: '', clientId: CLIENT_ID, jwks: good.jwks })).toThrow();
    expect(() => new LogoutTokenVerifier({ issuer: ISSUER, clientId: '', jwks: good.jwks })).toThrow();
  });
});

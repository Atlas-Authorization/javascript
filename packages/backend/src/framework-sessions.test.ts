import { createCipheriv, createHmac, hkdfSync, pbkdf2Sync, randomBytes } from 'node:crypto';
import { EncryptJWT, base64url, calculateJwkThumbprint } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  authJsSessionTokenKind,
  decodeAuthJsSessionToken,
  decodeDjangoPayload,
  decodeDjangoSignedCookie,
  decryptRailsCookie,
  deviseSaltMatches,
  deviseSessionUser,
  djangoSessionAuthHash,
  djangoSessionUser,
  luciaSessionId,
  readAuthJsSessionCookie,
  sessionValueAt,
  unsealIronSession,
  unsignExpressSessionCookie,
} from './framework-sessions';

/**
 * Each framework's session is produced here the way the framework itself
 * produces it — Auth.js through jose with Auth.js's own key derivation, iron
 * and Rails with node:crypto following their source, Django from vectors made
 * by a Python port of `django.core.signing` — and read back by the codec.
 */

const NOW = new Date('2026-10-25T12:00:00Z');
const nowSec = Math.floor(NOW.getTime() / 1000);

describe('Auth.js session cookies', () => {
  const secret = 'auth-secret-0123456789abcdef0123456789';

  // @auth/core's `encode`: HKDF(secret, salt=cookie name), A256CBC-HS512, kid = JWK thumbprint.
  async function encodeV5(claims: Record<string, unknown>, salt: string, s = secret) {
    const key = new Uint8Array(hkdfSync('sha256', s, salt, `Auth.js Generated Encryption Key (${salt})`, 64));
    const kid = await calculateJwkThumbprint({ kty: 'oct', k: base64url.encode(key) }, 'sha512');
    return new EncryptJWT(claims)
      .setProtectedHeader({ alg: 'dir', enc: 'A256CBC-HS512', kid })
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 3600)
      .setJti('jti-1')
      .encrypt(key);
  }
  // next-auth v4's `encode`: HKDF(secret, salt=""), A256GCM, no kid.
  async function encodeV4(claims: Record<string, unknown>) {
    const key = new Uint8Array(hkdfSync('sha256', secret, '', 'NextAuth.js Generated Encryption Key', 32));
    return new EncryptJWT(claims)
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 3600)
      .encrypt(key);
  }

  it('decrypts a v5 token under the cookie name it was issued for', async () => {
    const salt = '__Secure-authjs.session-token';
    const token = await encodeV5({ sub: 'user_1', email: 'ada@example.com', name: 'Ada' }, salt);
    expect(authJsSessionTokenKind(token)).toBe('jwt');
    const claims = await decodeAuthJsSessionToken(token, { secret, salt, now: NOW });
    expect(claims).toMatchObject({ sub: 'user_1', email: 'ada@example.com', name: 'Ada' });
    // The cookie name is the HKDF salt: the same token under another name never opens.
    expect(await decodeAuthJsSessionToken(token, { secret, salt: 'authjs.session-token', now: NOW })).toBeNull();
  });

  it('decrypts a v4 token, and tries every rotated secret', async () => {
    const token = await encodeV4({ sub: 'user_2', email: 'grace@example.com' });
    const claims = await decodeAuthJsSessionToken(token, {
      secret: ['new-secret-not-yet-used-for-this-cookie', secret],
      salt: 'next-auth.session-token',
      now: NOW,
    });
    expect(claims?.sub).toBe('user_2');
  });

  it('refuses a wrong secret, an expired token and a tampered one', async () => {
    const salt = 'authjs.session-token';
    const token = await encodeV5({ sub: 'user_1' }, salt);
    expect(await decodeAuthJsSessionToken(token, { secret: 'another-secret-entirely-xxxxxxxxxx', salt, now: NOW })).toBeNull();
    expect(
      await decodeAuthJsSessionToken(token, { secret, salt, now: new Date(NOW.getTime() + 2 * 3600 * 1000) }),
    ).toBeNull();
    const parts = token.split('.');
    parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.endsWith('AA') ? 'BB' : 'AA');
    expect(await decodeAuthJsSessionToken(parts.join('.'), { secret, salt, now: NOW })).toBeNull();
    expect(await decodeAuthJsSessionToken('not-a-jwe', { secret, salt, now: NOW })).toBeNull();
  });

  it('reads the cookie by its default names and reassembles chunks', async () => {
    expect(readAuthJsSessionCookie('a=1; authjs.session-token=abc')).toEqual({ name: 'authjs.session-token', value: 'abc' });
    expect(readAuthJsSessionCookie('__Secure-next-auth.session-token=v4; authjs.session-token=v5')).toEqual({
      name: 'authjs.session-token',
      value: 'v5',
    });
    expect(
      readAuthJsSessionCookie('__Secure-authjs.session-token.1=def; __Secure-authjs.session-token.0=abc'),
    ).toEqual({ name: '__Secure-authjs.session-token', value: 'abcdef' });
    expect(readAuthJsSessionCookie('my-session=x', { cookieName: 'my-session' })?.value).toBe('x');
    expect(readAuthJsSessionCookie('other=1')).toBeUndefined();
  });

  it('tells a database session token from a JWT', () => {
    expect(authJsSessionTokenKind('5c1d3a1e-8f6b-4e8e-9d7c-2b1f4a0e9c33')).toBe('database');
    expect(authJsSessionTokenKind('has spaces')).toBeNull();
  });
});

describe('express-session cookies', () => {
  it('verifies the cookie-signature reference vector', async () => {
    // cookie-signature's own test: sign('hello', 'tobiiscool').
    const cookie = 's:hello.DGDUkGlIkCzPz+C0B064FNgHdEjox7ch8tOBGslZ5QI';
    expect(await unsignExpressSessionCookie(cookie, 'tobiiscool')).toBe('hello');
    expect(await unsignExpressSessionCookie(encodeURIComponent(cookie), ['rotated', 'tobiiscool'])).toBe('hello');
    expect(await unsignExpressSessionCookie(cookie, 'luna')).toBeNull();
  });

  it('parses the id without a secret, and refuses unsigned values', async () => {
    expect(await unsignExpressSessionCookie('s%3AQ8m2v9xw.sig')).toBe('Q8m2v9xw');
    expect(await unsignExpressSessionCookie('Q8m2v9xw')).toBeNull();
    expect(await unsignExpressSessionCookie('s:nodot')).toBeNull();
  });
});

describe('Lucia session ids', () => {
  it('stores v2/v3 tokens as-is and guide-style tokens as sha256 hex', async () => {
    expect(await luciaSessionId('k3v9qz0w1m2n4b7xk3v9qz0w1m2n4b7x')).toBe('k3v9qz0w1m2n4b7xk3v9qz0w1m2n4b7x');
    expect(await luciaSessionId('abcdefgh', 'sha256-hex')).toBe(
      '9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab',
    );
    expect(await luciaSessionId('bad token')).toBeNull();
  });
});

describe('iron-session seals', () => {
  const password = 'complex_password_at_least_32_characters_long';

  // @hapi/iron's seal (aes-256-cbc + sha256 HMAC, PBKDF2-SHA1 1 iteration keys).
  function seal(data: unknown, pw: string, passwordId: string, expiration: number | '', suffix = '~2') {
    const encSalt = randomBytes(32).toString('hex');
    const iv = randomBytes(16);
    const key = pbkdf2Sync(pw, encSalt, 1, 32, 'sha1');
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    const base = ['Fe26.2', passwordId, encSalt, iv.toString('base64url'), encrypted.toString('base64url'), String(expiration)].join('*');
    const hmacSalt = randomBytes(32).toString('hex');
    const mac = createHmac('sha256', pbkdf2Sync(pw, hmacSalt, 1, 32, 'sha1')).update(base).digest('base64url');
    return `${base}*${hmacSalt}*${mac}${suffix}`;
  }

  it('opens an iron-session v8 cookie and reads the user id', async () => {
    const cookie = seal({ user: { id: 'u_42', admin: false } }, password, '1', NOW.getTime() + 3600_000);
    const data = await unsealIronSession(cookie, password, { now: NOW });
    expect(data).toEqual({ user: { id: 'u_42', admin: false } });
    expect(sessionValueAt(data, 'user.id')).toBe('u_42');
    expect(sessionValueAt(data, 'user.missing')).toBeNull();
  });

  it('supports the rotation map and the older persistent envelope', async () => {
    const cookie = seal({ persistent: { userId: 9 } }, password, '2', '', '');
    const data = await unsealIronSession(cookie, { 1: 'old_password_old_password_old_password', 2: password }, { now: NOW });
    expect(sessionValueAt(data, 'userId')).toBe('9');
  });

  it('refuses a wrong password, a tampered seal and an expired one', async () => {
    const cookie = seal({ userId: 'u' }, password, '1', NOW.getTime() + 3600_000);
    expect(await unsealIronSession(cookie, 'x'.repeat(40), { now: NOW })).toBeNull();
    expect(await unsealIronSession(cookie.replace('Fe26.2*1*', 'Fe26.2*1*0'), password, { now: NOW })).toBeNull();
    const expired = seal({ userId: 'u' }, password, '1', NOW.getTime() - 120_000);
    expect(await unsealIronSession(expired, password, { now: NOW })).toBeNull();
    expect(await unsealIronSession('Fe26.1*bad', password, { now: NOW })).toBeNull();
  });
});

describe('Rails encrypted session cookie (Devise)', () => {
  const secretKeyBase = 'a'.repeat(64) + 'b'.repeat(64);
  const encryptedPassword = '$2a$12$K5tRZ1o6aF1k3Q1vXk0cJ.3m0uV7m6c9nJ8Wq3zE5j1oX7yYb2Z9e';

  // ActiveSupport::MessageEncryptor aes-256-gcm with the Rails 5.2–7.0 `_rails` envelope.
  function railsCookie(session: unknown, opts: { digest?: 'sha256' | 'sha1'; exp?: string | null; pur?: string; v71?: boolean } = {}) {
    const key = pbkdf2Sync(secretKeyBase, 'authenticated encrypted cookie', 1000, 32, opts.digest ?? 'sha256');
    const envelope = opts.v71
      ? { _rails: { data: session, exp: opts.exp ?? null, pur: opts.pur ?? 'cookie._shop_session' } }
      : {
          _rails: {
            message: Buffer.from(JSON.stringify(session)).toString('base64'),
            exp: opts.exp ?? null,
            pur: opts.pur ?? 'cookie._shop_session',
          },
        };
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.alloc(0));
    const ct = Buffer.concat([cipher.update(JSON.stringify(envelope), 'utf8'), cipher.final()]);
    return encodeURIComponent(`${ct.toString('base64')}--${iv.toString('base64')}--${cipher.getAuthTag().toString('base64')}`);
  }

  const session = {
    session_id: 'f1e2d3',
    'warden.user.user.key': [[17], encryptedPassword.slice(0, 29)],
    _csrf_token: 'x',
  };

  it('decrypts with the SHA-256 key generator and finds the Devise user', async () => {
    const data = await decryptRailsCookie(railsCookie(session), { secretKeyBase, cookieName: '_shop_session', now: NOW });
    expect(data).toEqual(session);
    const user = deviseSessionUser(data!);
    expect(user).toEqual({ id: '17', salt: encryptedPassword.slice(0, 29) });
    expect(deviseSaltMatches(user!.salt, encryptedPassword)).toBe(true);
    expect(deviseSaltMatches(user!.salt, '$2a$12$changedchangedchangedchanged.xxxxxxxxxxxxxxxxxxxxxx')).toBe(false);
  });

  it('accepts the SHA-1 key generator and the Rails 7.1 envelope', async () => {
    expect(await decryptRailsCookie(railsCookie(session, { digest: 'sha1' }), { secretKeyBase, now: NOW })).toEqual(session);
    expect(await decryptRailsCookie(railsCookie(session, { v71: true }), { secretKeyBase, now: NOW })).toEqual(session);
  });

  it('refuses another cookie purpose, an expired envelope and a wrong secret', async () => {
    expect(
      await decryptRailsCookie(railsCookie(session, { pur: 'cookie.remember_user_token' }), {
        secretKeyBase,
        cookieName: '_shop_session',
        now: NOW,
      }),
    ).toBeNull();
    expect(
      await decryptRailsCookie(railsCookie(session, { exp: '2026-10-25T11:00:00.000Z' }), { secretKeyBase, now: NOW }),
    ).toBeNull();
    expect(await decryptRailsCookie(railsCookie(session), { secretKeyBase: 'c'.repeat(128), now: NOW })).toBeNull();
    expect(deviseSessionUser({ other: 1 })).toBeNull();
  });
});

describe('Django sessions', () => {
  // Made by a Python port of django.core.signing.dumps(…, compress=True) at
  // timestamp 1793000000 with SECRET_KEY "django-insecure-test-key".
  const signed =
    '.eJyrVopPLC3JiC8tTi2Kz0xRslIyMVLSQRZMSkzOTs0DyaRkJeal5-sl5-eVFGUm6YGU6EFli_V881NSc5ygalEMyEgszgDqtkwySTZMM0gkl1aqBQAyXTlS' +
    ':1xLFCq:q2rEXiQ901w0AhZJ9QUg6JdE_MiwH7B_TaFySrHoTVI';
  // Uncompressed, SHA-1 (Django < 3.1), SECRET_KEY "old-key".
  const legacy = 'eyJfYXV0aF91c2VyX2lkIjo3fQ:1xLFCq:5-7fXjnvolIqcQqzyGn3DN_7rMw';
  const issuedAt = new Date(1793000000 * 1000);

  it('verifies and inflates a signed-cookie session', async () => {
    const data = await decodeDjangoSignedCookie(signed, {
      secretKey: 'django-insecure-test-key',
      maxAgeSeconds: 1209600,
      now: new Date(issuedAt.getTime() + 60_000),
    });
    expect(djangoSessionUser(data!)).toEqual({ id: '42', hash: '9b4c1f0a'.repeat(8) });
  });

  it('accepts SECRET_KEY_FALLBACKS and the SHA-1 signer', async () => {
    const data = await decodeDjangoSignedCookie(legacy, { secretKey: ['current-key', 'old-key'] });
    expect(djangoSessionUser(data!)).toEqual({ id: '7', hash: null });
  });

  it('refuses a wrong key, an expired cookie and a tampered payload', async () => {
    expect(await decodeDjangoSignedCookie(signed, { secretKey: 'nope' })).toBeNull();
    expect(
      await decodeDjangoSignedCookie(signed, {
        secretKey: 'django-insecure-test-key',
        maxAgeSeconds: 60,
        now: new Date(issuedAt.getTime() + 3600_000),
      }),
    ).toBeNull();
    expect(await decodeDjangoSignedCookie(`x${legacy}`, { secretKey: 'old-key' })).toBeNull();
  });

  it('decodes a database row payload without a key', async () => {
    expect(await decodeDjangoPayload('eyJfYXV0aF91c2VyX2lkIjo3fQ')).toEqual({ _auth_user_id: 7 });
    expect(await decodeDjangoPayload('!!')).toBeNull();
  });

  it('computes the session auth hash Django binds to the password', async () => {
    expect(
      await djangoSessionAuthHash(
        'pbkdf2_sha256$1800000$seasalt$sXv9FzN4gEo6/P8G5H1jvir9BIb5e5EkXoVGyjOniNE=',
        'django-insecure-test-key',
      ),
    ).toBe('d5f822b84588768fae17947f5ad37a8a8d8bf3cf4a82f16143cbb6ea6848bbe1');
  });
});

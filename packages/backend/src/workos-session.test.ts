import { createCipheriv, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveMigrationBridgePreset } from './migration-presets';
import { ironUnseal, workosSessionTokenExtractor } from './workos-session';

/**
 * Seals made with Node's own crypto following the iron format (Fe26.2, PBKDF2-SHA1
 * one iteration over the salt string, AES-256-CBC, HMAC-SHA256 over the first six
 * parts), so the code under test is checked against an independent implementation.
 */
const PASSWORD = 'a-long-random-workos-cookie-password-0123456789';
const ACCESS = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzAxIn0.c2ln';
const b64u = (b: Buffer) => b.toString('base64url');

function seal(obj: unknown, password = PASSWORD, expiresAt?: number, suffix = '~2'): string {
  const encSalt = randomBytes(32).toString('hex');
  const hmacSalt = randomBytes(32).toString('hex');
  const iv = randomBytes(16);
  const key = pbkdf2Sync(password, encSalt, 1, 32, 'sha1');
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const base = ['Fe26.2', '1', encSalt, b64u(iv), b64u(encrypted), expiresAt === undefined ? '' : String(expiresAt)].join('*');
  const mac = createHmac('sha256', pbkdf2Sync(password, hmacSalt, 1, 32, 'sha1')).update(base).digest();
  return `${base}*${hmacSalt}*${b64u(mac)}${suffix}`;
}

const session = { accessToken: ACCESS, refreshToken: 'rt', user: { id: 'user_01' }, impersonator: undefined, authenticationMethod: 'Password' };
const run = (cookies: Record<string, string>, password: string | string[] = PASSWORD) => workosSessionTokenExtractor({ password })({ cookies, headers: {} });

describe('workosSessionTokenExtractor', () => {
  it('opens an authkit-nextjs wos-session seal (iron-session ~2, no expiry)', async () => {
    expect(await run({ 'wos-session': seal(session) })).toBe(ACCESS);
  });

  it('opens a bare iron seal without the version suffix and an unexpired timestamp', async () => {
    expect(await run({ 'wos-session': seal(session, PASSWORD, Date.now() + 3_600_000, '') })).toBe(ACCESS);
  });

  it('opens the Remix / React Router signed cookie wrapper', async () => {
    const wrapped = `${Buffer.from(JSON.stringify({ jwt: seal(session) })).toString('base64')}.c2lnbmF0dXJl`;
    expect(await run({ 'wos-session': wrapped })).toBe(ACCESS);
  });

  it('honours a custom cookie name and a rotated-out password', async () => {
    const old = seal(session, 'previous-password-previous-password-12345');
    expect(await workosSessionTokenExtractor({ password: [PASSWORD, 'previous-password-previous-password-12345'], cookieName: 'my-session' })({ cookies: { 'my-session': old }, headers: {} })).toBe(ACCESS);
  });

  it('refuses a wrong password, a tampered seal, an expired seal, a session without a JWT and an Atlas JWT', async () => {
    const good = seal(session);
    expect(await run({ 'wos-session': good }, 'some-other-password-some-other-password-1')).toBeUndefined();
    const parts = good.split('*');
    parts[4] = parts[4]!.slice(0, -2) + (parts[4]!.endsWith('AA') ? 'BB' : 'AA');
    expect(await run({ 'wos-session': parts.join('*') })).toBeUndefined();
    expect(await run({ 'wos-session': seal(session, PASSWORD, Date.now() - 5 * 60_000) })).toBeUndefined();
    expect(await run({ 'wos-session': seal({ accessToken: 'not-a-jwt' }) })).toBeUndefined();
    expect(await run({ 'wos-session': ACCESS })).toBeUndefined();
    expect(await run({})).toBeUndefined();
    expect(() => workosSessionTokenExtractor({ password: '' })).toThrow(/WORKOS_COOKIE_PASSWORD/);
  });

  it('ironUnseal returns the sealed object', () => {
    expect(ironUnseal(seal({ a: 1, b: 2, c: [3, 4, 5], d: { e: 'f' } }), PASSWORD)).toEqual({ a: 1, b: 2, c: [3, 4, 5], d: { e: 'f' } });
  });
});

describe('workos bridge preset', () => {
  it('resolves the AuthKit issuer and JWKS for a client id', () => {
    expect(resolveMigrationBridgePreset('workos', { client_id: 'client_01ABC' })).toMatchObject({
      issuer: 'https://api.workos.com/user_management/client_01ABC',
      keysUrl: 'https://api.workos.com/sso/jwks/client_01ABC',
      claims: { subject: 'sub', sessionKey: 'sid' },
    });
  });
});

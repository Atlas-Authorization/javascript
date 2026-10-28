import { describe, expect, it } from 'vitest';
import {
  CANONICAL_MODEL_ORDER,
  MIGRATION_SOURCES,
  PASSWORD_HASH_ALGORITHMS,
  isCanonicalModel,
  isMigrationSource,
  sourceFromVendor,
  validatePasswordHash,
  validateRecord,
  vendorOfSource,
} from './schema';
import { SOURCE_PROFILES } from './sources';

const HASH = 'a'.repeat(64);

describe('sources', () => {
  it('every source round-trips through its CLI spelling', () => {
    for (const s of MIGRATION_SOURCES) {
      expect(isMigrationSource(s)).toBe(true);
      expect(sourceFromVendor(vendorOfSource(s))).toBe(s);
    }
    expect(vendorOfSource('better_auth')).toBe('better-auth');
  });

  it('reads vendor names loosely and knows the common aliases', () => {
    expect(sourceFromVendor('Better-Auth')).toBe('better_auth');
    expect(sourceFromVendor('betterauth')).toBe('better_auth');
    expect(sourceFromVendor('NextAuth')).toBe('authjs');
    expect(sourceFromVendor('next-auth')).toBe('authjs');
    expect(sourceFromVendor('auth.js')).toBe('authjs');
    expect(sourceFromVendor('AWS Cognito')).toBe('cognito');
    expect(sourceFromVendor('gotrue')).toBe('supabase');
    expect(sourceFromVendor('ory-kratos')).toBe('ory');
    expect(sourceFromVendor('authkit')).toBe('workos');
    expect(sourceFromVendor(' auth0 ')).toBe('auth0');
    expect(sourceFromVendor('Passport.js')).toBe('passport');
    expect(sourceFromVendor('express-session')).toBe('passport');
    expect(sourceFromVendor('homegrown-auth')).toBeNull();
    expect(isMigrationSource('homegrown_auth')).toBe(false);
    expect(isMigrationSource(undefined)).toBe(false);
  });

  it('every source has a consistent profile', () => {
    expect(Object.keys(SOURCE_PROFILES).sort()).toEqual([...MIGRATION_SOURCES].sort());
    for (const s of MIGRATION_SOURCES) {
      const p = SOURCE_PROFILES[s];
      expect(p.source).toBe(s);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.models.length).toBeGreaterThan(0);
      for (const m of p.models) expect(isCanonicalModel(m), `${s}: ${m}`).toBe(true);
      expect(p.exportVia.length).toBeGreaterThan(0);
      // Hashes that never leave the vendor need the lazy-migration preset.
      if (p.passwords === 'lazy') expect(p.lazyPreset, s).toBeTruthy();
      // A bridge needs a preset the middleware can resolve.
      if (p.bridge !== 'none') expect(p.bridgePreset, s).toBeTruthy();
    }
  });
});

describe('canonical models', () => {
  it('orders every model after the ones it references', () => {
    const at = (m: string) => (CANONICAL_MODEL_ORDER as readonly string[]).indexOf(m);
    expect(at('organization')).toBeLessThan(at('membership'));
    expect(at('user')).toBeLessThan(at('identity'));
    expect(at('user')).toBeLessThan(at('mfa_factor'));
    expect(at('user')).toBeLessThan(at('passkey'));
    expect(at('role')).toBeLessThan(at('membership'));
    expect(at('organization')).toBeLessThan(at('invitation'));
    expect(at('sso_connection')).toBeGreaterThan(at('organization'));
    expect(at('sso_connection')).toBeLessThan(at('identity'));
    expect(at('user')).toBeLessThan(at('session'));
    expect(new Set(CANONICAL_MODEL_ORDER).size).toBe(CANONICAL_MODEL_ORDER.length);
  });

  it('accepts a minimal well-formed record of every model', () => {
    const ok: Record<string, unknown> = {
      organization: { id: 'org_1', name: 'Acme' },
      role: { key: 'admin', scope: 'organization' },
      user: { id: 'u1', emails: [{ email: 'a@example.com', verified: true }] },
      identity: { user_id: 'u1', provider: 'google-oauth2', provider_user_id: '123' },
      mfa_factor: { user_id: 'u1', type: 'totp', secret_base32: 'JBSWY3DPEHPK3PXP' },
      passkey: { user_id: 'u1', credential_id: 'Y3JlZA', public_key: 'cGs', rp_id: 'example.com' },
      membership: { organization_id: 'org_1', user_id: 'u1', role: 'admin' },
      invitation: { id: 'inv_1', email: 'b@example.com' },
      api_key: { id: 'k1', hash: HASH, hash_algorithm: 'sha256' },
      sso_connection: { id: 'sso_1', protocol: 'saml' },
      jwks: { kid: 'k1', jwk: { kty: 'RSA' } },
      session: { id: 's1', user_id: 'u1', token_hash: HASH, expires_at: 1_900_000_000_000 },
    };
    expect(Object.keys(ok).sort()).toEqual([...CANONICAL_MODEL_ORDER].sort());
    for (const [model, data] of Object.entries(ok)) expect(validateRecord(model, data), model).toEqual([]);
  });

  it('allows unknown extra fields (forward compatible)', () => {
    expect(validateRecord('organization', { id: 'o', name: 'n', future_field: 1 })).toEqual([]);
  });

  it('refuses an unknown model and a non-object', () => {
    expect(validateRecord('widget', {})).toEqual([{ field: 'model', message: 'Unknown model "widget".' }]);
    expect(validateRecord('user', null)[0]?.field).toBe('data');
    expect(validateRecord('user', [])[0]?.field).toBe('data');
  });

  const fields = (model: string, data: unknown) => validateRecord(model, data).map((i) => i.field);

  it('names each missing or malformed field', () => {
    expect(fields('organization', { id: ' ' })).toEqual(['id', 'name']);
    expect(fields('role', { key: 'admin', scope: 'global' })).toEqual(['scope']);
    expect(fields('identity', { user_id: 'u1' })).toEqual(['provider', 'provider_user_id']);
    expect(fields('mfa_factor', { user_id: 'u1', type: 'sms' })).toEqual(['type']);
    expect(fields('mfa_factor', { user_id: 'u1', type: 'totp' })).toEqual(['secret_base32']);
    expect(fields('mfa_factor', { user_id: 'u1', type: 'backup_codes' })).toEqual(['backup_codes']);
    expect(fields('mfa_factor', { user_id: 'u1', type: 'backup_codes', backup_code_hashes: [] })).toEqual([]);
    expect(fields('passkey', { user_id: 'u1', credential_id: 'c' })).toEqual(['public_key', 'rp_id']);
    expect(fields('membership', { organization_id: 'o' })).toEqual(['user_id', 'role']);
    expect(fields('invitation', { id: 'i' })).toEqual(['email']);
    expect(fields('api_key', { id: 'k', hash: 'h', hash_algorithm: 'md5' })).toEqual(['hash_algorithm']);
    expect(fields('sso_connection', { id: 's', protocol: 'ws-fed' })).toEqual(['protocol']);
    expect(fields('jwks', { kid: 'k' })).toEqual(['jwk']);
    expect(fields('session', { id: 's', user_id: 'u', token_hash: HASH.toUpperCase() })).toEqual(['token_hash', 'expires_at']);
  });

  it('a user needs a way to sign in, valid emails and E.164 phones', () => {
    expect(fields('user', { id: 'u1' })).toEqual(['emails']);
    expect(fields('user', { id: 'u1', username: 'ada' })).toEqual([]);
    expect(fields('user', { id: 'u1', anonymous: true })).toEqual([]);
    expect(fields('user', { id: 'u1', phones: [{ phone: '+15551234567', verified: true }] })).toEqual([]);
    expect(fields('user', { id: 'u1', phones: [{ phone: '5551234567', verified: true }] })).toEqual(['phones[0]']);
    expect(fields('user', { id: 'u1', emails: [{ email: 'not-an-email', verified: false }] })).toEqual(['emails[0]']);
    expect(fields('user', { emails: [{ email: 'a@example.com', verified: true }] })).toEqual(['id']);
  });

  it('checks the password hash shape on a user', () => {
    const user = (password: unknown) => ({ id: 'u1', username: 'ada', password });
    expect(fields('user', user({ algorithm: 'bcrypt', hash: '$2b$10$x' }))).toEqual([]);
    expect(fields('user', user({ algorithm: 'pbkdf2', hash: 'ab', salt: 'cd', params: { iterations: 1000 } }))).toEqual([]);
    expect(fields('user', user('$2b$10$x'))).toEqual(['password']);
    expect(fields('user', user({ hash: 'ab' }))).toEqual(['password.algorithm']);
    expect(fields('user', user({ algorithm: 'auto' }))).toEqual(['password.hash']);
    expect(fields('user', user({ algorithm: 'pbkdf2', hash: 'ab', salt: 7 }))).toEqual(['password.salt']);
    expect(fields('user', user({ algorithm: 'pbkdf2', hash: 'ab', params: [1] }))).toEqual(['password.params']);
    expect(validatePasswordHash(null, 'secret')[0]).toEqual({ field: 'secret', message: 'secret must be { algorithm, hash, salt?, params? }.' });
  });

  it('lists each password algorithm once, "auto" included', () => {
    expect(new Set(PASSWORD_HASH_ALGORITHMS).size).toBe(PASSWORD_HASH_ALGORITHMS.length);
    expect(PASSWORD_HASH_ALGORITHMS).toContain('auto');
    for (const a of PASSWORD_HASH_ALGORITHMS) expect(a).toMatch(/^[a-z0-9_]+$/);
  });
});

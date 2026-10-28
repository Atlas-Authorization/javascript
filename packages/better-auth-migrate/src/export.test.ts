import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { exportBetterAuth } from './export';
import {
  BundleError,
  BundleOpener,
  BundleSealer,
  LineSplitter,
  generateImportKeyPair,
  openBundleText,
  parseImportPublicKey,
} from './transport';
import { splitIntoParts } from './atlas';
import { buildFixtureBundle, createFakeBetterAuth, generateFixture } from './testing';
import type { BundleEntry, BundleManifest, BundleRecord } from './format';
import { findAuthConfig, pickAuth } from './cli';

const keyPair = () => {
  const k = generateImportKeyPair();
  return { pub: { kid: 'ik_test', publicKey: k.publicKey }, priv: k.privateKeyJwk };
};

const records = (entries: BundleEntry[], model: string) =>
  entries.filter((e): e is BundleRecord => e.type === 'record' && e.model === model).map((e) => e.data);

describe('transport', () => {
  it('seals and opens entries, chunked, across arbitrary part boundaries', async () => {
    const { pub, priv } = keyPair();
    const lines: string[] = [];
    const sealer = new BundleSealer(pub, (l) => void lines.push(l), 64);
    for (let i = 0; i < 50; i++) await sealer.add({ type: 'record', model: 'user', data: { id: `u${i}`, email: `u${i}@x.test` } });
    await sealer.finish();
    expect(lines.length).toBeGreaterThan(5); // header + many small chunks
    const text = `${lines.join('\n')}\n`;
    // Re-split at awkward byte offsets, as an upload might.
    const opener = new BundleOpener(priv);
    const splitter = new LineSplitter();
    const out: BundleEntry[] = [];
    for (let i = 0; i < text.length; i += 37) for (const l of splitter.push(text.slice(i, i + 37))) out.push(...opener.push(l));
    for (const l of splitter.flush()) out.push(...opener.push(l));
    opener.end();
    expect(records(out, 'user').map((d) => d.id)).toEqual(Array.from({ length: 50 }, (_, i) => `u${i}`));
  });

  it('refuses the wrong key, a dropped chunk, reordered chunks, a swapped header and a truncated bundle', async () => {
    const { pub, priv } = keyPair();
    const lines: string[] = [];
    const sealer = new BundleSealer(pub, (l) => void lines.push(l), 40);
    for (let i = 0; i < 10; i++) await sealer.add({ type: 'record', model: 'user', data: { id: `u${i}` } });
    await sealer.finish();
    const open = (ls: string[], k = priv) => openBundleText(ls.join('\n'), k);
    expect(open(lines)).toHaveLength(10);
    expect(() => open(lines, keyPair().priv)).toThrow(BundleError);
    expect(() => open([lines[0]!, lines[1]!, ...lines.slice(3)])).toThrow(/integrity/);
    expect(() => open([lines[0]!, lines[2]!, lines[1]!, ...lines.slice(3)])).toThrow(BundleError);
    expect(() => open(lines.slice(0, -1))).toThrow(/incomplete/);
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(() => open([JSON.stringify({ ...header, kid: 'other' }), ...lines.slice(1)])).toThrow(BundleError);
    expect(() => open([...lines, lines[1]!])).toThrow(/after its final chunk/);
  });

  it('parses every import-key shape and rejects a bad key', () => {
    const { pub } = keyPair();
    expect(parseImportPublicKey(`${pub.kid}:${pub.publicKey}`)).toEqual(pub);
    expect(parseImportPublicKey({ kid: pub.kid, public_key: pub.publicKey })).toEqual(pub);
    expect(() => parseImportPublicKey('ik:short')).toThrow(/32-byte/);
    expect(() => parseImportPublicKey('nokid')).toThrow();
  });

  it('splits upload parts on line boundaries', () => {
    const text = 'aaaa\nbbbb\ncccc\ndddd\n';
    const parts = splitIntoParts(text, 10);
    expect(parts.join('')).toBe(text);
    expect(parts.every((p) => p.endsWith('\n'))).toBe(true);
    expect(parts.length).toBe(2);
  });
});

describe('exportBetterAuth', () => {
  it('exports every model through the adapter, decrypting what Better Auth encrypted', async () => {
    const fixture = generateFixture({ withPasswords: false });
    const { pub, priv } = keyPair();
    const bundle = await buildFixtureBundle(fixture, pub, { pageSize: 2 });
    const entries = openBundleText(bundle.text, priv);

    const manifest = entries[0] as BundleManifest;
    expect(manifest.type).toBe('manifest');
    expect(manifest.betterAuth.version).toBe('1.7.12');
    expect(manifest.rpId).toBe('app.example.com');
    expect(manifest.plugins).toContain('two-factor');
    expect(manifest.settings.twoFactor).toEqual({ digits: 6, period: 30, issuer: 'Acme' });
    const end = entries[entries.length - 1]!;
    expect(end.type).toBe('end');

    // Keyset pagination: pages of 2 walked every user.
    expect(records(entries, 'user')).toHaveLength(5);
    expect(fixture.auth.adapter.calls.filter((c) => c.model === 'user').length).toBeGreaterThanOrEqual(3);

    // Order: organizations before users before accounts.
    const order = entries.filter((e): e is BundleRecord => e.type === 'record').map((e) => e.model);
    expect(order.indexOf('organization')).toBeLessThan(order.indexOf('user'));
    expect(order.indexOf('ssoProvider')).toBeLessThan(order.indexOf('account'));

    // Two-factor: decrypted secret, its base32 and the backup codes.
    const [tf] = records(entries, 'twoFactor');
    expect(tf!.secret).toBe(fixture.plain.totpSecret);
    expect(tf!.secretBase32).toMatch(/^[A-Z2-7]+$/);
    expect(tf!.backupCodes).toEqual(fixture.plain.backupCodes);

    // Sessions: live one only, token reduced to its SHA-256.
    const sessions = records(entries, 'session');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.token).toBeUndefined();
    expect(sessions[0]!.tokenHash).toBe(createHash('sha256').update(fixture.plain.sessionToken).digest('hex'));
    expect((end as { omitted: Record<string, { count: number }> }).omitted.session?.count).toBe(1);

    // Social tokens are dropped by default.
    const google = records(entries, 'account').find((a) => a.providerId === 'google')!;
    expect(google.accessToken).toBeUndefined();

    // API keys: the stored hash travels as keyHash, JSON strings parsed.
    const key = records(entries, 'apikey').find((k) => k.id === 'ba_key_alice')!;
    expect(key.key).toBeUndefined();
    expect(key.keyHash).toBe(createHash('sha256').update(fixture.plain.apiKey).digest('base64url'));
    expect(key.permissions).toEqual({ files: ['read', 'write'] });

    // JWKS: public key only.
    const [jwk] = records(entries, 'jwks');
    expect(jwk!.privateKey).toBeUndefined();
    expect((jwk!.publicKey as { kty: string }).kty).toBe('OKP');

    // OAuth: hashed secret kept as a hash; legacy plain secret carried.
    const conf = records(entries, 'oauthClient').find((c) => c.id === 'ba_oc_conf')!;
    expect(conf.clientSecret).toBeUndefined();
    expect(conf.clientSecretHash).toBe(createHash('sha256').update(fixture.plain.confidentialClientSecret).digest('base64url'));
    const legacy = records(entries, 'oauthApplication')[0]!;
    expect(legacy.clientSecret).toBe(fixture.plain.legacyClientSecret);

    // Provider tokens and verifications are counted, not exported.
    expect(records(entries, 'oauthAccessToken')).toHaveLength(0);
    expect(records(entries, 'verification')).toHaveLength(0);
    expect((end as { omitted: Record<string, { count: number }> }).omitted.verification?.count).toBe(1);
  });

  it('decrypts encrypted OAuth client secrets and OAuth tokens when configured', async () => {
    const fixture = generateFixture({ withPasswords: false });
    const { pub, priv } = keyPair();
    const bundle = await buildFixtureBundle(fixture, pub, { models: ['user', 'oauthClient'], oauthClientSecretStorage: 'encrypted' });
    const clients = records(openBundleText(bundle.text, priv), 'oauthClient');
    expect(clients.find((c) => c.id === 'ba_oc_encrypted')!.clientSecret).toBe(fixture.plain.encryptedClientSecret);
    // A hashed one cannot be decrypted: flagged, never passed through as a secret.
    expect(clients.find((c) => c.id === 'ba_oc_conf')!.decryptError).toBe(true);
  });

  it('hashes API keys stored in the clear (disableKeyHashing) before they leave', async () => {
    const { pub, priv } = keyPair();
    const auth = createFakeBetterAuth({
      data: { user: [{ id: 'u1', email: 'a@x.test', name: 'A', emailVerified: true }], apikey: [{ id: 'k1', referenceId: 'u1', key: 'plain-key-value', enabled: true }] },
    });
    const lines: string[] = [];
    await exportBetterAuth(auth, { publicKey: pub, out: { write: (l) => void lines.push(l) } });
    const [k] = records(openBundleText(lines.join('\n'), priv), 'apikey');
    expect(k!.keyHash).toBe(createHash('sha256').update('plain-key-value').digest('base64url'));
    expect(JSON.stringify(k)).not.toContain('plain-key-value');
  });

  it('writes the file atomically and never leaves plaintext on disk', async () => {
    const fixture = generateFixture({ withPasswords: false });
    const { pub, priv } = keyPair();
    const dir = mkdtempSync(join(tmpdir(), 'ba-export-'));
    const out = join(dir, 'bundle.atlas');
    const result = await exportBetterAuth(fixture.auth, { publicKey: pub, out });
    expect(existsSync(`${out}.partial`)).toBe(false);
    const text = readFileSync(out, 'utf8');
    expect(statSync(out).mode & 0o077).toBe(0);
    expect(text).not.toContain(fixture.plain.totpSecret);
    expect(text).not.toContain('alice@');
    expect(createHash('sha256').update(text).digest('hex')).toBe(result.sha256);
    expect(openBundleText(text, priv).length).toBeGreaterThan(10);
  });

  it('reports a secret that cannot decrypt instead of failing the export', async () => {
    const fixture = generateFixture({ withPasswords: false });
    const { pub, priv } = keyPair();
    const bundle = await buildFixtureBundle(fixture, pub, { models: ['user', 'twoFactor'], secret: 'the-wrong-secret' });
    const entries = openBundleText(bundle.text, priv);
    const [tf] = records(entries, 'twoFactor');
    expect(tf!.decryptError).toBe(true);
    expect(tf!.secret).toBeUndefined();
  });

  it('refuses something that is not a Better Auth instance', async () => {
    const { pub } = keyPair();
    await expect(exportBetterAuth({ $context: {} } as never, { publicKey: pub, out: { write: () => undefined } })).rejects.toThrow(/Better Auth instance/);
  });

  it('picks the auth export from a config module', () => {
    const auth = { $context: Promise.resolve({}) };
    expect(pickAuth({ auth })).toBe(auth);
    expect(pickAuth({ default: auth })).toBe(auth);
    expect(pickAuth({ custom: auth }, 'custom')).toBe(auth);
    expect(() => pickAuth({ nothing: 1 })).toThrow(/no Better Auth instance/);
  });
});

describe('findAuthConfig', () => {
  it('finds the conventional auth module, root first, then lib/, src/, app/', () => {
    const at = (files: string[]) => (p: string) => files.some((f) => p.endsWith(`/${f}`));
    expect(findAuthConfig('/app', at(['src/lib/auth.ts']))).toBe('src/lib/auth.ts');
    expect(findAuthConfig('/app', at(['src/lib/auth.ts', 'lib/auth.js']))).toBe('lib/auth.js');
    expect(findAuthConfig('/app', at(['auth.ts', 'src/auth.ts']))).toBe('auth.ts');
    expect(findAuthConfig('/app', at([]))).toBeNull();
  });
});

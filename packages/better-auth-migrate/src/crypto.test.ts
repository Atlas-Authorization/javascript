import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { hchacha20, xchacha20poly1305Decrypt, xchacha20poly1305Encrypt } from './xchacha';
import { base32Encode, betterAuthDecrypt, betterAuthEncrypt, looksEncrypted, parseEnvelope } from './ba-crypto';

type Noble = { xchacha20poly1305: (key: Uint8Array, nonce: Uint8Array) => { encrypt(p: Uint8Array): Uint8Array; decrypt(c: Uint8Array): Uint8Array } };
// The cipher Better Auth itself uses (it depends on @noble/ciphers).
const noble = async () => (await import('@noble/ciphers/chacha' as string)) as Noble;

describe('XChaCha20-Poly1305 on node:crypto', () => {
  it('matches the draft-irtf-cfrg-xchacha HChaCha20 test vector (§2.2.1)', () => {
    const key = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
    const nonce = Buffer.from('000000090000004a0000000031415927', 'hex');
    expect(hchacha20(key, nonce).toString('hex')).toBe('82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc');
  });

  it('produces the same ciphertext as @noble/ciphers for random inputs', async () => {
    const { xchacha20poly1305 } = await noble();
    for (const len of [0, 1, 15, 16, 64, 1000]) {
      const key = randomBytes(32);
      const nonce = randomBytes(24);
      const msg = randomBytes(len);
      const ours = xchacha20poly1305Encrypt(key, nonce, msg);
      const theirs = Buffer.from(xchacha20poly1305(key, nonce).encrypt(msg));
      expect(ours.equals(theirs)).toBe(true);
      expect(xchacha20poly1305Decrypt(key, nonce, theirs).equals(msg)).toBe(true);
    }
  });

  it('refuses a modified ciphertext', () => {
    const key = randomBytes(32);
    const nonce = randomBytes(24);
    const sealed = xchacha20poly1305Encrypt(key, nonce, Buffer.from('secret'));
    sealed[0]! ^= 1;
    expect(() => xchacha20poly1305Decrypt(key, nonce, sealed)).toThrow();
  });
});

describe("Better Auth's symmetric format", () => {
  const secret = 'a-better-auth-secret-of-sufficient-length';

  it("decrypts a value sealed exactly the way Better Auth seals it (noble, managed nonce, hex)", async () => {
    const { xchacha20poly1305 } = await noble();
    const key = createHash('sha256').update(secret).digest();
    const nonce = randomBytes(24);
    const sealed = Buffer.concat([nonce, Buffer.from(xchacha20poly1305(key, nonce).encrypt(Buffer.from('JBSWY3DPEHPK3PXP')))]);
    expect(betterAuthDecrypt(secret, sealed.toString('hex'))).toBe('JBSWY3DPEHPK3PXP');
  });

  it('round-trips with the rotation envelope and falls back to the legacy secret', () => {
    const config = { keys: new Map([[1, 'old-secret-value'], [2, 'new-secret-value']]), currentVersion: 2, legacySecret: secret };
    const sealed = betterAuthEncrypt(config, 'hello');
    expect(parseEnvelope(sealed)?.version).toBe(2);
    expect(betterAuthDecrypt(config, sealed)).toBe('hello');
    // A pre-rotation value (bare hex) opens with the legacy secret.
    expect(betterAuthDecrypt(config, betterAuthEncrypt(secret, 'legacy'))).toBe('legacy');
    // A retired version is a clear error, not garbage.
    const retired = { ...config, keys: new Map([[2, 'new-secret-value']]) };
    expect(() => betterAuthDecrypt(retired, betterAuthEncrypt({ ...config, currentVersion: 1 }, 'x'))).toThrow(/version 1/);
  });

  it('fails on the wrong secret', () => {
    expect(() => betterAuthDecrypt('other-secret', betterAuthEncrypt(secret, 'x'))).toThrow();
  });

  it('recognises ciphertext shapes', () => {
    expect(looksEncrypted(betterAuthEncrypt(secret, 'x'))).toBe(true);
    expect(looksEncrypted('$ba$1$00ff')).toBe(true);
    expect(looksEncrypted('["ABCDE-12345"]')).toBe(false);
  });

  it('base32-encodes like authenticator apps expect', () => {
    expect(base32Encode(Buffer.from('Hello!\xde\xad\xbe\xef', 'latin1'))).toBe('JBSWY3DPEHPK3PXP');
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
  });
});

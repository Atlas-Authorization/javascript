import { bufferToBase64Url, type DeviceKey } from '@atlasauth/js';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { TokenStorage } from './storage';

export interface SecureDeviceKeyOptions {
  /** Where the private key is kept: a Keychain / Keystore slot of its own (never AsyncStorage). */
  storage: TokenStorage;
  /** Secure random bytes, for runtimes without `crypto.getRandomValues` (Hermes): `expo-crypto`'s `getRandomBytes` fits. */
  random?: (length: number) => Uint8Array;
}

const globalRandom = (n: number): Uint8Array => {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (typeof c?.getRandomValues !== 'function') throw new Error('No secure random source: pass `random` (for example expo-crypto getRandomBytes).');
  return c.getRandomValues(new Uint8Array(n));
};

/**
 * A P-256 device key for a native session, in pure JavaScript (Hermes has no WebCrypto). The private scalar is generated
 * once from secure random bytes and kept only in `storage`; signatures are RFC 6979 deterministic, so no randomness is
 * needed after that. The private key is never logged or exported: only the public JWK and signatures leave this object.
 */
export function createSecureDeviceKey(options: SecureDeviceKeyOptions): DeviceKey {
  const random = options.random ?? globalRandom;
  let secret: Promise<Uint8Array> | undefined;
  const load = () =>
    (secret ??= (async () => {
      const saved = await options.storage.getToken();
      if (saved && /^[0-9a-f]{64}$/.test(saved)) {
        const d = hexToBytes(saved);
        if (p256.utils.isValidPrivateKey(d)) return d;
      }
      let d: Uint8Array;
      do d = random(32);
      while (!p256.utils.isValidPrivateKey(d));
      await options.storage.setToken(bytesToHex(d));
      return d;
    })().catch((e) => {
      secret = undefined;
      throw e;
    }));
  const publicJwk = async () => {
    const pub = p256.getPublicKey(await load(), false);
    return { kty: 'EC' as const, crv: 'P-256' as const, x: bufferToBase64Url(pub.slice(1, 33)), y: bufferToBase64Url(pub.slice(33, 65)) };
  };
  return {
    publicJwk,
    async thumbprint() {
      const j = await publicJwk();
      return bufferToBase64Url(sha256(new TextEncoder().encode(JSON.stringify({ crv: j.crv, kty: j.kty, x: j.x, y: j.y }))));
    },
    async sign(data) {
      return p256.sign(sha256(data), await load()).toCompactRawBytes();
    },
    random,
  };
}

/** Store two values (the key and the held refresh token) in one secure slot, so one `deviceStorage` adapter serves both. */
export function splitDeviceStorage(storage: TokenStorage): { key: TokenStorage; session: TokenStorage } {
  const read = async (): Promise<Record<string, string>> => {
    try {
      const v = JSON.parse((await storage.getToken()) ?? '{}') as unknown;
      return v && typeof v === 'object' ? (v as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  // Serialised, so two writes at once never drop one another.
  let chain: Promise<void> = Promise.resolve();
  const slot = (name: 'key' | 'session'): TokenStorage => ({
    getToken: async () => (await read())[name] ?? null,
    setToken: (value) => (chain = chain.catch(() => undefined).then(async () => { await storage.setToken(JSON.stringify({ ...(await read()), [name]: value })); })),
    clearToken: () =>
      (chain = chain.catch(() => undefined).then(async () => {
        const { [name]: _gone, ...rest } = await read();
        await storage.setToken(JSON.stringify(rest));
      })),
  });
  return { key: slot('key'), session: slot('session') };
}

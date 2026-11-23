import { b64uJson, htuOf, jwkThumbprint, sha256Base64Url, type DpopKeyStore } from './dpop';
import type { DeviceKeyJwk } from './device-key';
import { bufferToBase64Url } from './passkey';

/**
 * The key a native session is bound to. The server stores its thumbprint when the session is created and, from then
 * on, answers a refresh only when it carries a proof signed by this key, so a refresh token copied off the device is
 * useless without it. Keep the private half in the OS secure store: never log it, never export it.
 */
export interface DeviceKey {
  /** The public JWK sent as `device_key` on sign-in. */
  publicJwk(): Promise<DeviceKeyJwk>;
  /** RFC 7638 thumbprint of the public key. */
  thumbprint(): Promise<string>;
  /** ES256 over `data` (hashed with SHA-256 inside): the raw 64-byte `r || s`, not DER. */
  sign(data: Uint8Array): Promise<Uint8Array>;
  /** Secure random bytes for the proof's `jti`, when the runtime has no `crypto.getRandomValues`. */
  random?(length: number): Uint8Array;
}

/** A non-extractable WebCrypto ES256 key, persisted through `store` (a CryptoKey can live in IndexedDB). Default: memory. */
export function createWebCryptoDeviceKey(options: { store?: DpopKeyStore } = {}): DeviceKey {
  let pair: Promise<CryptoKeyPair> | undefined;
  const keys = () =>
    (pair ??= (async () => {
      const saved = await options.store?.get();
      if (saved) return saved;
      const fresh = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      await options.store?.set(fresh);
      return fresh;
    })().catch((e) => {
      pair = undefined;
      throw e;
    }));
  const publicJwk = async (): Promise<DeviceKeyJwk> => {
    const { x, y } = (await crypto.subtle.exportKey('jwk', (await keys()).publicKey)) as JsonWebKey;
    return { kty: 'EC', crv: 'P-256', x: x!, y: y! };
  };
  return {
    publicJwk,
    thumbprint: async () => jwkThumbprint(await publicJwk()),
    // WebCrypto already answers ECDSA as raw r || s.
    sign: async (data) => new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, (await keys()).privateKey, data as BufferSource)),
  };
}

/**
 * The DPoP proof (RFC 9449) a bound session's refresh carries: `htm`, `htu`, a fresh `iat` and single-use `jti`,
 * `ath` = SHA-256 of the refresh token presented, and the server's `nonce` once it has issued one.
 */
export async function deviceProof(
  key: DeviceKey,
  method: string,
  url: string | URL,
  opts: { refreshToken: string; nonce?: string },
): Promise<string> {
  const jti = bufferToBase64Url(key.random ? key.random(16) : crypto.getRandomValues(new Uint8Array(16)));
  const payload: Record<string, unknown> = {
    jti,
    htm: method.toUpperCase(),
    htu: htuOf(url),
    iat: Math.floor(Date.now() / 1000),
    ath: await sha256Base64Url(opts.refreshToken),
  };
  if (opts.nonce) payload.nonce = opts.nonce;
  const signingInput = `${b64uJson({ typ: 'dpop+jwt', alg: 'ES256', jwk: await key.publicJwk() })}.${b64uJson(payload)}`;
  const sig = await key.sign(new TextEncoder().encode(signingInput));
  return `${signingInput}.${bufferToBase64Url(sig)}`;
}

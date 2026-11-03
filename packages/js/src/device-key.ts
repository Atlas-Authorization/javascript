/**
 * Device-bound biometric sign-in — the client half.
 *
 * A native app keeps an ES256 keypair in the OS secure hardware (Secure Enclave
 * / Android Keystore), unlocked by Face ID / fingerprint. The public half is
 * registered once while signed in; later the app signs in by signing a server
 * challenge with the private half. The keystore is the app's: it supplies a
 * {@link DeviceKeySigner} (`createKey` + `sign` behind a biometric prompt).
 * {@link webCryptoSigner} is a software signer for tests and web/RN-polyfill use.
 *
 * Server routes: POST /v1/client/me/device_keys/challenge → /device_keys,
 * POST /v1/client/sign_ins/device_key/challenge → /finish.
 */
import type { FapiClient, FapiResponse } from './fapi';

export interface DeviceKeyJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export interface DeviceKeySigner {
  /** Creates the keypair and returns its public JWK. `biometric` asks for a key that needs the OS biometric prompt to use. */
  createKey(opts: { biometric: boolean }): Promise<DeviceKeyJwk>;
  /** Signs the UTF-8 message with ES256, returning base64url IEEE-P1363 (r||s). Shows the biometric prompt for a biometric key. */
  sign(message: string): Promise<string>;
}

export type DeviceKeyPurpose = 'register' | 'sign_in';

/** The exact string the device signs; mirrors the server so a signature is bound to its use, tenant and key. */
export function deviceKeyMessage(input: { purpose: DeviceKeyPurpose; instanceId: string; keyId: string; nonce: string }): string {
  return `atlas-device-key:v1:${input.purpose}:${input.instanceId}:${input.keyId}:${input.nonce}`;
}

interface Challenge {
  nonce: string;
  expires_at: number;
}

export interface RegisterDeviceKeyOptions {
  client: FapiClient;
  signer: DeviceKeySigner;
  /** Your instance id (`ins_…`), as shown in the dashboard. */
  instanceId: string;
  label?: string;
  platform?: 'ios' | 'android' | 'other';
  /** Whether the key needs biometrics to use. Default true. */
  biometric?: boolean;
}

/** Registers this device's key for the signed-in user (needs a recent re-authentication). Returns the `device_key` resource. */
export async function registerDeviceKey(opts: RegisterDeviceKeyOptions): Promise<FapiResponse<{ id: string }>> {
  const { client, signer, instanceId } = opts;
  const biometric = opts.biometric ?? true;
  const challenge = await client.post<Challenge>('/v1/client/me/device_keys/challenge', {});
  if (!challenge.ok || !challenge.data) return challenge as unknown as FapiResponse<{ id: string }>;
  const jwk = await signer.createKey({ biometric });
  // Proof of possession: the register message names the key by its x coordinate.
  const signature = await signer.sign(deviceKeyMessage({ purpose: 'register', instanceId, keyId: jwk.x, nonce: challenge.data.nonce }));
  return client.post<{ id: string }>('/v1/client/me/device_keys', {
    nonce: challenge.data.nonce,
    public_key: jwk,
    signature,
    biometric_bound: biometric,
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.platform ? { platform: opts.platform } : {}),
  });
}

export interface SignInWithDeviceKeyOptions {
  client: FapiClient;
  signer: DeviceKeySigner;
  instanceId: string;
  /** The `id` returned by {@link registerDeviceKey}, which the app stores. */
  deviceKeyId: string;
}

/**
 * Signs in with the registered device key. The response is the usual sign-in
 * attempt: `complete` with a session, or `needs_second_factor` when the instance
 * does not let a device key stand in for MFA.
 */
export async function signInWithDeviceKey(opts: SignInWithDeviceKeyOptions): Promise<FapiResponse<Record<string, unknown>>> {
  const { client, signer, instanceId, deviceKeyId } = opts;
  const challenge = await client.post<Challenge>('/v1/client/sign_ins/device_key/challenge', { device_key_id: deviceKeyId });
  if (!challenge.ok || !challenge.data) return challenge as unknown as FapiResponse<Record<string, unknown>>;
  const signature = await signer.sign(deviceKeyMessage({ purpose: 'sign_in', instanceId, keyId: deviceKeyId, nonce: challenge.data.nonce }));
  return client.post<Record<string, unknown>>('/v1/client/sign_ins/device_key/finish', {
    device_key_id: deviceKeyId,
    nonce: challenge.data.nonce,
    signature,
  });
}

const toB64u = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A software signer on WebCrypto — no hardware or biometric binding; for tests and prototypes. */
export function webCryptoSigner(subtle: SubtleCrypto = globalThis.crypto.subtle): DeviceKeySigner {
  let pair: CryptoKeyPair | undefined;
  return {
    async createKey() {
      pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const jwk = await subtle.exportKey('jwk', pair.publicKey);
      return { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! };
    },
    async sign(message) {
      if (!pair) throw new Error('No device key has been created.');
      return toB64u(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(message)));
    },
  };
}

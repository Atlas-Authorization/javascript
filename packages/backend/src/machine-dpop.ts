import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto';

/**
 * DPoP (RFC 9449) for a machine: a key the machine holds, and the proofs it signs with it.
 * A token minted with a proof from this key carries `cnf.jkt`, and a resource server accepts
 * it only with a fresh proof from the same key, so a stolen token is useless on its own.
 * Node only. Ed25519 and P-256 keys are supported.
 */

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** A new Ed25519 key for DPoP, as a PKCS#8 PEM. Keep it as safely as the machine's own key. */
export function generateDpopKey(): string {
  return generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

interface PublicJwk {
  kty: string;
  crv: string;
  x: string;
  y?: string;
}

function publicJwkOf(privateKeyPem: string): { jwk: PublicJwk; alg: 'EdDSA' | 'ES256' } {
  const priv = createPrivateKey(privateKeyPem);
  const jwk = createPublicKey(priv).export({ format: 'jwk' }) as PublicJwk;
  const type = priv.asymmetricKeyType;
  if (type === 'ed25519') return { jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, alg: 'EdDSA' };
  if (type === 'ec' && jwk.crv === 'P-256') return { jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, alg: 'ES256' };
  throw new Error('A DPoP key must be Ed25519 or P-256.');
}

/** The RFC 7638 thumbprint of the key: the `cnf.jkt` a token minted with its proofs carries. */
export function dpopThumbprint(privateKeyPem: string): string {
  const { jwk } = publicJwkOf(privateKeyPem);
  const canonical = jwk.kty === 'EC' ? `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}` : `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`;
  return createHash('sha256').update(canonical).digest('base64url');
}

/**
 * Sign one DPoP proof for one request. `url` is the full request URL (query and fragment are
 * dropped, as the standard requires); pass `accessToken` when calling a resource server so the
 * proof names the token, and `nonce` when the server answered `use_dpop_nonce`.
 */
export function createDpopProof(opts: { privateKeyPem: string; method: string; url: string; accessToken?: string; nonce?: string; now?: () => number }): string {
  const { jwk, alg } = publicJwkOf(opts.privateKeyPem);
  const u = new URL(opts.url);
  const header = { typ: 'dpop+jwt', alg, jwk };
  const payload = {
    jti: randomUUID(),
    htm: opts.method.toUpperCase(),
    htu: `${u.origin}${u.pathname}`,
    iat: Math.floor((opts.now ?? Date.now)() / 1000),
    ...(opts.accessToken ? { ath: createHash('sha256').update(opts.accessToken).digest('base64url') } : {}),
    ...(opts.nonce ? { nonce: opts.nonce } : {}),
  };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const key = createPrivateKey(opts.privateKeyPem);
  const signature = alg === 'EdDSA' ? cryptoSign(null, Buffer.from(input), key) : cryptoSign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64u(signature)}`;
}

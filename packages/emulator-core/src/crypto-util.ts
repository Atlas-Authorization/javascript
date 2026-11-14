/* eslint-disable @typescript-eslint/no-explicit-any */
/** Web Crypto helpers (portable: no node:crypto, so the engine still runs in a browser worker). */
const b64urlToBytes = (s: string): Uint8Array => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(pad + '='.repeat((4 - (pad.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
export const bytesToB64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const enc = new TextEncoder();

export const sha256 = async (data: string | Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', (typeof data === 'string' ? enc.encode(data) : data) as BufferSource));

const pemToDer = (pem: string): Uint8Array => {
  const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
};

type KeyKind = { import: any; verify: any; jwkKeys: string[] };
const KINDS: KeyKind[] = [
  { import: { name: 'Ed25519' }, verify: { name: 'Ed25519' }, jwkKeys: ['crv', 'kty', 'x'] },
  { import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' }, jwkKeys: ['crv', 'kty', 'x', 'y'] },
  { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' }, jwkKeys: ['e', 'kty', 'n'] },
];

async function importPublic(pem: string): Promise<{ key: CryptoKey; kind: KeyKind } | null> {
  let der: Uint8Array;
  try {
    der = pemToDer(pem);
  } catch {
    return null;
  }
  for (const kind of KINDS) {
    try {
      return { key: await crypto.subtle.importKey('spki', der as BufferSource, kind.import, true, ['verify']), kind };
    } catch {
      /* try the next key type */
    }
  }
  return null;
}

/** Whether `pem` is a public key of a type a device may enrol with (Ed25519, ECDSA P-256, RSA). */
export const isDeviceKey = async (pem: string): Promise<boolean> => (await importPublic(pem)) !== null;

/** RFC 7638 thumbprint of an SPKI PEM, base64url, or null for a key this engine cannot read. */
export async function jwkThumbprint(pem: string): Promise<string | null> {
  const k = await importPublic(pem);
  if (!k) return null;
  const jwk = (await crypto.subtle.exportKey('jwk', k.key)) as Record<string, string>;
  const canonical = JSON.stringify(Object.fromEntries(k.kind.jwkKeys.map((n) => [n, jwk[n]])));
  return bytesToB64url(await sha256(canonical));
}

/** Verify a device's signature over the raw challenge string, the way the real route does (EC signatures are r||s). Never throws. */
export async function verifyDeviceSignature(pem: string, challenge: string, signatureB64url: string): Promise<boolean> {
  try {
    const k = await importPublic(pem);
    if (!k) return false;
    return await crypto.subtle.verify(k.kind.verify, k.key, b64urlToBytes(signatureB64url) as BufferSource, enc.encode(challenge) as BufferSource);
  } catch {
    return false;
  }
}

/** PKCE S256 challenge for a verifier. */
export const pkceChallenge = async (verifier: string): Promise<string> => bytesToB64url(await sha256(verifier));

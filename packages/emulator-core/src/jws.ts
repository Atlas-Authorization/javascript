/* eslint-disable @typescript-eslint/no-explicit-any */
import { bytesToB64url, sha256 } from './crypto-util';

/** JWS and DPoP helpers on Web Crypto only (no node:crypto), so the engine still runs in a browser worker. */
export const b64urlDecode = (s: string): Uint8Array => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(pad + '='.repeat((4 - (pad.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const text = (s: string): string => new TextDecoder().decode(b64urlDecode(s));

export interface DecodedJwt {
  header: Record<string, any>;
  payload: Record<string, any>;
  signingInput: string;
  signature: Uint8Array;
}

/** Split and parse a compact JWS; null when it is not one. Does not verify anything. */
export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  try {
    const header = JSON.parse(text(parts[0]!));
    const payload = JSON.parse(text(parts[1]!));
    if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') return null;
    return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: b64urlDecode(parts[2]!) };
  } catch {
    return null;
  }
}

interface AlgSpec {
  import: any;
  verify: any;
}
const hashOf = (bits: string) => `SHA-${bits}`;
const ALGS: Record<string, AlgSpec> = {
  ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: hashOf('256') } },
  ES384: { import: { name: 'ECDSA', namedCurve: 'P-384' }, verify: { name: 'ECDSA', hash: hashOf('384') } },
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: hashOf('256') }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
  RS384: { import: { name: 'RSASSA-PKCS1-v1_5', hash: hashOf('384') }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
  RS512: { import: { name: 'RSASSA-PKCS1-v1_5', hash: hashOf('512') }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
  ES512: { import: { name: 'ECDSA', namedCurve: 'P-521' }, verify: { name: 'ECDSA', hash: hashOf('512') } },
  PS256: { import: { name: 'RSA-PSS', hash: hashOf('256') }, verify: { name: 'RSA-PSS', saltLength: 32 } },
  PS384: { import: { name: 'RSA-PSS', hash: hashOf('384') }, verify: { name: 'RSA-PSS', saltLength: 48 } },
  EdDSA: { import: { name: 'Ed25519' }, verify: { name: 'Ed25519' } },
};
export const SUPPORTED_ALGS = Object.keys(ALGS);

/** Verify a JWS signature with a public JWK. Never throws; a private-key JWK is refused. */
export async function verifyJws(jwt: DecodedJwt, jwk: Record<string, any>): Promise<boolean> {
  const spec = ALGS[String(jwt.header.alg)];
  if (!spec || 'd' in jwk || 'k' in jwk) return false;
  try {
    const key = await crypto.subtle.importKey('jwk', { ...jwk, alg: undefined, use: undefined, key_ops: undefined } as JsonWebKey, spec.import, false, ['verify']);
    return await crypto.subtle.verify(spec.verify, key, jwt.signature as BufferSource, new TextEncoder().encode(jwt.signingInput) as BufferSource);
  } catch {
    return false;
  }
}

const THUMB_KEYS: Record<string, string[]> = { EC: ['crv', 'kty', 'x', 'y'], RSA: ['e', 'kty', 'n'], OKP: ['crv', 'kty', 'x'] };

/** RFC 7638 thumbprint of a public JWK (base64url SHA-256); null for a key type the engine does not read. */
export async function jwkThumbprintOf(jwk: Record<string, any>): Promise<string | null> {
  const keys = THUMB_KEYS[String(jwk.kty)];
  if (!keys || keys.some((k) => typeof jwk[k] !== 'string')) return null;
  return bytesToB64url(await sha256(JSON.stringify(Object.fromEntries(keys.map((k) => [k, jwk[k]])))));
}

/** `*` any run of characters, `?` one character; anchored. */
export const globMatch = (pattern: string, value: string): boolean => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's').test(value);

export const DPOP_IAT_WINDOW_S = 300;

export interface DpopCheck {
  proof: string;
  htm: string;
  /** The URL the request was sent to; query and fragment are ignored (RFC 9449 section 4.3). */
  htu: string;
  nowMs: number;
  /** When the proof accompanies an access token, the token it must hash (`ath`). */
  accessToken?: string;
  /** The server nonce the proof must carry, when one was issued. */
  nonce?: string;
}

const stripUrl = (u: string): string => {
  const x = new URL(u);
  return `${x.protocol}//${x.host}${x.pathname}`;
};

/** Validate a DPoP proof per RFC 9449. Returns the key thumbprint and jti, or throws Error(reason). Replay (jti) is the caller's. */
export async function verifyDpopProof(c: DpopCheck): Promise<{ jkt: string; jti: string; iat: number }> {
  const jwt = decodeJwt(c.proof);
  if (!jwt) throw new Error('The DPoP proof is not a JWT.');
  const { header, payload } = jwt;
  if (header.typ !== 'dpop+jwt') throw new Error('The DPoP proof typ must be dpop+jwt.');
  if (!(String(header.alg) in ALGS)) throw new Error('The DPoP proof alg is not an asymmetric algorithm this server accepts.');
  const jwk = header.jwk;
  if (!jwk || typeof jwk !== 'object' || 'd' in jwk) throw new Error('The DPoP proof header must carry a public jwk.');
  if (!(await verifyJws(jwt, jwk))) throw new Error('The DPoP proof signature does not verify against its jwk.');
  if (typeof payload.jti !== 'string' || !payload.jti) throw new Error('The DPoP proof needs a jti.');
  if (String(payload.htm).toUpperCase() !== c.htm.toUpperCase()) throw new Error('The DPoP proof htm does not match the request method.');
  if (typeof payload.htu !== 'string' || stripUrl(payload.htu) !== stripUrl(c.htu)) throw new Error('The DPoP proof htu does not match the request URL.');
  if (typeof payload.iat !== 'number' || Math.abs(c.nowMs / 1000 - payload.iat) > DPOP_IAT_WINDOW_S) throw new Error('The DPoP proof iat is outside the accepted window.');
  if (c.nonce !== undefined && payload.nonce !== c.nonce) throw new Error('The DPoP proof nonce is missing or wrong.');
  if (c.accessToken !== undefined && payload.ath !== bytesToB64url(await sha256(c.accessToken))) throw new Error('The DPoP proof ath does not match the access token.');
  const jkt = await jwkThumbprintOf(jwk);
  if (!jkt) throw new Error('The DPoP proof jwk is not a key type this server reads.');
  return { jkt, jti: payload.jti, iat: payload.iat };
}

/**
 * The client certificate thumbprint (`x5t#S256`) a trusted edge forwarded, for mTLS binding. The emulator has no TLS, so
 * it reads what a proxy would set: `x-client-cert` (PEM, optionally URL-encoded) or `x-client-cert-sha256` (the
 * fingerprint, hex or base64url). Returns undefined when neither is present, null when one is present but unreadable.
 */
export async function forwardedCertThumbprint(headers: Headers): Promise<string | undefined | null> {
  const pem = headers.get('x-client-cert');
  if (pem) {
    try {
      const body = decodeURIComponent(pem).replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
      const der = Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
      if (!der.length) return null;
      return bytesToB64url(await sha256(der));
    } catch {
      return null;
    }
  }
  const fp = headers.get('x-client-cert-sha256');
  if (!fp) return undefined;
  const hex = fp.replace(/:/g, '');
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return bytesToB64url(Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16))));
  return /^[A-Za-z0-9_-]{43}$/.test(fp) ? fp : null;
}

/**
 * Key-pair API keys: sign and verify the short-lived JWT ("assertion") a holder
 * presents instead of a shared secret. Built on Web Crypto, so it runs on every
 * runtime the rest of the package does. ES256 signatures are raw r||s (what Web
 * Crypto produces natively), never DER.
 */
import { randomBytes } from './edge-crypto';

export type AssertionAlg = 'ES256' | 'EdDSA';

const subtle = () => globalThis.crypto.subtle;
// No DOM lib in this package: name WebCrypto's key type through the global it comes from.
type WebCryptoKey = Awaited<ReturnType<ReturnType<typeof subtle>['importKey']>>;
const ES256_PARAMS = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export const b64url = (bytes: Uint8Array | string): string =>
  Buffer.from(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes).toString('base64url');

export function b64urlDecode(text: string): Uint8Array | null {
  return /^[A-Za-z0-9_-]*$/.test(text) ? new Uint8Array(Buffer.from(text, 'base64url')) : null;
}

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return new Uint8Array(Buffer.from(body, 'base64'));
}

/** Import a PKCS#8 (private) or SPKI (public) PEM as a P-256 or Ed25519 key. Null when it is neither. */
async function importPem(pem: string, kind: 'private' | 'public', only?: AssertionAlg): Promise<{ key: WebCryptoKey; alg: AssertionAlg } | null> {
  const der = pemToDer(pem);
  const format = kind === 'private' ? 'pkcs8' : 'spki';
  const usage: ('sign' | 'verify')[] = [kind === 'private' ? 'sign' : 'verify'];
  if (only !== 'EdDSA') {
    try {
      return { key: await subtle().importKey(format, der, ES256_PARAMS, false, usage), alg: 'ES256' };
    } catch {
      /* not P-256: try Ed25519 */
    }
  }
  if (only !== 'ES256') {
    try {
      return { key: await subtle().importKey(format, der, 'Ed25519', false, usage), alg: 'EdDSA' };
    } catch {
      /* neither */
    }
  }
  return null;
}

export interface SignApiKeyAssertionOptions {
  /** The key's id (`key_id`): becomes the `kid` header and the `iss` claim. */
  keyId: string;
  /** The key's `audience`. */
  audience: string;
  /** Lifetime in seconds (default 300). Must not exceed the key's `max_token_lifetime_seconds` (default 3600). */
  ttlSeconds?: number;
  /** Narrow the assertion to these scopes (a subset of the key's). */
  scope?: string | string[];
  /** Single-use id (default: random). */
  jti?: string;
  /** Epoch ms, for tests. */
  now?: number;
}

/**
 * Sign a key-pair assertion with the PKCS#8 PEM private key Atlas returned at create
 * (P-256 gives ES256, Ed25519 gives EdDSA). Present it to `apiKeys.verify({ token })`,
 * `apiKeys.mintToken({ assertion })` or `keyMirror.verifyAssertion`.
 */
export async function signApiKeyAssertion(privateKeyPem: string, options: SignApiKeyAssertionOptions): Promise<string> {
  const imported = await importPem(privateKeyPem, 'private');
  if (!imported) throw new TypeError('signApiKeyAssertion needs a PKCS#8 PEM private key (P-256 or Ed25519).');
  const iat = Math.floor((options.now ?? Date.now()) / 1000);
  const scope = Array.isArray(options.scope) ? options.scope.join(' ') : options.scope;
  const header = { alg: imported.alg, kid: options.keyId, typ: 'JWT' };
  const claims = {
    iss: options.keyId,
    aud: options.audience,
    iat,
    exp: iat + (options.ttlSeconds ?? 300),
    jti: options.jti ?? b64url(randomBytes(16)),
    ...(scope ? { scope } : {}),
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const algorithm = imported.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : 'Ed25519';
  const sig = await subtle().sign(algorithm, imported.key, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

export interface ParsedAssertion {
  header: { alg?: unknown; kid?: unknown; typ?: unknown };
  claims: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
}

/** Split and decode a compact JWS. Null when it is not three base64url segments of JSON. */
export function parseAssertion(jwt: string): ParsedAssertion | null {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const [h, c, s] = parts as [string, string, string];
  const hb = b64urlDecode(h);
  const cb = b64urlDecode(c);
  const signature = b64urlDecode(s);
  if (!hb || !cb || !signature) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(hb));
    const claims = JSON.parse(new TextDecoder().decode(cb));
    if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') return null;
    return { header, claims, signingInput: `${h}.${c}`, signature };
  } catch {
    return null;
  }
}

/** Check the signature against an SPKI PEM public key; the header `alg` must match the key's type. */
export async function verifyAssertionSignature(parsed: ParsedAssertion, publicKeyPem: string): Promise<boolean> {
  const alg = parsed.header.alg;
  if (alg !== 'ES256' && alg !== 'EdDSA') return false;
  const imported = await importPem(publicKeyPem, 'public', alg);
  if (!imported) return false;
  const algorithm = alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : 'Ed25519';
  if (alg === 'ES256' && parsed.signature.length !== 64) return false;
  try {
    return await subtle().verify(algorithm, imported.key, parsed.signature, new TextEncoder().encode(parsed.signingInput));
  } catch {
    return false;
  }
}

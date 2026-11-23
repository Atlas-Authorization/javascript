/* eslint-disable @typescript-eslint/no-explicit-any */
import { EmulatorError } from '../errors';
import { jwkThumbprint } from '../crypto-util';
import { decodeJwt } from '../jws';

/** Key-pair API keys on Web Crypto only (the engine also runs in a browser worker): generation, bring-your-own keys and assertion checks, with the real refusal codes. */

export type AssertionRefusal = 'invalid_assertion' | 'assertion_expired' | 'assertion_not_yet_valid' | 'wrong_audience' | 'assertion_lifetime_too_long' | 'assertion_replayed' | 'scope_not_granted';

const IAT_FUTURE_SKEW_S = 60;
const EXP_SKEW_S = 30;
const DEFAULT_MAX_LIFETIME_S = 3600;
const HARD_MAX_LIFETIME_S = 86_400;

type Alg = 'ES256' | 'EdDSA';
const IMPORT: Record<Alg, any> = { ES256: { name: 'ECDSA', namedCurve: 'P-256' }, EdDSA: { name: 'Ed25519' } };
const VERIFY: Record<Alg, any> = { ES256: { name: 'ECDSA', hash: 'SHA-256' }, EdDSA: { name: 'Ed25519' } };

const pemToDer = (pem: string): Uint8Array => Uint8Array.from(atob(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
const toPem = (label: string, der: ArrayBuffer): string => {
  let bin = '';
  for (const b of new Uint8Array(der)) bin += String.fromCharCode(b);
  return `-----BEGIN ${label}-----\n${btoa(bin).match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----`;
};

async function importPublic(pem: string): Promise<{ key: CryptoKey; alg: Alg } | null> {
  let der: Uint8Array;
  try {
    der = pemToDer(pem);
  } catch {
    return null;
  }
  for (const alg of ['ES256', 'EdDSA'] as const) {
    try {
      return { key: await crypto.subtle.importKey('spki', der as BufferSource, IMPORT[alg], false, ['verify']), alg };
    } catch {
      /* try the next type */
    }
  }
  return null;
}

/** A fresh P-256 pair: the public SPKI PEM to keep and the PKCS#8 PEM to hand over once. */
export async function generateKeyPair(): Promise<{ publicKey: string; privateKey: string; jkt: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = toPem('PUBLIC KEY', await crypto.subtle.exportKey('spki', pair.publicKey));
  return { publicKey, privateKey: toPem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', pair.privateKey)), jkt: (await jwkThumbprint(publicKey)) ?? '' };
}

/** A holder's own public key: SPKI PEM, P-256 or Ed25519 only (400 on `public_key`). */
export async function parseHolderPublicKey(raw: unknown): Promise<{ publicKey: string; jkt: string }> {
  const bad = () => new EmulatorError('VALIDATION_FAILED', 'public_key must be an SPKI PEM public key ("-----BEGIN PUBLIC KEY-----") on P-256 or Ed25519.', 'public_key');
  if (typeof raw !== 'string' || !raw.includes('BEGIN PUBLIC KEY') || raw.length > 2048 || !(await importPublic(raw))) throw bad();
  return { publicKey: raw.trim(), jkt: (await jwkThumbprint(raw)) ?? '' };
}

/** The `kid` of something shaped like a compact JWS, or null. */
export const peekKid = (token: string): string | null => {
  const kid = decodeJwt(token)?.header.kid;
  return typeof kid === 'string' && kid ? kid : null;
};

export type Verdict = { ok: true; jti: string | null; exp: number; scope: string[] | null } | { ok: false; code: AssertionRefusal; authentic: boolean };

/** Check an assertion against a key_pair row: signature first, then the claims, in the order the server does. */
export async function verifyAssertion(key: { id: string; public_key: string; audience: string | null; max_token_lifetime_seconds?: number | null }, token: string, nowMs: number): Promise<Verdict> {
  const fail = (code: AssertionRefusal, authentic = false): Verdict => ({ ok: false, code, authentic });
  const jwt = decodeJwt(token);
  if (!jwt) return fail('invalid_assertion');
  const { header, payload: claims } = jwt;
  if (header.crit !== undefined || (header.typ !== undefined && header.typ !== 'JWT') || (header.alg !== 'ES256' && header.alg !== 'EdDSA') || header.kid !== key.id) return fail('invalid_assertion');
  const pub = await importPublic(key.public_key);
  // The stored key decides the algorithm; the header only has to agree.
  if (!pub || pub.alg !== header.alg || jwt.signature.length !== 64) return fail('invalid_assertion');
  let good = false;
  try {
    good = await crypto.subtle.verify(VERIFY[pub.alg], pub.key, jwt.signature as BufferSource, new TextEncoder().encode(jwt.signingInput) as BufferSource);
  } catch {
    good = false;
  }
  if (!good || claims.iss !== key.id) return fail('invalid_assertion');

  const aud = claims.aud;
  if (key.audience === null || !(typeof aud === 'string' ? aud === key.audience : Array.isArray(aud) && aud.includes(key.audience))) return fail('wrong_audience', true);
  const { iat, exp, nbf } = claims;
  if (typeof iat !== 'number' || typeof exp !== 'number' || (nbf !== undefined && typeof nbf !== 'number')) return fail('invalid_assertion', true);
  if (claims.jti !== undefined && (typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > 256)) return fail('invalid_assertion', true);
  const nowS = nowMs / 1000;
  if (exp <= nowS - EXP_SKEW_S) return fail('assertion_expired', true);
  if (iat > nowS + IAT_FUTURE_SKEW_S || (typeof nbf === 'number' && nbf > nowS + EXP_SKEW_S)) return fail('assertion_not_yet_valid', true);
  if (exp <= iat) return fail('invalid_assertion', true);
  if (exp - iat > Math.min(key.max_token_lifetime_seconds ?? DEFAULT_MAX_LIFETIME_S, HARD_MAX_LIFETIME_S)) return fail('assertion_lifetime_too_long', true);
  let scope: string[] | null = null;
  if (claims.scope !== undefined) {
    if (typeof claims.scope !== 'string') return fail('invalid_assertion', true);
    scope = claims.scope.split(/\s+/).filter(Boolean);
  }
  return { ok: true, jti: claims.jti ?? null, exp, scope };
}

/** `scope` may only narrow what the key holds; null when something is not granted. */
export const narrowScopes = (held: string[], requested: string[] | null): string[] | null =>
  requested === null ? held : requested.every((s) => held.includes(s) || held.includes('*')) ? [...new Set(requested)] : null;

/** Single use until `exp`: false on a replay. The used ids live on the key row. */
export function claimJti(row: Record<string, any>, jti: string, expSeconds: number, nowMs: number): boolean {
  const used: Record<string, number> = (row.used_jtis ??= {});
  for (const [id, until] of Object.entries(used)) if (until * 1000 < nowMs) delete used[id];
  if (jti in used) return false;
  used[jti] = expSeconds + EXP_SKEW_S;
  return true;
}

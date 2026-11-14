/* eslint-disable @typescript-eslint/no-explicit-any */
import { bytesToB64url, sha256 } from './crypto-util';

/**
 * A virtual WebAuthn authenticator (software "platform" device, ES256, `none` attestation) for tests: it answers
 * `navigator.credentials.create/get` options with real attestation objects and assertions, so a relying party's own
 * verification code (or the engine's Passkey API) runs against genuine bytes. Portable: Web Crypto only.
 */

const enc = new TextEncoder();
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};
const unb64url = (s: string): Uint8Array => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

// ── CBOR (the subset WebAuthn uses: unsigned/negative ints, byte/text strings, arrays, maps) ──

const head = (major: number, n: number): Uint8Array => {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 256) return Uint8Array.of((major << 5) | 24, n);
  if (n < 65536) return Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
  return Uint8Array.of((major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
};
export function cborEncode(v: any): Uint8Array {
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  if (typeof v === 'string') {
    const b = enc.encode(v);
    return concat(head(3, b.length), b);
  }
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Array.isArray(v)) return concat(head(4, v.length), ...v.map(cborEncode));
  if (v instanceof Map) return concat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cborEncode(k), cborEncode(x)]));
  if (v && typeof v === 'object') return cborEncode(new Map(Object.entries(v)));
  throw new Error('cbor: unsupported value');
}
/** Decode one CBOR item; returns the value and the offset after it (the attested credential data is followed by nothing here, but COSE keys sit mid-buffer). */
export function cborDecode(buf: Uint8Array, at = 0): { value: any; end: number } {
  const first = buf[at]!;
  const major = first >> 5;
  const info = first & 31;
  let i = at + 1;
  let n = info;
  if (info === 24) (n = buf[i]!, (i += 1));
  else if (info === 25) (n = (buf[i]! << 8) | buf[i + 1]!, (i += 2));
  else if (info === 26) (n = buf[i]! * 2 ** 24 + (buf[i + 1]! << 16) + (buf[i + 2]! << 8) + buf[i + 3]!, (i += 4));
  else if (info > 26) throw new Error('cbor: length too large');
  if (major === 0) return { value: n, end: i };
  if (major === 1) return { value: -1 - n, end: i };
  if (major === 2) return { value: buf.slice(i, i + n), end: i + n };
  if (major === 3) return { value: new TextDecoder().decode(buf.slice(i, i + n)), end: i + n };
  if (major === 4) {
    const arr: any[] = [];
    for (let k = 0; k < n; k++) {
      const r = cborDecode(buf, i);
      arr.push(r.value);
      i = r.end;
    }
    return { value: arr, end: i };
  }
  if (major === 5) {
    const map = new Map<any, any>();
    for (let k = 0; k < n; k++) {
      const key = cborDecode(buf, i);
      const val = cborDecode(buf, key.end);
      map.set(key.value, val.value);
      i = val.end;
    }
    return { value: map, end: i };
  }
  throw new Error('cbor: unsupported major type');
}

/** ECDSA signatures from Web Crypto are r||s; WebAuthn carries ASN.1 DER. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const int = (b: Uint8Array): Uint8Array => {
    let s = 0;
    while (s < b.length - 1 && b[s] === 0) s++;
    const trimmed = b.slice(s);
    const body = trimmed[0]! & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed;
    return concat(Uint8Array.of(0x02, body.length), body);
  };
  const r = int(raw.slice(0, half));
  const s = int(raw.slice(half));
  return concat(Uint8Array.of(0x30, r.length + s.length), r, s);
}
export function derToRaw(der: Uint8Array, size = 32): Uint8Array {
  let i = 2;
  if (der[1]! & 0x80) i += der[1]! & 0x7f;
  const read = (): Uint8Array => {
    const len = der[i + 1]!;
    let v = der.slice(i + 2, i + 2 + len);
    i += 2 + len;
    while (v.length > size && v[0] === 0) v = v.slice(1);
    return concat(new Uint8Array(size - v.length), v);
  };
  return concat(read(), read());
}

export interface CreationOptions {
  rp: { id?: string; name?: string };
  user: { id: string; name?: string; displayName?: string };
  challenge: string;
  excludeCredentials?: Array<{ id: string }>;
  authenticatorSelection?: { userVerification?: string };
}
export interface RequestOptions {
  challenge: string;
  rpId?: string;
  allowCredentials?: Array<{ id: string }>;
  userVerification?: string;
}

export interface VirtualAuthenticatorOptions {
  /** The origin it claims in `clientDataJSON`. */
  origin?: string;
  /** Whether the simulated user verifies (UV flag). Default true. */
  userVerified?: boolean;
  /** Reported in the attestation. Default all zero. */
  aaguid?: Uint8Array;
}

interface Stored {
  id: Uint8Array;
  rpId: string;
  userHandle: string;
  privateKey: CryptoKey;
  counter: number;
}

export class VirtualAuthenticator {
  private credentials: Stored[] = [];
  userVerified: boolean;
  /** Set to make the next assertions report a counter that does not advance (a cloned authenticator). */
  frozenCounter = false;
  readonly origin: string;
  private readonly aaguid: Uint8Array;

  constructor(options: VirtualAuthenticatorOptions = {}) {
    this.origin = options.origin ?? 'https://localhost';
    this.userVerified = options.userVerified ?? true;
    this.aaguid = options.aaguid ?? new Uint8Array(16);
  }

  get credentialIds(): string[] {
    return this.credentials.map((c) => bytesToB64url(c.id));
  }

  private flags(attested: boolean): number {
    return 0x01 | (this.userVerified ? 0x04 : 0) | (attested ? 0x40 : 0);
  }

  /** `navigator.credentials.create` for a registration `options` object (as returned by `registration/init`). */
  async create(options: CreationOptions): Promise<{ credential_id: string; attestation_object: string; client_data_json: string; transports: string[] }> {
    const rpId = options.rp.id ?? new URL(this.origin).hostname;
    if (options.excludeCredentials?.some((c) => this.credentials.some((m) => bytesToB64url(m.id) === c.id))) throw new Error('InvalidStateError: a credential for this account already exists on this authenticator.');
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const id = crypto.getRandomValues(new Uint8Array(32));
    const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<string, string>;
    const cose = cborEncode(new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, unb64url(jwk.x!)], [-3, unb64url(jwk.y!)]]));
    const attested = concat(this.aaguid, Uint8Array.of(id.length >> 8, id.length & 255), id, cose);
    const authData = concat(await sha256(rpId), Uint8Array.of(this.flags(true)), new Uint8Array(4), attested);
    this.credentials.push({ id, rpId, userHandle: options.user.id, privateKey: pair.privateKey, counter: 0 });
    const clientData = JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.origin, crossOrigin: false });
    return {
      credential_id: bytesToB64url(id),
      attestation_object: bytesToB64url(cborEncode(new Map<string, any>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))),
      client_data_json: bytesToB64url(enc.encode(clientData)),
      transports: ['internal'],
    };
  }

  /** `navigator.credentials.get` for an authentication `options` object. */
  async get(options: RequestOptions): Promise<{ credential_id: string; authenticator_data: string; client_data_json: string; signature: string; user_handle: string }> {
    const rpId = options.rpId ?? new URL(this.origin).hostname;
    const allowed = options.allowCredentials?.map((c) => c.id);
    const cred = this.credentials.find((c) => c.rpId === rpId && (!allowed?.length || allowed.includes(bytesToB64url(c.id))));
    if (!cred) throw new Error('NotAllowedError: no matching credential on this authenticator.');
    if (!this.frozenCounter) cred.counter += 1;
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, cred.counter);
    const authData = concat(await sha256(rpId), Uint8Array.of(this.flags(false)), counter);
    const clientDataJSON = enc.encode(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cred.privateKey, signed as BufferSource));
    return { credential_id: bytesToB64url(cred.id), authenticator_data: bytesToB64url(authData), client_data_json: bytesToB64url(clientDataJSON), signature: bytesToB64url(rawToDer(raw)), user_handle: cred.userHandle };
  }
}

export const createVirtualAuthenticator = (options?: VirtualAuthenticatorOptions): VirtualAuthenticator => new VirtualAuthenticator(options);

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { MIGRATION_BUNDLE_FORMAT, MIGRATION_BUNDLE_VERSION, type MigrationEntry } from './schema';

/**
 * Transport encryption for a migration bundle: an ECIES-style seal to the Atlas
 * instance's import key, so the plaintext (which holds password hashes and
 * two-factor secrets) exists only in memory — on disk and in transit it is
 * ciphertext.
 *
 *   ephemeral X25519 key pair (fresh per bundle)
 *   shared  = X25519(ephemeral private, instance import public key)
 *   key     = HKDF-SHA256(shared, salt = epk || recipient pk, info, 32 bytes)
 *   chunk i = AES-256-GCM(key, nonce = prefix(7) || u32be(i) || final(1), aad = header)
 *
 * File layout (UTF-8 text, one item per line):
 *   line 1      the header, JSON: format, version, alg, kid, epk, nonce prefix
 *   line 2..n   base64url(ciphertext || tag) of each chunk, in order
 * Each chunk's plaintext is a run of whole NDJSON entries. The nonce binds every
 * chunk to its position and the last one carries the final flag, so a bundle that
 * was reordered, truncated or extended does not open (the STREAM construction).
 * Binding the header as AAD stops a swapped key id or ephemeral key.
 *
 * The construction is shared by every bundle format through a
 * {@link BundleProfile}: the vendor-neutral migration bundle
 * ({@link MIGRATION_PROFILE}) and the Better Auth bundle each have their own
 * format id and HKDF info, so a bundle of one kind never opens as the other.
 */

export const TRANSPORT_ALG = 'X25519-HKDF-SHA256-A256GCM';
/** Plaintext bytes per sealed chunk (a chunk always ends on an entry boundary). */
export const CHUNK_TARGET_BYTES = 256 * 1024;

/** What distinguishes one bundle format from another on the wire. */
export interface BundleProfile<E> {
  /** The header's `format`. */
  format: string;
  /** The header's `v`; a reader refuses any other. */
  version: number;
  /** HKDF info string (domain separation between formats). */
  hkdfInfo: string;
  /** Human name used in error messages ("Atlas migration bundle"). */
  label: string;
  /** Turn one decoded JSON entry into a typed entry, or throw a {@link BundleError}. */
  parseEntry(entry: Record<string, unknown>): E;
}

export interface BundleHeader {
  format: string;
  v: number;
  alg: typeof TRANSPORT_ALG;
  /** The Atlas import key this bundle is sealed to. */
  kid: string;
  /** base64url raw X25519 ephemeral public key. */
  epk: string;
  /** base64url 7-byte nonce prefix. */
  np: string;
}

export class BundleError extends Error {
  constructor(
    readonly code: 'bundle_malformed' | 'bundle_unsupported' | 'bundle_wrong_key' | 'bundle_tampered' | 'bundle_truncated',
    message: string,
  ) {
    super(message);
    this.name = 'BundleError';
  }
}

/**
 * The vendor-neutral migration bundle. A record may name a model this reader
 * does not know (a newer exporter): it is passed through, and the importer
 * skips it with a reason instead of refusing the bundle.
 */
export const MIGRATION_PROFILE: BundleProfile<MigrationEntry> = {
  format: MIGRATION_BUNDLE_FORMAT,
  version: MIGRATION_BUNDLE_VERSION,
  hkdfInfo: 'atlas migration bundle v1',
  label: 'Atlas migration bundle',
  parseEntry(e) {
    if (e.type === 'record') {
      if (typeof e.model !== 'string' || !e.model || !e.data || typeof e.data !== 'object' || Array.isArray(e.data)) {
        throw new BundleError('bundle_malformed', 'A record in the bundle has no model or no data.');
      }
      return e as unknown as MigrationEntry;
    }
    if (e.type === 'manifest') {
      if (e.format !== MIGRATION_BUNDLE_FORMAT || typeof e.source !== 'string') {
        throw new BundleError('bundle_malformed', 'The bundle manifest is malformed.');
      }
      return e as unknown as MigrationEntry;
    }
    if (e.type === 'end') return e as unknown as MigrationEntry;
    throw new BundleError('bundle_malformed', `Unknown bundle entry type ${String(e.type)}.`);
  },
};

/** An Atlas import public key: its id and the base64url raw X25519 public key. */
export interface ImportPublicKey {
  kid: string;
  publicKey: string;
}

/**
 * Parse an import key in any of the shapes Atlas hands out: the API object
 * (`{ kid, public_key }`), `{ kid, publicKey }`, or the compact `kid:publicKey`
 * string the dashboard and CLI print.
 */
export function parseImportPublicKey(input: unknown): ImportPublicKey {
  if (typeof input === 'string') {
    const i = input.lastIndexOf(':');
    if (i <= 0) throw new Error('An import key string looks like "<kid>:<public key>".');
    return parseImportPublicKey({ kid: input.slice(0, i).trim(), publicKey: input.slice(i + 1).trim() });
  }
  if (!input || typeof input !== 'object') throw new Error('An import public key is required.');
  const o = input as Record<string, unknown>;
  const kid = typeof o.kid === 'string' ? o.kid.trim() : '';
  const pk = typeof o.publicKey === 'string' ? o.publicKey : typeof o.public_key === 'string' ? o.public_key : '';
  if (!kid) throw new Error('The import key has no kid.');
  const raw = Buffer.from(pk.trim(), 'base64url');
  if (raw.length !== 32) throw new Error('The import public key must be a 32-byte X25519 key (base64url).');
  return { kid, publicKey: raw.toString('base64url') };
}

function x25519Public(raw: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw }, format: 'jwk' });
}

function rawPublic(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('Not an X25519 public key.');
  return Buffer.from(jwk.x, 'base64url');
}

function deriveKey(shared: Buffer, epk: Buffer, recipient: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epk, recipient]), Buffer.from(info, 'utf8'), 32));
}

function nonceFor(prefix: Buffer, index: number, final: boolean): Buffer {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new Error('Too many chunks.');
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(index, 7);
  n[11] = final ? 1 : 0;
  return n;
}

/** A fresh import key pair — what an Atlas instance creates and keeps. */
export function generateImportKeyPair(): { publicKey: string; privateKeyJwk: { kty: string; crv: string; x: string; d: string } } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string; d: string };
  return { publicKey: rawPublic(publicKey).toString('base64url'), privateKeyJwk: jwk };
}

/**
 * Seals NDJSON entries to an import key, one line at a time. Call {@link add} per
 * entry and {@link finish} once; every produced line goes to `write`.
 */
export class BundleSealer<E = MigrationEntry> {
  readonly header: BundleHeader;
  private readonly headerLine: string;
  private readonly key: Buffer;
  private readonly prefix: Buffer;
  private index = 0;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private started = false;
  private finished = false;
  private readonly chunkBytes: number;

  constructor(
    recipient: ImportPublicKey,
    private readonly write: (line: string) => void | Promise<void>,
    options: { profile?: BundleProfile<E>; chunkBytes?: number } = {},
  ) {
    const profile = (options.profile ?? MIGRATION_PROFILE) as BundleProfile<E>;
    this.chunkBytes = options.chunkBytes ?? CHUNK_TARGET_BYTES;
    const parsed = parseImportPublicKey(recipient);
    const recipientRaw = Buffer.from(parsed.publicKey, 'base64url');
    const eph = generateKeyPairSync('x25519');
    const epk = rawPublic(eph.publicKey);
    const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: x25519Public(parsed.publicKey) });
    this.key = deriveKey(shared, epk, recipientRaw, profile.hkdfInfo);
    this.prefix = randomBytes(7);
    this.header = {
      format: profile.format,
      v: profile.version,
      alg: TRANSPORT_ALG,
      kid: parsed.kid,
      epk: epk.toString('base64url'),
      np: this.prefix.toString('base64url'),
    };
    this.headerLine = JSON.stringify(this.header);
  }

  private async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.write(this.headerLine);
  }

  private seal(final: boolean): string {
    const plaintext = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    const cipher = createCipheriv('aes-256-gcm', this.key, nonceFor(this.prefix, this.index, final));
    cipher.setAAD(Buffer.from(this.headerLine, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    this.index += 1;
    return body.toString('base64url');
  }

  async add(entry: E): Promise<void> {
    if (this.finished) throw new Error('The bundle is already finished.');
    await this.start();
    const line = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8');
    if (this.pendingBytes > 0 && this.pendingBytes + line.length > this.chunkBytes) {
      await this.write(this.seal(false));
    }
    this.pending.push(line);
    this.pendingBytes += line.length;
  }

  /** Seal the last chunk with the final flag. Returns how many chunks were written. */
  async finish(): Promise<number> {
    if (this.finished) return this.index;
    await this.start();
    this.finished = true;
    await this.write(this.seal(true));
    return this.index;
  }
}

/** Read a header line's `format` without checking anything else (routing a bundle to its reader). */
export function peekBundleFormat(line: string): string | null {
  try {
    const h = JSON.parse(line) as { format?: unknown };
    return typeof h.format === 'string' ? h.format : null;
  } catch {
    return null;
  }
}

/** Read and check a bundle's header line without decrypting anything. */
export function parseBundleHeader<E>(line: string, profile: BundleProfile<E> = MIGRATION_PROFILE as unknown as BundleProfile<E>): BundleHeader {
  let h: Partial<BundleHeader>;
  try {
    h = JSON.parse(line) as Partial<BundleHeader>;
  } catch {
    throw new BundleError('bundle_malformed', 'The first line of the bundle is not a bundle header.');
  }
  if (h.format !== profile.format) throw new BundleError('bundle_malformed', `This file is not an ${profile.label}.`);
  if (h.v !== profile.version) {
    throw new BundleError('bundle_unsupported', `Bundle format version ${String(h.v)} is not supported (expected ${profile.version}).`);
  }
  if (h.alg !== TRANSPORT_ALG) throw new BundleError('bundle_unsupported', `Unsupported bundle encryption ${String(h.alg)}.`);
  if (typeof h.kid !== 'string' || !h.kid) throw new BundleError('bundle_malformed', 'The bundle header names no import key.');
  const epk = Buffer.from(String(h.epk ?? ''), 'base64url');
  const np = Buffer.from(String(h.np ?? ''), 'base64url');
  if (epk.length !== 32 || np.length !== 7) throw new BundleError('bundle_malformed', 'The bundle header is malformed.');
  return h as BundleHeader;
}

/** The private half of an import key, as Atlas stores it (an X25519 JWK). */
export type ImportPrivateKey = KeyObject | { kty: string; crv: string; x: string; d: string };

/**
 * Opens a sealed bundle line by line. Feed every line (header first) to
 * {@link push}; it returns the entries decoded from that line. Call
 * {@link end} after the last line: it throws unless the final chunk was seen.
 */
export class BundleOpener<E = MigrationEntry> {
  private header: BundleHeader | null = null;
  private headerLine = '';
  private key: Buffer | null = null;
  private prefix: Buffer | null = null;
  private index = 0;
  private sawFinal = false;
  private carry = '';
  private readonly profile: BundleProfile<E>;

  constructor(
    private readonly privateKey: ImportPrivateKey,
    profile?: BundleProfile<E>,
  ) {
    this.profile = (profile ?? MIGRATION_PROFILE) as BundleProfile<E>;
  }

  get kid(): string | null {
    return this.header?.kid ?? null;
  }

  get chunks(): number {
    return this.index;
  }

  push(rawLine: string): E[] {
    const line = rawLine.trim();
    if (!line) return [];
    if (!this.header) {
      this.header = parseBundleHeader(line, this.profile);
      this.headerLine = line;
      const priv = 'export' in this.privateKey ? (this.privateKey as KeyObject) : createPrivateKey({ key: this.privateKey, format: 'jwk' });
      const recipientRaw = rawPublic(createPublicKey(priv));
      const epk = Buffer.from(this.header.epk, 'base64url');
      let shared: Buffer;
      try {
        shared = diffieHellman({ privateKey: priv, publicKey: x25519Public(this.header.epk) });
      } catch {
        throw new BundleError('bundle_malformed', 'The bundle header carries an invalid ephemeral key.');
      }
      this.key = deriveKey(shared, epk, recipientRaw, this.profile.hkdfInfo);
      this.prefix = Buffer.from(this.header.np, 'base64url');
      return [];
    }
    if (this.sawFinal) throw new BundleError('bundle_tampered', 'The bundle has data after its final chunk.');
    const sealed = Buffer.from(line, 'base64url');
    if (sealed.length < 16) throw new BundleError('bundle_malformed', `Chunk ${this.index + 1} is malformed.`);
    const body = sealed.subarray(0, sealed.length - 16);
    const tag = sealed.subarray(sealed.length - 16);
    const attempt = (final: boolean): Buffer | null => {
      try {
        const d = createDecipheriv('aes-256-gcm', this.key!, nonceFor(this.prefix!, this.index, final));
        d.setAAD(Buffer.from(this.headerLine, 'utf8'));
        d.setAuthTag(tag);
        return Buffer.concat([d.update(body), d.final()]);
      } catch {
        return null;
      }
    };
    let plain = attempt(false);
    let final = false;
    if (!plain) {
      plain = attempt(true);
      final = true;
    }
    if (!plain) {
      throw new BundleError(
        this.index === 0 ? 'bundle_wrong_key' : 'bundle_tampered',
        this.index === 0
          ? "The bundle does not open with this instance's import key. Export again with this instance's current public key."
          : `Chunk ${this.index + 1} failed its integrity check (the bundle was modified or reordered).`,
      );
    }
    this.index += 1;
    if (final) this.sawFinal = true;
    const text = this.carry + plain.toString('utf8');
    const parts = text.split('\n');
    this.carry = parts.pop() ?? '';
    if (final && this.carry.trim()) {
      parts.push(this.carry);
      this.carry = '';
    }
    const out: E[] = [];
    for (const p of parts) {
      if (!p.trim()) continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(p) as Record<string, unknown>;
      } catch {
        throw new BundleError('bundle_malformed', 'An entry inside the bundle is not valid JSON.');
      }
      out.push(this.profile.parseEntry(e));
    }
    return out;
  }

  end(): void {
    if (!this.header) throw new BundleError('bundle_malformed', 'The bundle is empty.');
    if (!this.sawFinal) throw new BundleError('bundle_truncated', 'The bundle is incomplete: its final chunk is missing. Upload every part.');
  }
}

/**
 * Split text into lines across arbitrary part boundaries. Feed parts in order;
 * complete lines come out, a trailing partial line is held for the next part.
 */
export class LineSplitter {
  private carry = '';
  push(text: string): string[] {
    const all = this.carry + text;
    const lines = all.split('\n');
    this.carry = lines.pop() ?? '';
    return lines;
  }
  flush(): string[] {
    const rest = this.carry;
    this.carry = '';
    return rest.trim() ? [rest] : [];
  }
}

/** Decrypt a whole bundle held in memory (tests, small bundles). */
export function openBundleText<E = MigrationEntry>(text: string, privateKey: ImportPrivateKey, profile?: BundleProfile<E>): E[] {
  const opener = new BundleOpener<E>(privateKey, profile);
  const out: E[] = [];
  for (const line of text.split('\n')) out.push(...opener.push(line));
  opener.end();
  return out;
}

/**
 * L5 transparency ledger (Deep Dive II): a per-principal append-only Merkle log, Certificate-
 * Transparency lineage (RFC 6962 tree shape, RFC 9162 consistency verification).
 *
 * Entries are SALTED COMMITMENTS: commit = hashCanonical({ salt, pcactn_digest }). The Merkle leaf
 * is the commit string alone, so the tree (and every inclusion / consistency proof) is independent
 * of the opening. `shred(i)` drops the opening (salt + PCActn) but keeps the commit: the content is
 * cryptographically unrecoverable (GDPR erasure) while the log stays tamper-evident.
 *
 * Pure and deterministic given explicit salts; the default salt is 16 random bytes.
 */
import { randomBytes } from '@noble/hashes/utils';
import { b64u, canonicalBytes, hashCanonical, sha256, unb64u, utf8 } from './hash';
import { publicKeyOf, sign, verifyB64u } from './keys';
import { type InclusionProof, leafHash, merkleProof, verifyInclusion as verifyMerkleInclusion } from './merkle';
import { type PCActn, pcactnDigest } from './pcactn';

const NODE = 0x01;

function nodeHash(l: Uint8Array, r: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + l.length + r.length);
  out[0] = NODE;
  out.set(l, 1);
  out.set(r, 1 + l.length);
  return sha256(out);
}

function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** RFC 6962 MTH over precomputed leaf hashes; empty tree = SHA-256(""). */
function mth(hs: Uint8Array[]): Uint8Array {
  if (hs.length === 0) return sha256(new Uint8Array(0));
  if (hs.length === 1) return hs[0]!;
  const k = split(hs.length);
  return nodeHash(mth(hs.slice(0, k)), mth(hs.slice(k)));
}

export interface LedgerOpening {
  salt: string;
  pcactn: PCActn;
}
export interface LedgerEntry {
  commit: string;
  opening?: LedgerOpening;
}
export interface LedgerHead {
  size: number;
  root: string;
}
export interface ConsistencyProof {
  oldSize: number;
  newSize: number;
  path: string[];
}
export interface WitnessedHead {
  principal: string;
  size: number;
  root: string;
  /** Witness / guardian public key (b64u). */
  witness: string;
  sig: string;
}

/** The salted commitment of a PCActn. */
export function entryCommit(salt: string, pcactn: PCActn): string {
  return hashCanonical({ salt, pcactn_digest: pcactnDigest(pcactn) });
}

/** True when the opening reproduces the commit. */
export function verifyOpening(commit: string, opening: LedgerOpening): boolean {
  try {
    return entryCommit(opening.salt, opening.pcactn) === commit;
  } catch {
    return false;
  }
}

/** Root of an arbitrary commit sequence (empty log = SHA-256("")). */
export function ledgerRootOf(commits: string[]): string {
  return b64u(mth(commits.map(leafHash)));
}

export function verifyLedgerInclusion(root: string, proof: InclusionProof, commit: string): boolean {
  return verifyMerkleInclusion(root, proof, commit);
}

/** RFC 9162 §2.1.4.2 consistency verification. Never throws. */
export function verifyLedgerConsistency(oldRoot: string, newRoot: string, proof: ConsistencyProof): boolean {
  try {
    const first = proof.oldSize;
    const second = proof.newSize;
    if (!Number.isInteger(first) || !Number.isInteger(second) || first < 0 || first > second) return false;
    if (!Array.isArray(proof.path)) return false;
    if (first === 0) return proof.path.length === 0; // the empty log is a prefix of everything
    if (first === second) return proof.path.length === 0 && oldRoot === newRoot;
    const path = proof.path.map(unb64u);
    if ((first & (first - 1)) === 0) path.unshift(unb64u(oldRoot));
    if (path.length === 0) return false;
    let fn = first - 1;
    let sn = second - 1;
    while (fn & 1) {
      fn >>= 1;
      sn >>= 1;
    }
    let fr = path[0]!;
    let sr = path[0]!;
    for (const c of path.slice(1)) {
      if (sn === 0) return false;
      if (fn & 1 || fn === sn) {
        fr = nodeHash(c, fr);
        sr = nodeHash(c, sr);
        while (!(fn & 1) && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      } else {
        sr = nodeHash(sr, c);
      }
      fn >>= 1;
      sn >>= 1;
    }
    return sn === 0 && b64u(fr) === oldRoot && b64u(sr) === newRoot;
  } catch {
    return false;
  }
}

const WITNESS_DOMAIN = 'atlas-pca/ledger-head/v1\0';

function headMessage(principal: string, size: number, root: string): Uint8Array {
  const body = canonicalBytes({ principal, size, root });
  const p = utf8(WITNESS_DOMAIN);
  const m = new Uint8Array(p.length + body.length);
  m.set(p);
  m.set(body, p.length);
  return m;
}

/** Verify a (co-)signed head against the witness' public key (b64u). */
export function verifyWitnessedHead(wh: WitnessedHead, witnessPublic: string): boolean {
  return wh.witness === witnessPublic && verifyB64u(witnessPublic, headMessage(wh.principal, wh.size, wh.root), wh.sig);
}

/**
 * Split-view detection: two validly witnessed heads from the same witness for the same principal
 * and size but different roots prove equivocation. (Cross-size inconsistency is detected with
 * verifyLedgerConsistency.)
 */
export function detectEquivocation(a: WitnessedHead, b: WitnessedHead, witnessPublic: string): boolean {
  return (
    verifyWitnessedHead(a, witnessPublic) &&
    verifyWitnessedHead(b, witnessPublic) &&
    a.principal === b.principal &&
    a.size === b.size &&
    a.root !== b.root
  );
}

export class TransparencyLedger {
  private readonly _entries: LedgerEntry[] = [];
  private _hashes: Uint8Array[] = [];

  constructor(readonly principal: string = '') {}

  /** Rebuild from stored entries (e.g. after persistence, or to model tampering). */
  static fromEntries(entries: LedgerEntry[], principal = ''): TransparencyLedger {
    const l = new TransparencyLedger(principal);
    for (const e of entries) {
      l._entries.push({ commit: e.commit, ...(e.opening ? { opening: e.opening } : {}) });
      l._hashes.push(leafHash(e.commit));
    }
    return l;
  }

  get size(): number {
    return this._entries.length;
  }

  /** Append a PCActn as a salted commitment. Pass `opts.salt` for deterministic output. */
  append(pcactn: PCActn, opts: { salt?: string } = {}): { index: number; commit: string } {
    const salt = opts.salt ?? b64u(randomBytes(16));
    const commit = entryCommit(salt, pcactn);
    const index = this._entries.length;
    this._entries.push({ commit, opening: { salt, pcactn } });
    this._hashes.push(leafHash(commit));
    return { index, commit };
  }

  head(): LedgerHead {
    return { size: this.size, root: b64u(mth(this._hashes)) };
  }

  /** Root the log had when it contained only the first `size` entries. */
  rootAt(size: number): string {
    if (!Number.isInteger(size) || size < 0 || size > this.size) throw new RangeError('rootAt: size out of range');
    return b64u(mth(this._hashes.slice(0, size)));
  }

  commits(): string[] {
    return this._entries.map((e) => e.commit);
  }

  entry(index: number): LedgerEntry {
    const e = this._entries[index];
    if (!e) throw new RangeError('entry: index out of range');
    return { commit: e.commit, ...(e.opening ? { opening: e.opening } : {}) };
  }

  /** Indices whose stored opening no longer matches its commit (storage tamper detection). */
  auditOpenings(): number[] {
    const bad: number[] = [];
    this._entries.forEach((e, i) => {
      if (e.opening && !verifyOpening(e.commit, e.opening)) bad.push(i);
    });
    return bad;
  }

  inclusionProof(index: number): InclusionProof {
    return merkleProof(this.commits(), index);
  }

  verifyInclusion(root: string, proof: InclusionProof, commit: string): boolean {
    return verifyLedgerInclusion(root, proof, commit);
  }

  /** RFC 6962 SUBPROOF(m, D[n], true). */
  consistencyProof(oldSize: number, newSize: number = this.size): ConsistencyProof {
    if (!Number.isInteger(oldSize) || !Number.isInteger(newSize) || oldSize < 0 || oldSize > newSize || newSize > this.size) {
      throw new RangeError('consistencyProof: invalid sizes');
    }
    const out: Uint8Array[] = [];
    const sub = (m: number, hs: Uint8Array[], b: boolean): void => {
      const n = hs.length;
      if (m === n) {
        if (!b) out.push(mth(hs));
        return;
      }
      const k = split(n);
      if (m <= k) {
        sub(m, hs.slice(0, k), b);
        out.push(mth(hs.slice(k)));
      } else {
        sub(m - k, hs.slice(k), false);
        out.push(mth(hs.slice(0, k)));
      }
    };
    if (oldSize > 0 && oldSize < newSize) sub(oldSize, this._hashes.slice(0, newSize), true);
    return { oldSize, newSize, path: out.map(b64u) };
  }

  verifyConsistency(oldRoot: string, newRoot: string, proof: ConsistencyProof): boolean {
    return verifyLedgerConsistency(oldRoot, newRoot, proof);
  }

  /**
   * Crypto-shred: destroy the opening (salt + PCActn), keep the commit. The leaf, the root and every
   * inclusion/consistency proof are unchanged. Returns whether an opening was actually removed.
   */
  shred(index: number): boolean {
    const e = this._entries[index];
    if (!e) throw new RangeError('shred: index out of range');
    const had = e.opening !== undefined;
    delete e.opening;
    return had;
  }

  /** Sign the current head for third-party witnessing / anti-equivocation (co-sign hook). */
  witnessHead(guardianSecret: Uint8Array): WitnessedHead {
    const { size, root } = this.head();
    const sig = sign(guardianSecret, headMessage(this.principal, size, root));
    return { principal: this.principal, size, root, witness: b64u(publicKeyOf(guardianSecret)), sig: b64u(sig) };
  }
}

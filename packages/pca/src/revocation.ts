/**
 * L5 revocation "accumulator" — v0 as a SORTED MERKLE SET (deterministic, pure, no RSA modulus).
 *
 * Leaves are the revoked ids in ascending (UTF-16 code-unit) order, in an RFC-6962-shaped Merkle
 * tree. The published root also binds the set size: root = H("pca-revset/v1" || size || treeRoot).
 *
 * Membership: an ordinary inclusion proof.
 *
 * Non-membership (offline-verifiable): because leaves are sorted, an id X is absent iff two
 * ADJACENT leaves lo < X < hi exist (both proven included, at consecutive indices), or X is below
 * the first leaf (proof: leaf 0), above the last (proof: leaf size-1), or the set is empty. Leaf
 * positions are verified from the proof path shape (index + size are bound by the root), so a
 * prover cannot pass off non-adjacent leaves as neighbours. A revoked id has no bracketing pair,
 * hence no valid non-membership proof.
 *
 * Freshness caveat: a proof is against a specific root. Verifiers must obtain the current root from
 * a trusted, fresh source (guardian-signed / witnessed epoch root); a stale root can't show later
 * revocations.
 */
import { b64u, canonicalBytes, sha256, unb64u, utf8 } from './hash';
import { type InclusionProof, leafHash, merkleProof, merkleRoot } from './merkle';
import { type RevocationChecker, type VerifyContext } from './pcactn';

const NODE = 0x01;

function nodeHash(l: Uint8Array, r: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + l.length + r.length);
  out[0] = NODE;
  out.set(l, 1);
  out.set(r, 1 + l.length);
  return sha256(out);
}

function bindRoot(size: number, treeRoot: string): string {
  const prefix = utf8('pca-revset/v1\0');
  const tail = canonicalBytes({ size, tree: treeRoot });
  const m = new Uint8Array(prefix.length + tail.length);
  m.set(prefix);
  m.set(tail, prefix.length);
  return b64u(sha256(m));
}

const EMPTY_TREE = b64u(sha256(new Uint8Array(0)));

function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** Expected sibling sides (leaf-to-root order) for `index` in a tree of `size` leaves. */
function expectedSides(index: number, size: number): ('L' | 'R')[] {
  const out: ('L' | 'R')[] = [];
  const go = (i: number, n: number): void => {
    if (n === 1) return;
    const k = split(n);
    if (i < k) {
      go(i, k);
      out.push('R');
    } else {
      go(i - k, n - k);
      out.push('L');
    }
  };
  go(index, size);
  return out;
}

export interface LeafProof {
  id: string;
  proof: InclusionProof;
}
export interface NonMembershipProof {
  size: number;
  lo?: LeafProof;
  hi?: LeafProof;
}

/** Check a leaf proof against the bound root, including that index/size are what the path says. */
function leafOk(root: string, size: number, id: string, proof: InclusionProof): boolean {
  try {
    if (!proof || proof.size !== size || !Number.isInteger(proof.index) || proof.index < 0 || proof.index >= size) return false;
    const sides = expectedSides(proof.index, size);
    if (!Array.isArray(proof.path) || proof.path.length !== sides.length) return false;
    let h = leafHash(id);
    for (let i = 0; i < sides.length; i++) {
      const step = proof.path[i]!;
      if (step.side !== sides[i]) return false;
      const sib = unb64u(step.hash);
      h = step.side === 'L' ? nodeHash(sib, h) : nodeHash(h, sib);
    }
    return bindRoot(size, b64u(h)) === root;
  } catch {
    return false;
  }
}

export class RevocationSet {
  private ids: string[] = [];

  constructor(initial: Iterable<string> = []) {
    for (const id of initial) this.revoke(id);
  }

  get size(): number {
    return this.ids.length;
  }

  /** Idempotent. Returns true when newly revoked. */
  revoke(id: string): boolean {
    if (typeof id !== 'string') throw new TypeError('revoke: id must be a string');
    let lo = 0;
    let hi = this.ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ids[mid]! < id) lo = mid + 1;
      else hi = mid;
    }
    if (this.ids[lo] === id) return false;
    this.ids.splice(lo, 0, id);
    return true;
  }

  has(id: string): boolean {
    return this.indexOf(id) >= 0;
  }

  private indexOf(id: string): number {
    let lo = 0;
    let hi = this.ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ids[mid]! < id) lo = mid + 1;
      else hi = mid;
    }
    return this.ids[lo] === id ? lo : -1;
  }

  /** Sorted revoked ids (copy). */
  list(): string[] {
    return [...this.ids];
  }

  get root(): string {
    return bindRoot(this.ids.length, this.ids.length === 0 ? EMPTY_TREE : merkleRoot(this.ids));
  }

  membershipProof(id: string): InclusionProof {
    const i = this.indexOf(id);
    if (i < 0) throw new Error('membershipProof: id is not revoked');
    return merkleProof(this.ids, i);
  }

  /** Throws when the id IS revoked (no such proof can exist). */
  nonMembershipProof(id: string): NonMembershipProof {
    if (this.has(id)) throw new Error('nonMembershipProof: id is revoked');
    const n = this.ids.length;
    // first index whose leaf is > id
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ids[mid]! < id) lo = mid + 1;
      else hi = mid;
    }
    const leaf = (i: number): LeafProof => ({ id: this.ids[i]!, proof: merkleProof(this.ids, i) });
    const p: NonMembershipProof = { size: n };
    if (lo > 0) p.lo = leaf(lo - 1);
    if (lo < n) p.hi = leaf(lo);
    return p;
  }
}

/** Verify id IS in the set (inclusion against the size-bound root). */
export function verifyMembership(root: string, proof: InclusionProof, id: string): boolean {
  return !!proof && leafOk(root, proof.size, id, proof);
}

/** Verify id is NOT in the set the root commits to. */
export function verifyNonMembership(root: string, proof: NonMembershipProof, id: string): boolean {
  try {
    if (!proof || !Number.isInteger(proof.size) || proof.size < 0) return false;
    const { size, lo, hi } = proof;
    if (size === 0) return !lo && !hi && root === bindRoot(0, EMPTY_TREE);
    if (!lo && !hi) return false;
    if (lo) {
      if (!(lo.id < id) || !leafOk(root, size, lo.id, lo.proof)) return false;
      if (!hi && lo.proof.index !== size - 1) return false; // id above the maximum
    }
    if (hi) {
      if (!(id < hi.id) || !leafOk(root, size, hi.id, hi.proof)) return false;
      if (!lo && hi.proof.index !== 0) return false; // id below the minimum
    }
    if (lo && hi && hi.proof.index !== lo.proof.index + 1) return false;
    return true;
  } catch {
    return false;
  }
}

export interface RevocationCheckerOptions {
  /** Trusted current revocation root for this verification (e.g. guardian-signed epoch root). */
  root: (ctx: VerifyContext) => string | undefined;
  /** Supply the non-membership proof for a capability id (offline: carried with the action). */
  proofFor: (id: string, ctx: VerifyContext) => NonMembershipProof | undefined;
  /** Which capability ids to check. Default: every `id` in the PCActn's cap_chain (a revoked
   * ancestor kills its descendants). */
  ids?: (ctx: VerifyContext) => string[];
}

/**
 * RevocationChecker hook (pcactn.ts) backed by non-membership proofs. Fails closed: a missing
 * root, a missing proof, or a revoked id (which has no valid proof) all reject.
 */
export function createRevocationChecker(opts: RevocationCheckerOptions): RevocationChecker {
  return (ctx) => {
    const root = opts.root(ctx);
    if (!root) return { enforced: true, ok: false, reason: 'no revocation root' };
    const ids = opts.ids ? opts.ids(ctx) : ctx.pcactn.cap_chain.map((c) => c.id);
    for (const id of ids) {
      const proof = opts.proofFor(id, ctx);
      if (!proof) return { enforced: true, ok: false, reason: `no non-membership proof for ${id}` };
      if (!verifyNonMembership(root, proof, id)) {
        return { enforced: true, ok: false, reason: `capability ${id} is revoked or proof invalid` };
      }
    }
    return { enforced: true, ok: true };
  };
}

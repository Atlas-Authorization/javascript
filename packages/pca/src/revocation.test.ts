import { describe, expect, it } from 'vitest';
import { attenuate, mintRoot } from './capability';
import { encodeKey, generateKeyPair } from './keys';
import { type PCActn, type VerifyContext } from './pcactn';
import { RevocationSet, createRevocationChecker, verifyMembership, verifyNonMembership } from './revocation';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `cap-${String(i * 2).padStart(3, '0')}`); // even only

describe('revocation set', () => {
  it('is order-independent and idempotent', () => {
    const a = new RevocationSet(['b', 'a', 'c']);
    const b = new RevocationSet(['c', 'b', 'a', 'a']);
    expect(a.root).toBe(b.root);
    expect(b.size).toBe(3);
    expect(b.revoke('a')).toBe(false);
    const before = a.root;
    a.revoke('d');
    expect(a.root).not.toBe(before);
  });
  it('membership proofs verify for every size; wrong id / root fail', () => {
    for (let n = 1; n <= 12; n++) {
      const s = new RevocationSet(ids(n));
      for (const id of ids(n)) expect(verifyMembership(s.root, s.membershipProof(id), id)).toBe(true);
      expect(verifyMembership(s.root, s.membershipProof(ids(n)[0]!), 'cap-001')).toBe(false);
      expect(verifyMembership(new RevocationSet(['z']).root, s.membershipProof(ids(n)[0]!), ids(n)[0]!)).toBe(false);
    }
    expect(() => new RevocationSet().membershipProof('x')).toThrow();
  });
  it('non-revoked ids (below, between, above) have valid non-membership proofs', () => {
    for (let n = 1; n <= 12; n++) {
      const s = new RevocationSet(ids(n));
      const probes = ['a', ...ids(n).map((i) => i.replace('cap-', 'cap-') + 'x'), 'cap-001', 'zzz'];
      for (const x of probes) {
        const p = s.nonMembershipProof(x);
        expect(verifyNonMembership(s.root, p, x)).toBe(true);
      }
    }
  });
  it('a revoked id has no valid non-membership proof', () => {
    const s = new RevocationSet(ids(8));
    for (const id of ids(8)) {
      expect(() => s.nonMembershipProof(id)).toThrow();
      // reuse the proof of a neighbour: must fail
      const p = s.nonMembershipProof(id + 'x');
      expect(verifyNonMembership(s.root, p, id)).toBe(false);
    }
  });
  it('boundaries: empty, smallest, largest', () => {
    const e = new RevocationSet();
    expect(verifyNonMembership(e.root, e.nonMembershipProof('x'), 'x')).toBe(true);
    expect(verifyNonMembership(new RevocationSet(['a']).root, e.nonMembershipProof('x'), 'x')).toBe(false);
    const s = new RevocationSet(['m', 'p', 't']);
    const low = s.nonMembershipProof('a');
    expect(low.lo).toBeUndefined();
    expect(verifyNonMembership(s.root, low, 'a')).toBe(true);
    const high = s.nonMembershipProof('z');
    expect(high.hi).toBeUndefined();
    expect(verifyNonMembership(s.root, high, 'z')).toBe(true);
    // boundary proofs cannot be reused on the wrong side
    expect(verifyNonMembership(s.root, low, 'n')).toBe(false);
    expect(verifyNonMembership(s.root, high, 'n')).toBe(false);
    // empty-claim proof against a non-empty root
    expect(verifyNonMembership(s.root, { size: 0 }, 'a')).toBe(false);
    expect(verifyNonMembership(s.root, { size: 3 }, 'a')).toBe(false);
  });
  it('tampered / non-adjacent / stale proofs fail', () => {
    const s = new RevocationSet(['b', 'd', 'f', 'h']);
    const p = s.nonMembershipProof('e'); // d..f
    expect(verifyNonMembership(s.root, p, 'e')).toBe(true);
    // non-adjacent bracket: b..h around 'e'
    const wide = { size: 4, lo: { id: 'b', proof: s.membershipProof('b') }, hi: { id: 'h', proof: s.membershipProof('h') } };
    expect(verifyNonMembership(s.root, wide, 'e')).toBe(false);
    // swapped leaf id
    expect(verifyNonMembership(s.root, { ...p, lo: { ...p.lo!, id: 'c' } }, 'e')).toBe(false);
    // tampered path hash
    const t = structuredClone(p);
    t.hi!.proof.path[0]!.hash = t.lo!.proof.path[0]!.hash;
    expect(verifyNonMembership(s.root, t, 'e')).toBe(false);
    // lying about size / index
    expect(verifyNonMembership(s.root, { ...p, size: 5 }, 'e')).toBe(false);
    const idx = structuredClone(p);
    idx.lo!.proof.index = 0;
    expect(verifyNonMembership(s.root, idx, 'e')).toBe(false);
    // stale root (before later revocations) does not match the new proof
    const old = s.root;
    s.revoke('e');
    expect(verifyNonMembership(s.root, p, 'e')).toBe(false);
    expect(verifyNonMembership(old, p, 'e')).toBe(true); // valid against the old epoch only
    expect(verifyNonMembership(s.root, { size: 4 } as never, 'e')).toBe(false);
    expect(verifyNonMembership(s.root, null as never, 'e')).toBe(false);
  });
});

describe('revocation checker hook', () => {
  const P = generateKeyPair();
  const A = generateKeyPair();
  const grant = mintRoot({ principalSecret: P.secretKey, principalPublic: encodeKey(P.publicKey), holder: encodeKey(A.publicKey), caveats: [] });
  const child = attenuate(grant, [], A.secretKey);
  const ctx = { pcactn: { cap_chain: [grant, child] } as unknown as PCActn, grant } as VerifyContext;

  const make = (set: RevocationSet, root = set.root) =>
    createRevocationChecker({
      root: () => root,
      proofFor: (id) => (set.has(id) ? undefined : set.nonMembershipProof(id)),
    });

  it('passes when nothing in the chain is revoked', async () => {
    expect(await make(new RevocationSet(['other']))(ctx)).toEqual({ enforced: true, ok: true });
  });
  it('rejects when the leaf or an ancestor is revoked', async () => {
    const r1 = await make(new RevocationSet([child.id]))(ctx);
    expect(r1).toMatchObject({ enforced: true, ok: false });
    const r2 = await make(new RevocationSet([grant.id]))(ctx);
    expect(r2).toMatchObject({ enforced: true, ok: false });
  });
  it('fails closed on missing root, missing proof, or a forged proof', async () => {
    const s = new RevocationSet(['x']);
    expect(await createRevocationChecker({ root: () => undefined, proofFor: () => undefined })(ctx)).toMatchObject({ ok: false });
    expect(await createRevocationChecker({ root: () => s.root, proofFor: () => undefined })(ctx)).toMatchObject({ ok: false });
    const revoked = new RevocationSet([child.id]);
    const forged = createRevocationChecker({ root: () => revoked.root, proofFor: () => new RevocationSet(['x']).nonMembershipProof(child.id) });
    expect(await forged(ctx)).toMatchObject({ ok: false });
  });
  it('supports a custom ids selector (leaf only)', async () => {
    const set = new RevocationSet([grant.id]);
    const c = createRevocationChecker({ root: () => set.root, proofFor: (id) => (set.has(id) ? undefined : set.nonMembershipProof(id)), ids: () => [child.id] });
    expect(await c(ctx)).toEqual({ enforced: true, ok: true });
  });
});

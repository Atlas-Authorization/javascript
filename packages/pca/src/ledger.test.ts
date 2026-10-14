import { describe, expect, it } from 'vitest';
import { attenuate, mintRoot } from './capability';
import { encodeKey, generateKeyPair } from './keys';
import { commitPlan, conditionsDigest } from './merkle';
import { type PCActn, signPCActn } from './pcactn';
import {
  TransparencyLedger,
  detectEquivocation,
  entryCommit,
  verifyOpening,
  verifyWitnessedHead,
} from './ledger';

const S = generateKeyPair();
const P = generateKeyPair();
const grant = mintRoot({ principalSecret: P.secretKey, principalPublic: encodeKey(P.publicKey), holder: encodeKey(S.publicKey), caveats: [] });
const leaf = attenuate(grant, [], S.secretKey);
function act(n: number): PCActn {
  const plan = commitPlan([{ id: 'n', verb: 'read', resource: `r/${n}`, params_digest: 'p', reversibility_class: 'R0' }]);
  return signPCActn(
    {
      ver: 1,
      action: { verb: 'read', resource: `r/${n}`, params_digest: 'p', reversibility_class: 'R0' },
      grant_ref: 'g',
      cap_chain: [grant, leaf],
      plan: { root: plan.root, inclusion_proof: plan.proofFor('n'), node_id: 'n', conditions_digest: conditionsDigest(undefined, undefined) },
      attestation: { quote_digest: 'q', epoch: 1, model_id: 'm', measurement: 'x', operator: 'o' },
      provenance: { causal_hash: 'c', taint_level: 0, trusted_refs: [] },
      freshness: { beacon_ref: 'b', epoch: 1, accumulator_witness: 'w' },
      counter: n,
      risk_claim: { r: 0.1, inputs: {} },
    },
    S.secretKey,
  );
}
const fill = (n: number, l = new TransparencyLedger('p1')) => {
  for (let i = 0; i < n; i++) l.append(act(i), { salt: `s${i}` });
  return l;
};

describe('ledger', () => {
  it('is deterministic given salts; commit = H(salt, digest)', () => {
    expect(fill(5).head()).toEqual(fill(5).head());
    const l = fill(1);
    expect(l.entry(0).commit).toBe(entryCommit('s0', act(0)));
    expect(verifyOpening(l.entry(0).commit, l.entry(0).opening!)).toBe(true);
    expect(verifyOpening(l.entry(0).commit, { salt: 'x', pcactn: act(0) })).toBe(false);
  });
  it('random salts by default differ', () => {
    const l = new TransparencyLedger();
    expect(l.append(act(0)).commit).not.toBe(l.append(act(0)).commit);
  });
  it('empty head and append/inclusion for every size', () => {
    expect(new TransparencyLedger().head().size).toBe(0);
    for (let n = 1; n <= 13; n++) {
      const l = fill(n);
      const { root } = l.head();
      for (let i = 0; i < n; i++) {
        expect(l.verifyInclusion(root, l.inclusionProof(i), l.entry(i).commit)).toBe(true);
      }
      expect(l.verifyInclusion(root, l.inclusionProof(0), 'forged')).toBe(false);
    }
  });
  it('consistency proofs verify for all (old,new) pairs; forged fail', () => {
    const l = fill(14);
    for (let n = 0; n <= 14; n++) {
      for (let m = 0; m <= n; m++) {
        const p = l.consistencyProof(m, n);
        expect(l.verifyConsistency(l.rootAt(m), l.rootAt(n), p)).toBe(true);
      }
    }
    const p = l.consistencyProof(5, 12);
    expect(l.verifyConsistency(l.rootAt(5), l.rootAt(11), p)).toBe(false);
    expect(l.verifyConsistency(l.rootAt(4), l.rootAt(12), p)).toBe(false);
    expect(l.verifyConsistency(l.rootAt(5), l.rootAt(12), { ...p, path: [...p.path.slice(1)] })).toBe(false);
    const bad = { ...p, path: p.path.map((h, i) => (i === 0 ? l.rootAt(1) : h)) };
    expect(l.verifyConsistency(l.rootAt(5), l.rootAt(12), bad)).toBe(false);
  });
  it('a rewritten history is not consistent with the old head', () => {
    const honest = fill(8);
    const oldRoot = honest.rootAt(4);
    const forged = TransparencyLedger.fromEntries(honest.commits().map((c, i) => ({ commit: i === 2 ? 'evil' : c })));
    expect(forged.verifyConsistency(oldRoot, forged.head().root, forged.consistencyProof(4, 8))).toBe(false);
  });
  it('tampering an entry breaks the root and the stored opening audit', () => {
    const l = fill(6);
    const root = l.head().root;
    const entries = l.commits().map((commit, i) => ({ commit: i === 3 ? 'tampered' : commit }));
    expect(TransparencyLedger.fromEntries(entries).head().root).not.toBe(root);
    const t = TransparencyLedger.fromEntries(
      l.commits().map((_, i) => ({ commit: l.entry(i).commit, opening: i === 1 ? { salt: 'x', pcactn: act(1) } : l.entry(i).opening })),
    );
    expect(t.auditOpenings()).toEqual([1]);
    expect(t.head().root).toBe(root); // commits untouched
  });
  it('shred drops the opening but keeps every proof valid', () => {
    const l = fill(9);
    const before = l.head();
    const inc = l.inclusionProof(4);
    const cons = l.consistencyProof(3, 9);
    const commit = l.entry(4).commit;
    expect(l.shred(4)).toBe(true);
    expect(l.shred(4)).toBe(false);
    expect(l.entry(4).opening).toBeUndefined();
    expect(l.entry(4).commit).toBe(commit);
    expect(l.head()).toEqual(before);
    expect(l.verifyInclusion(before.root, inc, commit)).toBe(true);
    expect(l.verifyInclusion(before.root, l.inclusionProof(4), commit)).toBe(true);
    expect(l.verifyConsistency(l.rootAt(3), before.root, cons)).toBe(true);
    // growth after shredding stays consistent
    l.append(act(99));
    expect(l.verifyConsistency(before.root, l.head().root, l.consistencyProof(9, 10))).toBe(true);
    expect(l.auditOpenings()).toEqual([]);
  });
  it('witnessed heads verify, reject wrong key/tamper, and expose equivocation', () => {
    const W = generateKeyPair();
    const a = fill(4);
    const wh = a.witnessHead(W.secretKey);
    const pub = encodeKey(W.publicKey);
    expect(verifyWitnessedHead(wh, pub)).toBe(true);
    expect(verifyWitnessedHead(wh, encodeKey(generateKeyPair().publicKey))).toBe(false);
    expect(verifyWitnessedHead({ ...wh, size: 5 }, pub)).toBe(false);
    const fork = TransparencyLedger.fromEntries(a.commits().map((c, i) => ({ commit: i === 3 ? 'fork' : c })), 'p1');
    expect(detectEquivocation(wh, fork.witnessHead(W.secretKey), pub)).toBe(true);
    expect(detectEquivocation(wh, wh, pub)).toBe(false);
  });
  it('range errors', () => {
    const l = fill(3);
    expect(() => l.inclusionProof(3)).toThrow();
    expect(() => l.consistencyProof(4, 3)).toThrow();
    expect(() => l.shred(9)).toThrow();
  });
});

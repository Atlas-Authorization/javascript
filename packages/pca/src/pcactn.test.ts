import { describe, expect, it } from 'vitest';
import { attenuate, delegate, mintRoot } from './capability';
import { encodeKey, generateKeyPair } from './keys';
import { commitPlan, conditionsDigest } from './merkle';
import {
  type PCActn,
  decodePCActn,
  encodePCActn,
  pcactnDigest,
  signPCActn,
  verifyPCActnCore,
} from './pcactn';

function build() {
  const P = generateKeyPair();
  const A = generateKeyPair();
  const S = generateKeyPair();
  const grant = mintRoot({ principalSecret: P.secretKey, principalPublic: encodeKey(P.publicKey), holder: encodeKey(A.publicKey), caveats: [{ type: 'ttl', secs: 60 }] });
  const c1 = attenuate(grant, [{ type: 'x' }], A.secretKey);
  const sub = delegate(c1, encodeKey(S.publicKey), [], A.secretKey);
  const nodes = [
    { id: 'n1', verb: 'revoke_session', resource: 'sess/1', params_digest: 'pd1', reversibility_class: 'R1', pre: { a: 1 } },
    { id: 'n2', verb: 'read', resource: 'acct', params_digest: 'pd2', reversibility_class: 'R0' },
  ];
  const plan = commitPlan(nodes);
  const mk = (idx: 0 | 1): PCActn => {
    const n = nodes[idx]!;
    return signPCActn(
      {
        ver: 1,
        action: { verb: n.verb, resource: n.resource, params_digest: n.params_digest, reversibility_class: n.reversibility_class },
        grant_ref: 'g',
        cap_chain: [grant, c1, sub],
        plan: { root: plan.root, inclusion_proof: plan.proofFor(n.id), node_id: n.id, conditions_digest: conditionsDigest(n.pre, undefined) },
        attestation: { quote_digest: 'q', epoch: 1, model_id: 'm', measurement: 'x', operator: 'o' },
        provenance: { causal_hash: 'c', taint_level: 0, trusted_refs: [] },
        freshness: { beacon_ref: 'b', epoch: 1, accumulator_witness: 'w' },
        counter: 7,
        risk_claim: { r: 0.1, inputs: {} },
      },
      S.secretKey,
    );
  };
  return { grant, S, A, mk, nodes };
}

describe('verifyPCActnCore', () => {
  it('well-formed PCActn is allowed; later checks are not-enforced', async () => {
    const { grant, mk } = build();
    const r = await verifyPCActnCore(mk(0), { grant });
    expect(r.allow).toBe(true);
    expect(r.checks).toMatchObject({ cap_chain: 'pass', plan_inclusion: 'pass', leaf_signature: 'pass', counter: 'pass', attestation: 'not-enforced', threshold: 'not-enforced', revocation: 'not-enforced' });
  });
  it('tampered action breaks plan inclusion (and signature)', async () => {
    const { grant, mk } = build();
    const p = mk(0);
    p.action = { ...p.action, resource: 'sess/ALL' };
    const r = await verifyPCActnCore(p, { grant });
    expect(r.allow).toBe(false);
    expect(r.checks.plan_inclusion).toBe('fail');
    expect(r.checks.leaf_signature).toBe('fail');
  });
  it('out-of-plan action fails even when freshly signed', async () => {
    const { grant, mk, S } = build();
    const p = mk(0);
    const { sig: _s, ...body } = { ...p, action: { ...p.action, verb: 'wire_money' } };
    const r = await verifyPCActnCore(signPCActn(body, S.secretKey), { grant });
    expect(r.allow).toBe(false);
    expect(r.checks.plan_inclusion).toBe('fail');
    expect(r.checks.leaf_signature).toBe('pass');
  });
  it('wrong-key body signature fails', async () => {
    const { grant, mk } = build();
    const p = mk(1);
    const { sig: _s, ...body } = p;
    const r = await verifyPCActnCore(signPCActn(body, generateKeyPair().secretKey), { grant });
    expect(r.allow).toBe(false);
    expect(r.checks.leaf_signature).toBe('fail');
  });
  it('chain not rooted at the supplied grant fails', async () => {
    const { mk } = build();
    const other = build();
    const r = await verifyPCActnCore(mk(0), { grant: other.grant });
    expect(r.allow).toBe(false);
    expect(r.checks.cap_chain).toBe('fail');
  });
  it('bad counter fails; enforced hook can reject; malformed does not throw', async () => {
    const { grant, mk, S } = build();
    const { sig: _s, ...body } = mk(0);
    const bad = signPCActn({ ...body, counter: 'x' as unknown as number }, S.secretKey);
    expect((await verifyPCActnCore(bad, { grant })).checks.counter).toBe('fail');
    const r = await verifyPCActnCore(mk(0), { grant, hooks: { revocation: () => ({ enforced: true, ok: false, reason: 'revoked' }) } });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/revoked/);
    const m = await verifyPCActnCore({} as PCActn, { grant });
    expect(m.allow).toBe(false);
  });
  it('encode/decode roundtrip and digest stable', async () => {
    const { grant, mk } = build();
    const p = mk(0);
    const q = decodePCActn(encodePCActn(p));
    expect(pcactnDigest(q)).toBe(pcactnDigest(p));
    expect((await verifyPCActnCore(q, { grant })).allow).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  type ComplianceStatement,
  type SnarkBackend,
  actionCommitment,
  createAttestedComplianceProver,
  createZkVerifier,
  policyCommitment,
} from './zk';
import { mintGrant, readEnvelope } from './envelope';
import { buildPCActn, type PCActn } from './pcactn';
import { type DecideInput } from './policy-vm';
import { encodeKey, generateKeyPair } from './keys';
import { DEFAULT_RISK_POLICY, type TrustBudget } from './risk';
import type { Capability } from './capability';
import type { PlanNode } from './merkle';

const P = generateKeyPair();
const A = generateKeyPair();
const NOW = 1_000_000;
const fresh: TrustBudget = { B: 1, tau: NOW, asOf: NOW };

const GRANT: Capability = mintGrant({
  principalSecret: P.secretKey,
  principalPublic: encodeKey(P.publicKey),
  holder: encodeKey(A.publicKey),
  goal: 'secure my account',
  envelope: {
    predicates: [{ verb: 'revoke_session', resource: '/acct/*' }],
    caveats: [{ type: 'expires', at: 9e12 }],
    agent_binding: {},
    risk_policy: DEFAULT_RISK_POLICY,
  },
}).grant;

const NODES: PlanNode[] = [{ id: 'n1', verb: 'revoke_session', resource: '/acct/1/s', reversibility_class: 'reversible' }];

function actn(verb = 'revoke_session'): PCActn {
  const nodes: PlanNode[] = [{ id: 'n1', verb, resource: '/acct/1/s', reversibility_class: 'reversible' }];
  return buildPCActn({ grant: GRANT, chain: [GRANT], plan: nodes, nodeId: 'n1', counter: 1, signerSecret: A.secretKey });
}

function decideInputFor(p: PCActn): DecideInput {
  return {
    grant: GRANT,
    chain: [GRANT],
    action: { action: { verb: p.action.verb, resource: p.action.resource, params: {}, reversibility_class: p.action.reversibility_class } },
    plan: NODES,
    risk: { semanticDistance: 0, reversibility: 1, blastRadius: 0, taint: 0, confidence: 1, age: 0 },
    budget: fresh,
    now: NOW,
    nodeId: p.plan.node_id,
  };
}

function prove(p: PCActn, prover = createAttestedComplianceProver(generateKeyPair().secretKey)) {
  const statement = prover.prove({ pcactn: p, decideInput: decideInputFor(p), issued_at: NOW - 1000, expires_at: NOW + 60_000 });
  return { statement, prover };
}

describe('attested compliance prover / verifier (§9B)', () => {
  it('a valid attested-compliance statement verifies', async () => {
    const p = actn();
    const { statement, prover } = prove(p);
    p.zk_compliance = statement;
    const verify = createZkVerifier({ trustedProverKeys: [prover.publicKey], policyCommitments: [policyCommitment(GRANT)], now: () => NOW });
    expect(await verify({ pcactn: p, grant: GRANT })).toEqual({ enforced: true, ok: true });
  });

  it('the prover refuses to prove a non-compliant action', () => {
    const p = actn('exfiltrate'); // not permitted
    expect(() => prove(p)).toThrow(/not compliant/);
  });

  it('tampering the action breaks the commitment binding', async () => {
    const p = actn();
    const { statement, prover } = prove(p);
    p.zk_compliance = statement;
    p.action = { ...p.action, resource: '/acct/EVIL' }; // action no longer matches the proof's commitment
    const verify = createZkVerifier({ trustedProverKeys: [prover.publicKey], policyCommitments: [policyCommitment(GRANT)], now: () => NOW });
    const res = await verify({ pcactn: p, grant: GRANT });
    expect(res).toMatchObject({ enforced: true, ok: false });
    expect((res as { reason: string }).reason).toMatch(/does not bind to this action/);
  });

  it('tampering the statement breaks the signature', async () => {
    const p = actn();
    const { statement, prover } = prove(p);
    p.zk_compliance = { ...statement, r: 0.99 } as ComplianceStatement;
    const verify = createZkVerifier({ trustedProverKeys: [prover.publicKey], policyCommitments: [policyCommitment(GRANT)], now: () => NOW });
    const res = await verify({ pcactn: p, grant: GRANT });
    expect(res).toMatchObject({ enforced: true, ok: false });
    expect((res as { reason: string }).reason).toMatch(/signature does not verify/);
  });

  it('an untrusted prover key is rejected', async () => {
    const p = actn();
    const { statement } = prove(p);
    p.zk_compliance = statement;
    const verify = createZkVerifier({ trustedProverKeys: [createAttestedComplianceProver(generateKeyPair().secretKey).publicKey], policyCommitments: [policyCommitment(GRANT)], now: () => NOW });
    const res = await verify({ pcactn: p, grant: GRANT });
    expect(res).toMatchObject({ enforced: true, ok: false });
    expect((res as { reason: string }).reason).toMatch(/not trusted/);
  });

  it('an expired statement is rejected', async () => {
    const p = actn();
    const prover = createAttestedComplianceProver(generateKeyPair().secretKey);
    p.zk_compliance = prover.prove({ pcactn: p, decideInput: decideInputFor(p), issued_at: NOW - 10_000, expires_at: NOW - 5_000 });
    const verify = createZkVerifier({ trustedProverKeys: [prover.publicKey], policyCommitments: [policyCommitment(GRANT)], now: () => NOW });
    const res = await verify({ pcactn: p, grant: GRANT });
    expect(res).toMatchObject({ enforced: true, ok: false });
    expect((res as { reason: string }).reason).toMatch(/expired/);
  });

  it('PRIVACY: the verifier checks compliance without the plaintext policy or plan', async () => {
    const p = actn();
    const { statement, prover } = prove(p);
    p.zk_compliance = statement;

    // The RS is configured with ONLY the policy commitment (a bare hash) and the trusted prover key.
    // It is handed a grant object that carries NO envelope — it literally cannot read the policy.
    const blindGrant = {} as unknown as Capability;
    expect(readEnvelope(blindGrant)).toBeNull();

    const verify = createZkVerifier({
      trustedProverKeys: [prover.publicKey],
      policyCommitments: [policyCommitment(GRANT)], // just the hash; no predicates/caveats/plan in hand
      now: () => NOW,
    });
    // Verifies "authorized" using only commitments, with no access to P, Π or the reasoning.
    expect(await verify({ pcactn: p, grant: blindGrant })).toEqual({ enforced: true, ok: true });

    // And a statement that commits to a DIFFERENT policy is rejected (wrong policy commitment).
    const verifyWrong = createZkVerifier({ trustedProverKeys: [prover.publicKey], policyCommitments: ['some-other-policy-commit'], now: () => NOW });
    expect(await verifyWrong({ pcactn: p, grant: blindGrant })).toMatchObject({ enforced: true, ok: false });
  });

  it('SNARK seam: delegates to the backend with commitments as public inputs', async () => {
    const p = actn();
    const { statement } = prove(p);
    p.zk_compliance = statement; // in SNARK mode the proof would be a circuit proof; shape is opaque here
    let seen: { action_commit: string; policy_commit: string; plan_commit: string } | undefined;
    const backend: SnarkBackend = {
      verify: ({ publicInputs }) => {
        seen = publicInputs;
        return true;
      },
    };
    const verify = createZkVerifier({ trustedProverKeys: [], policyCommitments: [policyCommitment(GRANT)], snarkBackend: backend, now: () => NOW });
    expect(await verify({ pcactn: p, grant: GRANT })).toEqual({ enforced: true, ok: true });
    expect(seen).toEqual({ action_commit: actionCommitment(p), policy_commit: policyCommitment(GRANT), plan_commit: p.plan.root });

    // A rejecting backend fails the hook.
    const reject: SnarkBackend = { verify: () => false };
    const verify2 = createZkVerifier({ trustedProverKeys: [], policyCommitments: [policyCommitment(GRANT)], snarkBackend: reject, now: () => NOW });
    expect(await verify2({ pcactn: p, grant: GRANT })).toMatchObject({ enforced: true, ok: false });
  });

  it('no proof present is rejected', async () => {
    const p = actn();
    const verify = createZkVerifier({ trustedProverKeys: [], policyCommitments: [policyCommitment(GRANT)], now: () => NOW });
    const res = await verify({ pcactn: p, grant: GRANT });
    expect(res).toMatchObject({ enforced: true, ok: false });
    expect((res as { reason: string }).reason).toMatch(/no zk_compliance/);
  });
});

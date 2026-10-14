import { describe, expect, it } from 'vitest';
import {
  IRREVERSIBLE_CLASS,
  challengeWindowEnd,
  claimStatus,
  fileFraudProof,
  openOptimistic,
  verifyClaim,
  verifyFraudProof,
  withinChallengeWindow,
} from './optimistic';
import { mintGrant } from './envelope';
import { buildPCActn, type PCActn } from './pcactn';
import { decide, type DecideInput } from './policy-vm';
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
    predicates: [{ verb: 'revoke_session', resource: '/acct/*' }], // 'exfiltrate' is NOT permitted
    caveats: [{ type: 'expires', at: 9e12 }],
    agent_binding: {},
    risk_policy: DEFAULT_RISK_POLICY,
  },
}).grant;

function actn(verb: string, reversibility_class = 'reversible'): PCActn {
  const nodes: PlanNode[] = [{ id: 'n1', verb, resource: '/acct/1/s', reversibility_class }];
  return buildPCActn({ grant: GRANT, chain: [GRANT], plan: nodes, nodeId: 'n1', counter: 1, signerSecret: A.secretKey });
}

function decideInputFor(p: PCActn, risk: Partial<DecideInput['risk']> = {}): DecideInput {
  return {
    grant: GRANT,
    chain: [GRANT],
    action: {
      action: { verb: p.action.verb, resource: p.action.resource, params: {}, reversibility_class: p.action.reversibility_class },
    },
    risk: { semanticDistance: 0, reversibility: 1, blastRadius: 0, taint: 0, confidence: 1, age: 0, ...risk },
    budget: fresh,
    now: NOW,
    nodeId: p.plan.node_id,
  };
}

describe('openOptimistic / verifyClaim', () => {
  it('signs a claim over a reversible action that verifies', () => {
    const p = actn('revoke_session');
    const claim = openOptimistic(p, { bondRef: 'bond-1', claimedR: 0, challengeWindowMs: 5000, issuedAt: NOW }, A.secretKey);
    expect(verifyClaim(claim, p, encodeKey(A.publicKey))).toEqual({ ok: true });
  });

  it('refuses irreversible actions on the optimistic path', () => {
    const p = actn('revoke_session', IRREVERSIBLE_CLASS);
    expect(() => openOptimistic(p, { bondRef: 'b', claimedR: 0, challengeWindowMs: 1, issuedAt: NOW }, A.secretKey)).toThrow(/irreversible/);
  });

  it('a claim for a different PCActn or wrong key does not verify', () => {
    const p = actn('revoke_session');
    const claim = openOptimistic(p, { bondRef: 'b', claimedR: 0, challengeWindowMs: 5000, issuedAt: NOW }, A.secretKey);
    // A genuinely different action has a different digest -> the claim does not cover it.
    const other = actn('revoke_session', 'rate_limited');
    expect(verifyClaim(claim, other, encodeKey(A.publicKey)).ok).toBe(false);
    // Wrong signer public key.
    expect(verifyClaim(claim, p, encodeKey(generateKeyPair().publicKey)).ok).toBe(false);
  });
});

describe('challenge window', () => {
  it('open until issued_at + window, finalized after', () => {
    const p = actn('revoke_session');
    const claim = openOptimistic(p, { bondRef: 'b', claimedR: 0, challengeWindowMs: 5000, issuedAt: 1000 }, A.secretKey);
    expect(challengeWindowEnd(claim)).toBe(6000);
    expect(withinChallengeWindow(claim, 5999)).toBe(true);
    expect(withinChallengeWindow(claim, 6000)).toBe(true);
    expect(withinChallengeWindow(claim, 6001)).toBe(false);
    expect(claimStatus(claim, 3000)).toBe('open');
    expect(claimStatus(claim, 6001)).toBe('finalized');
  });
});

describe('fraud proofs', () => {
  it('a compliant claim has no fraud proof', () => {
    const p = actn('revoke_session');
    const di = decideInputFor(p);
    const d = decide(di);
    expect(d.releaseGuardianShare).toBe(true);
    const claim = openOptimistic(p, { bondRef: 'b', claimedR: d.r, challengeWindowMs: 5000, issuedAt: NOW }, A.secretKey);
    expect(fileFraudProof({ claim, pcactn: p, grant: GRANT, actualDecision: d, decideInput: di })).toBeNull();
  });

  it('an out-of-policy optimistic claim yields a verifying fraud proof -> slash', () => {
    const p = actn('exfiltrate'); // reversible action, but the verb is NOT permitted by the envelope
    const claim = openOptimistic(p, { bondRef: 'bond-X', claimedR: 0, challengeWindowMs: 5000, issuedAt: NOW }, A.secretKey);
    const di = decideInputFor(p);
    const d = decide(di);
    expect(d.releaseGuardianShare).toBe(false);
    const proof = fileFraudProof({ claim, pcactn: p, grant: GRANT, actualDecision: d, decideInput: di });
    expect(proof).not.toBeNull();
    expect(proof!.kind).toBe('policy-denied');
    const verdict = verifyFraudProof(claim, proof!, GRANT);
    expect(verdict.fraudulent).toBe(true);
    expect(verdict.slashBondRef).toBe('bond-X');
  });

  it('understating risk yields a verifying fraud proof', () => {
    const p = actn('revoke_session');
    // real risk is high (blastRadius=1 => r>=0.2), but the agent claimed r=0.
    const di = decideInputFor(p, { blastRadius: 1 });
    const d = decide(di);
    expect(d.r).toBeGreaterThan(0);
    const claim = openOptimistic(p, { bondRef: 'bond-R', claimedR: 0, challengeWindowMs: 5000, issuedAt: NOW }, A.secretKey);
    const proof = fileFraudProof({ claim, pcactn: p, grant: GRANT, actualDecision: d, decideInput: di });
    expect(proof).not.toBeNull();
    expect(['risk-understated', 'optimistic-not-allowed']).toContain(proof!.kind);
    expect(verifyFraudProof(claim, proof!, GRANT)).toMatchObject({ fraudulent: true, slashBondRef: 'bond-R' });
  });

  it('a fraud proof with a fabricated decision is rejected on recomputation', () => {
    const p = actn('revoke_session');
    const di = decideInputFor(p);
    const d = decide(di); // genuinely compliant
    const claim = openOptimistic(p, { bondRef: 'b', claimedR: d.r, challengeWindowMs: 5000, issuedAt: NOW }, A.secretKey);
    // forge a proof asserting a denial that did not happen
    const forged = {
      pcactn_digest: claim.pcactn_digest,
      bond_ref: claim.bond_ref,
      claimed_r: claim.claimed_r,
      kind: 'policy-denied' as const,
      decision: { releaseGuardianShare: false, r: 1, optimisticAllowed: false },
      evidence: (() => { const { grant: _g, ...rest } = di; void _g; return rest; })(),
      r_margin: 1e-9,
      reason: 'fabricated',
    };
    expect(verifyFraudProof(claim, forged, GRANT)).toMatchObject({ fraudulent: false });
  });

  it('cannot file a fraud proof against a mismatched PCActn', () => {
    const p = actn('exfiltrate');
    const claim = openOptimistic(p, { bondRef: 'b', claimedR: 0, challengeWindowMs: 5000, issuedAt: NOW }, A.secretKey);
    const other = actn('revoke_session');
    const di = decideInputFor(other);
    const d = decide(di);
    expect(fileFraudProof({ claim, pcactn: other, grant: GRANT, actualDecision: d, decideInput: di })).toBeNull();
  });
});

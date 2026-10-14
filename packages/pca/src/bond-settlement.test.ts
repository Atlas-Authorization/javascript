import { describe, expect, it } from 'vitest';
import { BondLedger, settlementEvidenceDigest, verifySettlement, revocationEvidenceDigest } from './bond-settlement';
import { fileFraudProof, openOptimistic, verifyFraudProof } from './optimistic';
import { mintGrant } from './envelope';
import { buildPCActn, type PCActn } from './pcactn';
import { decide, type DecideInput } from './policy-vm';
import { encodeKey, generateKeyPair } from './keys';
import { DEFAULT_RISK_POLICY, type TrustBudget } from './risk';
import type { Capability } from './capability';
import type { PlanNode } from './merkle';

const P = generateKeyPair();
const A = generateKeyPair();
const G = generateKeyPair(); // the guardian / settlement key
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

const ledger = () => new BondLedger({ guardianSecret: G.secretKey });
const gpk = encodeKey(G.publicKey);

describe('BondLedger — open → release (unchallenged)', () => {
  it('returns the bond to the depositor with a verifying signed record', () => {
    const L = ledger();
    const openRec = L.openBond({ claimId: 'bond-1', amount: 100, depositor: 'alice', at: NOW });
    expect(openRec.action).toBe('open');
    expect(L.bondStatus('bond-1')).toBe('open');
    expect(verifySettlement(openRec, gpk)).toBe(true);
    expect(L.balanceOf('alice')).toBe(0); // locked in escrow, not yet credited

    const relRec = L.releaseBond({ claimId: 'bond-1', at: NOW + 10 });
    expect(relRec.action).toBe('release');
    expect(relRec.to).toBe('alice');
    expect(relRec.amount).toBe(100);
    expect(relRec.evidenceDigest).toBe('');
    expect(verifySettlement(relRec, gpk)).toBe(true);
    expect(L.bondStatus('bond-1')).toBe('released');
    expect(L.balanceOf('alice')).toBe(100); // returned to the depositor
  });
});

describe('BondLedger — open → slash (verified fraud)', () => {
  it('moves the bond to the treasury with a record bound to the server-derived verdict', () => {
    const L = ledger();
    const p = actn('exfiltrate'); // reversible but NOT permitted by the envelope → policy-denied
    const claim = openOptimistic(p, { bondRef: 'bond-X', claimedR: 0, challengeWindowMs: 5000, issuedAt: NOW }, A.secretKey);
    const di = decideInputFor(p);
    const d = decide(di);
    const proof = fileFraudProof({ claim, pcactn: p, grant: GRANT, actualDecision: d, decideInput: di })!;
    expect(proof).not.toBeNull();

    L.openBond({ claimId: 'bond-X', amount: 250, depositor: 'alice', at: NOW });
    const slashRec = L.slashBond({ claimId: 'bond-X', claim, fraudProof: proof, grant: GRANT, treasury: 'treasury', at: NOW + 1 });

    expect(slashRec.action).toBe('slash');
    expect(slashRec.to).toBe('treasury');
    expect(slashRec.amount).toBe(250);
    expect(verifySettlement(slashRec, gpk)).toBe(true);
    expect(L.bondStatus('bond-X')).toBe('slashed');
    expect(L.balanceOf('treasury')).toBe(250);
    expect(L.balanceOf('alice')).toBe(0);

    // The evidence digest is bound to verifyFraudProof's OWN verdict, not challenger input.
    const verdict = verifyFraudProof(claim, proof, GRANT);
    expect(slashRec.evidenceDigest).toBe(settlementEvidenceDigest(claim, verdict));
    expect(slashRec.evidenceDigest).not.toBe('');
  });
});

describe('BondLedger — refusals', () => {
  it('a slash WITHOUT a valid fraud verdict is refused (bond stands)', () => {
    const L = ledger();
    const p = actn('revoke_session'); // compliant action
    const di = decideInputFor(p);
    const d = decide(di);
    expect(d.releaseGuardianShare).toBe(true);
    const claim = openOptimistic(p, { bondRef: 'bond-C', claimedR: d.r, challengeWindowMs: 5000, issuedAt: NOW }, A.secretKey);
    // A compliant claim yields no genuine fraud proof; fabricate one asserting a denial that did not happen.
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

    L.openBond({ claimId: 'bond-C', amount: 50, depositor: 'alice', at: NOW });
    expect(() => L.slashBond({ claimId: 'bond-C', claim, fraudProof: forged, grant: GRANT, treasury: 'treasury', at: NOW })).toThrow(/refused/);
    expect(L.bondStatus('bond-C')).toBe('open'); // bond still stands
    expect(L.balanceOf('treasury')).toBe(0);
  });

  it('double-settle is refused (release/slash after a bond is settled, and double-open)', () => {
    const L = ledger();
    L.openBond({ claimId: 'bond-D', amount: 10, depositor: 'alice', at: NOW });
    L.releaseBond({ claimId: 'bond-D', at: NOW });
    // Second settlement of the same bond is refused.
    expect(() => L.releaseBond({ claimId: 'bond-D', at: NOW })).toThrow(/double-settle|already/);
    // Re-opening the same claim id is refused.
    expect(() => L.openBond({ claimId: 'bond-D', amount: 10, depositor: 'alice', at: NOW })).toThrow(/double-open|already/);
    // Releasing / slashing a bond that does not exist is refused.
    expect(() => L.releaseBond({ claimId: 'no-such', at: NOW })).toThrow(/no bond/);
  });

  it('a tampered settlement record fails verification', () => {
    const L = ledger();
    const rec = L.openBond({ claimId: 'bond-T', amount: 100, depositor: 'alice', at: NOW });
    expect(verifySettlement(rec, gpk)).toBe(true);
    // Flip the amount → the signature no longer matches the body.
    expect(verifySettlement({ ...rec, amount: 999 }, gpk)).toBe(false);
    // Flip the destination account → also fails.
    expect(verifySettlement({ ...rec, to: 'mallory' }, gpk)).toBe(false);
    // Wrong guardian public key → fails.
    expect(verifySettlement(rec, encodeKey(generateKeyPair().publicKey))).toBe(false);
  });

  it('slashes a bond on a post-open revocation (server-derived evidence, not a fraud proof)', () => {
    const L = ledger();
    const p = actn('revoke_session');
    const claim = openOptimistic(p, { bondRef: 'bond-R', claimedR: 0, challengeWindowMs: 5000, issuedAt: NOW }, A.secretKey);
    L.openBond({ claimId: 'bond-R', amount: 70, depositor: 'alice', at: NOW });
    const rec = L.slashBondOnRevocation({ claimId: 'bond-R', claim, revokedCapId: 'cap:leaf', treasury: 'treasury', at: NOW + 1 });
    expect(rec.action).toBe('slash');
    expect(rec.to).toBe('treasury');
    expect(rec.evidenceDigest).toBe(revocationEvidenceDigest(claim, 'cap:leaf'));
    expect(verifySettlement(rec, gpk)).toBe(true);
    expect(L.balanceOf('treasury')).toBe(70);
    // double-settle refused
    expect(() => L.slashBondOnRevocation({ claimId: 'bond-R', claim, revokedCapId: 'cap:leaf', treasury: 'treasury', at: NOW + 2 })).toThrow(/double-settle|already/);
  });
});

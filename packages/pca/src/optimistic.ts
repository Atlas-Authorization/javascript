/**
 * §9A — Optimistic authorization with fraud proofs (latency accelerant).
 *
 * Borrowing optimistic-rollup mechanics for authorization: for a REVERSIBLE action the agent may act
 * immediately on a cheap SIGNED CLAIM of compliance, posting a bond. A CHALLENGE WINDOW lets the
 * Guardian/Principal submit a FRAUD PROOF that the claim was out-of-policy → the bond is slashed and
 * the reversible effect is rolled back. IRREVERSIBLE actions never go optimistic (spec §9A / §8.5):
 * they take the full threshold path.
 *
 * SCOPE / SEAM. This module is the PURE claim + challenge + fraud logic:
 *   - `openOptimistic` / `verifyClaim`   — mint and check the signed compliance claim.
 *   - `fileFraudProof` / `verifyFraudProof` — construct and independently re-verify a fraud proof,
 *     by RE-RUNNING the Policy VM (`decide`) on the real inputs and showing it contradicts the claim.
 *   - `withinChallengeWindow` / `claimStatus` — the challenge-window timing.
 * The economic bond itself — escrow, slashing, roll-back of effects, the ledger of settled claims —
 * is a SERVER / LEDGER concern and is NOT implemented here. `bond_ref` / `slashBondRef` are opaque
 * handles the settlement layer resolves. A fraud proof here yields the VERDICT (and which bond to
 * slash); acting on it is the ledger's job.
 */
import { b64u, canonicalBytes, utf8 } from './hash';
import { sign, verifyB64u } from './keys';
import type { Capability } from './capability';
import { type PCActn, pcactnDigest } from './pcactn';
import { type DecideInput, type PolicyDecision, decide } from './policy-vm';

const DOMAIN = 'atlas-pca/optimistic/v1\0';

/** A reversibility class that is NEVER eligible for the optimistic fast-path. */
export const IRREVERSIBLE_CLASS = 'irreversible';

/** A signed, bonded claim of compliance for the optimistic fast-path. */
export interface BondedClaim {
  /** `pcactnDigest` of the action this claim covers. */
  pcactn_digest: string;
  /** Opaque handle to the posted bond (resolved by the settlement layer). */
  bond_ref: string;
  /** The risk `r` the agent CLAIMS for the action (checked against the real `r` by a fraud proof). */
  claimed_r: number;
  /** The action's reversibility class (must not be `irreversible`). */
  reversibility_class: string;
  /** Issued-at (epoch ms). */
  issued_at: number;
  /** How long (ms) challenges are accepted after `issued_at`. */
  challenge_window_ms: number;
  /** b64u Ed25519 signature by the agent-leaf key over the canonical body. */
  sig: string;
}

export type BondedClaimBody = Omit<BondedClaim, 'sig'>;

function claimMessage(body: BondedClaimBody): Uint8Array {
  const d = canonicalBytes(body);
  const p = utf8(DOMAIN);
  const m = new Uint8Array(p.length + d.length);
  m.set(p);
  m.set(d, p.length);
  return m;
}

export interface OpenOptimisticOpts {
  bondRef: string;
  claimedR: number;
  challengeWindowMs: number;
  /** Issued-at (epoch ms). Default `Date.now()`; pass explicitly for deterministic tests. */
  issuedAt?: number;
}

/**
 * Open an optimistic claim for `pcactn`, signed by the agent-leaf `signerSecret`. REFUSES (throws)
 * when the action is irreversible — irreversible actions must take the full threshold path.
 */
export function openOptimistic(pcactn: PCActn, opts: OpenOptimisticOpts, signerSecret: Uint8Array): BondedClaim {
  const rc = pcactn?.action?.reversibility_class;
  if (rc === IRREVERSIBLE_CLASS) {
    throw new Error('openOptimistic: irreversible actions cannot use the optimistic fast-path (§9A)');
  }
  if (!Number.isFinite(opts.claimedR)) throw new Error('openOptimistic: claimedR must be finite');
  if (!Number.isFinite(opts.challengeWindowMs) || opts.challengeWindowMs < 0) {
    throw new Error('openOptimistic: challengeWindowMs must be a non-negative number');
  }
  const body: BondedClaimBody = {
    pcactn_digest: pcactnDigest(pcactn),
    bond_ref: opts.bondRef,
    claimed_r: opts.claimedR,
    reversibility_class: typeof rc === 'string' ? rc : 'unknown',
    issued_at: Number.isFinite(opts.issuedAt) ? (opts.issuedAt as number) : Date.now(),
    challenge_window_ms: opts.challengeWindowMs,
  };
  return { ...body, sig: b64u(sign(signerSecret, claimMessage(body))) };
}

export interface ClaimVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Verify a bonded claim: the signature verifies under `signerPublic`, the claim covers THIS pcactn,
 * and the action is not irreversible. Does NOT judge policy compliance — that is a fraud proof's job
 * (an unchallenged valid claim finalizes when its window closes). Total; never throws.
 */
export function verifyClaim(claim: BondedClaim, pcactn: PCActn, signerPublic: string): ClaimVerdict {
  try {
    if (!claim || typeof claim !== 'object') return { ok: false, reason: 'malformed claim' };
    if (claim.reversibility_class === IRREVERSIBLE_CLASS) {
      return { ok: false, reason: 'irreversible action is ineligible for the optimistic path' };
    }
    if (claim.pcactn_digest !== pcactnDigest(pcactn)) {
      return { ok: false, reason: 'claim does not cover this PCActn' };
    }
    if (!Number.isFinite(claim.claimed_r)) return { ok: false, reason: 'claimed_r is not finite' };
    if (!Number.isFinite(claim.issued_at) || !Number.isFinite(claim.challenge_window_ms) || claim.challenge_window_ms < 0) {
      return { ok: false, reason: 'malformed challenge window' };
    }
    const { sig, ...body } = claim;
    if (typeof sig !== 'string' || !verifyB64u(signerPublic, claimMessage(body), sig)) {
      return { ok: false, reason: 'claim signature does not verify' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `claim verification error: ${e instanceof Error ? e.message : 'unknown'}` };
  }
}

// ---- challenge window --------------------------------------------------------------------

export type ClaimPhase = 'open' | 'finalized';

/** Epoch-ms at which the challenge window closes (inclusive end is `issued_at + window`). */
export function challengeWindowEnd(claim: BondedClaim): number {
  return claim.issued_at + claim.challenge_window_ms;
}

/** True while challenges are still accepted: `now <= issued_at + challenge_window_ms`. */
export function withinChallengeWindow(claim: BondedClaim, now: number): boolean {
  if (!Number.isFinite(now)) return false;
  return now <= challengeWindowEnd(claim);
}

/** `open` while challenges are accepted, else `finalized` (bond releasable, no longer challengeable). */
export function claimStatus(claim: BondedClaim, now: number): ClaimPhase {
  return withinChallengeWindow(claim, now) ? 'open' : 'finalized';
}

// ---- fraud proofs ------------------------------------------------------------------------

export type FraudKind =
  | 'policy-denied' // the Policy VM denies the action outright
  | 'risk-understated' // actual r materially exceeds the claimed_r
  | 'optimistic-not-allowed' // at the real risk, the optimistic path is not permitted
  | 'irreversible'; // the action is irreversible and never eligible

/** A summary of the decision a fraud proof carries, re-derived and re-checked by the verifier. */
export interface DecisionSummary {
  releaseGuardianShare: boolean;
  r: number;
  optimisticAllowed: boolean;
}

/**
 * A fraud proof: evidence that a bonded claim was false. It carries the Policy VM inputs (minus the
 * grant, which `verifyFraudProof` supplies) so the verifier can RE-RUN `decide` and independently
 * confirm the contradiction — the proof is only convincing because it is recomputable, not because
 * the challenger asserts it.
 */
export interface FraudProof {
  /** Must equal the claim's `pcactn_digest` — the proof targets exactly the claimed action. */
  pcactn_digest: string;
  /** The bond the proof asks to slash. */
  bond_ref: string;
  /** The risk the claim asserted (copied from the claim it refutes). */
  claimed_r: number;
  kind: FraudKind;
  /** The decision the challenger says the VM really yields (re-derived and re-checked on verify). */
  decision: DecisionSummary;
  /** Policy-VM inputs WITHOUT the grant (verifyFraudProof injects the grant it is given). */
  evidence: Omit<DecideInput, 'grant'>;
  /** Tolerance: actual r must exceed claimed_r by at least this to count as understated (default used by filer). */
  r_margin: number;
  reason: string;
}

const DEFAULT_R_MARGIN = 1e-9;

/**
 * File a fraud proof against `claim` for `pcactn`, given the grant and the AUTHORITATIVE decision
 * (`actualDecision`, from running `decide` on the real inputs). Returns a `FraudProof` if the claim
 * was false, else `null` (a compliant claim has no fraud proof). The caller passes the SAME
 * `decideInput` it ran through `decide` as `evidence` (its grant is stripped — the verifier re-adds
 * the grant it independently trusts).
 *
 * A claim is fraudulent when ANY of:
 *   - the action is irreversible (never eligible);
 *   - the Policy VM denies (no guardian-share release);
 *   - at the real risk the optimistic path is not allowed (e.g. r crossed θ1, or the real action is
 *     irreversible per policy);
 *   - the real r materially exceeds the claimed_r (risk understated to dodge step-up).
 */
export function fileFraudProof(args: {
  claim: BondedClaim;
  pcactn: PCActn;
  grant: Capability;
  actualDecision: PolicyDecision;
  decideInput: DecideInput;
  rMargin?: number;
}): FraudProof | null {
  const { claim, pcactn, actualDecision, decideInput } = args;
  if (claim.pcactn_digest !== pcactnDigest(pcactn)) return null; // cannot frame a different action
  const margin = Number.isFinite(args.rMargin) ? Math.max(0, args.rMargin as number) : DEFAULT_R_MARGIN;

  const decision: DecisionSummary = {
    releaseGuardianShare: actualDecision.releaseGuardianShare,
    r: actualDecision.r,
    optimisticAllowed: actualDecision.requiredThreshold.optimisticAllowed,
  };
  const { grant: _g, ...evidence } = decideInput;
  void _g;

  const base = {
    pcactn_digest: claim.pcactn_digest,
    bond_ref: claim.bond_ref,
    claimed_r: claim.claimed_r,
    decision,
    evidence,
    r_margin: margin,
  };

  let kind: FraudKind | null = null;
  let reason = '';
  if (claim.reversibility_class === IRREVERSIBLE_CLASS || pcactn.action?.reversibility_class === IRREVERSIBLE_CLASS) {
    kind = 'irreversible';
    reason = 'irreversible action took the optimistic path';
  } else if (!actualDecision.releaseGuardianShare) {
    kind = 'policy-denied';
    reason = `Policy VM denied the action: ${actualDecision.reasons.join('; ') || 'not compliant'}`;
  } else if (!actualDecision.requiredThreshold.optimisticAllowed) {
    kind = 'optimistic-not-allowed';
    reason = `optimistic path not allowed at real r=${actualDecision.r.toFixed(3)} (t=${actualDecision.requiredThreshold.t})`;
  } else if (actualDecision.r > claim.claimed_r + margin) {
    kind = 'risk-understated';
    reason = `claimed r=${claim.claimed_r} but real r=${actualDecision.r.toFixed(3)}`;
  }

  if (kind === null) return null;
  return { ...base, kind, reason };
}

export interface FraudVerdict {
  fraudulent: boolean;
  slashBondRef?: string;
  reason: string;
}

/**
 * Independently verify a fraud proof. RE-RUNS the Policy VM on the proof's evidence under the GRANT
 * THE VERIFIER TRUSTS (not one carried in the proof), confirms the recomputed decision matches the
 * decision the proof asserts, and confirms it genuinely contradicts the claim. Returns `fraudulent`
 * with the bond to slash, or a non-fraud verdict (the bond stands). Total; never throws.
 */
export function verifyFraudProof(claim: BondedClaim, proof: FraudProof, grant: Capability): FraudVerdict {
  try {
    if (!proof || typeof proof !== 'object') return { fraudulent: false, reason: 'malformed fraud proof' };
    if (proof.pcactn_digest !== claim.pcactn_digest) {
      return { fraudulent: false, reason: 'fraud proof targets a different PCActn than the claim' };
    }
    if (proof.bond_ref !== claim.bond_ref) {
      return { fraudulent: false, reason: 'fraud proof names a different bond than the claim' };
    }

    // Re-run the Policy VM under the verifier's own grant and the proof's evidence.
    const recomputed = decide({ ...proof.evidence, grant });
    const summary: DecisionSummary = {
      releaseGuardianShare: recomputed.releaseGuardianShare,
      r: recomputed.r,
      optimisticAllowed: recomputed.requiredThreshold.optimisticAllowed,
    };
    // The challenger's asserted decision must match the recomputation (no fabricated decision).
    if (
      summary.releaseGuardianShare !== proof.decision.releaseGuardianShare ||
      summary.optimisticAllowed !== proof.decision.optimisticAllowed ||
      Math.abs(summary.r - proof.decision.r) > 1e-9
    ) {
      return { fraudulent: false, reason: 'proof decision does not match an independent recomputation' };
    }

    const margin = Number.isFinite(proof.r_margin) ? Math.max(0, proof.r_margin) : DEFAULT_R_MARGIN;
    const irreversible =
      claim.reversibility_class === IRREVERSIBLE_CLASS || proof.evidence.action?.action?.reversibility_class === IRREVERSIBLE_CLASS;

    // Confirm the recomputed decision genuinely refutes the claim.
    if (irreversible) {
      return { fraudulent: true, slashBondRef: claim.bond_ref, reason: 'irreversible action is ineligible for the optimistic path' };
    }
    if (!summary.releaseGuardianShare) {
      return { fraudulent: true, slashBondRef: claim.bond_ref, reason: `Policy VM denies the action: ${recomputed.reasons.join('; ') || 'not compliant'}` };
    }
    if (!summary.optimisticAllowed) {
      return { fraudulent: true, slashBondRef: claim.bond_ref, reason: `optimistic path not allowed at real r=${summary.r.toFixed(3)}` };
    }
    if (summary.r > claim.claimed_r + margin) {
      return { fraudulent: true, slashBondRef: claim.bond_ref, reason: `risk understated: claimed ${claim.claimed_r}, real ${summary.r.toFixed(3)}` };
    }

    return { fraudulent: false, reason: 'claim is compliant under independent recomputation; bond stands' };
  } catch (e) {
    return { fraudulent: false, reason: `fraud-proof verification error: ${e instanceof Error ? e.message : 'unknown'}` };
  }
}

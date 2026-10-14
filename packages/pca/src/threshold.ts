import { b64u } from './hash';
import { publicKeyOf, sign, verifyB64u } from './keys';
import { type PCActn, type ThresholdVerifier, type VerifyContext, thresholdMessage } from './pcactn';
import { readEnvelope } from './envelope';
import { requiredThreshold } from './risk';

/**
 * Risk-adaptive threshold signatures (spec §6 L2 "policy-as-cosigner", §6 L3 "risk-adaptive
 * threshold", Deep Dive I "mathematically short of a key").
 *
 * This is a SOUND t-of-n MULTI-SIGNATURE: a threshold signature is a bag of `t` INDEPENDENT
 * Ed25519 signatures, each produced by a distinct allowed role over the SAME canonical message
 * (`thresholdMessage(pcactn)`). Verification counts the number of DISTINCT roles whose share both
 * (a) is signed by that role's registered key and (b) verifies over the message; the signature is
 * accepted iff that count is >= t.
 *
 * The security property (Deep Dive I): a PCActn requiring threshold `t` cannot be accepted without
 * `t` distinct valid signatures from the allowed signer set. A compromised agent holds only the
 * agent key, so it can produce exactly ONE share — it is `t-1` short for anything above t=1. The
 * guardian share is released only by the Policy VM on a compliant action, and the principal share
 * requires a human; neither can be forged from the agent key. Authority is "a property of a
 * verified computation, not of a possessed secret."
 *
 * FUTURE OPTIMIZATION (not done here, deliberately): a FROST / Schnorr key-aggregation scheme would
 * let the `t` shares collapse into a SINGLE aggregated 64-byte Ed25519-style signature verifiable
 * against one aggregated public key, instead of carrying `t` separate shares. That is a wire-size /
 * verifier-cost optimization only; it does not change the security property proven above, and it
 * requires a distributed key-generation ceremony (per §15 M4 "FROST"). We ship the multi-signature
 * form first because it is simple, auditable, and needs no DKG — each role just signs independently.
 */

export type SignerRole = 'agent' | 'guardian' | 'principal';

/** A registered member of the signer set: the public key (b64u) allowed to sign for `role`. */
export interface Signer {
  role: SignerRole;
  /** b64u Ed25519 public key. */
  publicKey: string;
}

/** One role's independent Ed25519 signature over `thresholdMessage(pcactn)`. */
export interface ThresholdShare {
  role: SignerRole;
  /** b64u Ed25519 public key that produced `sig`. */
  publicKey: string;
  /** b64u Ed25519 signature. */
  sig: string;
}

/** A t-of-n multi-signature: the collected shares. `t` itself lives in the risk policy, not here. */
export interface ThresholdSignature {
  shares: ThresholdShare[];
}

/** Produce a role's share: Ed25519-sign `message` with `secretKey`, tagging the role + its pubkey. */
export function signShare(role: SignerRole, secretKey: Uint8Array, message: Uint8Array): ThresholdShare {
  return { role, publicKey: b64u(publicKeyOf(secretKey)), sig: b64u(sign(secretKey, message)) };
}

/** Collect shares into a ThresholdSignature (defensively copied). */
export function assembleThreshold(shares: ThresholdShare[]): ThresholdSignature {
  return { shares: Array.isArray(shares) ? [...shares] : [] };
}

export interface ThresholdVerdict {
  ok: boolean;
  /** number of DISTINCT valid roles (each role counted at most once). */
  count: number;
  /** the distinct roles that contributed a valid share, in first-seen order. */
  roles: SignerRole[];
  reason?: string;
}

/**
 * Verify a t-of-n multi-signature. A share counts iff: its `role` is present in `signerSet`, its
 * `publicKey` is a key registered for that role, and its `sig` verifies over `message` under that
 * key. DISTINCT valid roles are counted once each (a duplicate role never double-counts). `ok` iff
 * distinctValidRoles >= t. Deterministic and TOTAL — it never throws (bad keys/sigs simply fail).
 */
export function verifyThreshold(
  sig: ThresholdSignature,
  message: Uint8Array,
  signerSet: Signer[],
  t: number,
): ThresholdVerdict {
  // role -> set of registered public keys for that role.
  const registered = new Map<SignerRole, Set<string>>();
  for (const s of Array.isArray(signerSet) ? signerSet : []) {
    if (!s || typeof s.role !== 'string' || typeof s.publicKey !== 'string') continue;
    let set = registered.get(s.role);
    if (!set) registered.set(s.role, (set = new Set()));
    set.add(s.publicKey);
  }

  const validRoles: SignerRole[] = [];
  const seenValid = new Set<SignerRole>();
  let reason: string | undefined;

  for (const share of sig && Array.isArray(sig.shares) ? sig.shares : []) {
    if (!share || typeof share.role !== 'string') {
      reason ??= 'malformed share';
      continue;
    }
    if (seenValid.has(share.role)) continue; // role already satisfied: count once.
    const allowed = registered.get(share.role);
    if (!allowed) {
      reason ??= `role ${share.role} is not in the signer set`;
      continue;
    }
    if (typeof share.publicKey !== 'string' || !allowed.has(share.publicKey)) {
      reason ??= `share for role ${share.role} uses a key not registered for that role`;
      continue;
    }
    if (typeof share.sig !== 'string' || !verifyB64u(share.publicKey, message, share.sig)) {
      reason ??= `invalid signature for role ${share.role}`;
      continue;
    }
    seenValid.add(share.role);
    validRoles.push(share.role);
  }

  const count = validRoles.length;
  const need = Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  const ok = count >= need;
  if (ok) return { ok, count, roles: validRoles };
  return { ok, count, roles: validRoles, reason: reason ?? `only ${count} distinct valid role(s), need ${t}` };
}

export interface ThresholdVerifierOpts {
  /** The roles + public keys permitted to co-sign. MUST register the agent role's key = the leaf. */
  signerSet: Signer[];
  /**
   * Fixed required threshold. If omitted, `requiredT` (or the default risk-derived resolver) sets
   * it per action, per Appendix A step 7: `t = requiredThreshold(risk_claim.r, G.risk_policy).t`.
   */
  t?: number;
  /** Override how the required `t` is derived from the verify context. Takes precedence over `t`. */
  requiredT?: (ctx: VerifyContext) => number;
}

/** Default: Appendix A step 7 — t from the action's claimed risk against the grant's risk policy. */
function riskDerivedT(ctx: VerifyContext): number {
  const env = readEnvelope(ctx.grant);
  if (!env) return 1; // no policy to consult => agent-leaf baseline.
  const r = ctx.pcactn?.risk_claim?.r;
  return requiredThreshold(typeof r === 'number' ? r : 1, env.risk_policy).t;
}

/**
 * Build a `ThresholdVerifier` hook (the L2/M4 hook interface in pcactn.ts). Given a PCActn it:
 *  1. recomputes the canonical signed message via `thresholdMessage` (the SAME bytes the agent
 *     `sig` and every share cover — one definition, no drift);
 *  2. assembles the shares to check = the agent-leaf share (role 'agent', key = the capability
 *     chain's leaf holder, sig = pcactn.sig) PLUS any shares carried in `pcactn.threshold`. This is
 *     why a t=1 action with only the baseline `sig` and no `threshold` field still passes;
 *  3. resolves the required `t` (fixed, custom, or risk-derived), and returns an ENFORCED pass/fail
 *     from `verifyThreshold`.
 */
export function createThresholdVerifier(opts: ThresholdVerifierOpts): ThresholdVerifier {
  const resolveT = opts.requiredT ?? (opts.t !== undefined ? () => opts.t as number : riskDerivedT);
  return (ctx: VerifyContext) => {
    const p: PCActn = ctx.pcactn;
    const message = thresholdMessage(p);
    const shares: ThresholdShare[] = [];
    const chain = p.cap_chain;
    const leaf = Array.isArray(chain) ? chain[chain.length - 1] : undefined;
    if (leaf && typeof leaf.holder === 'string' && typeof p.sig === 'string') {
      shares.push({ role: 'agent', publicKey: leaf.holder, sig: p.sig });
    }
    if (p.threshold && Array.isArray(p.threshold.shares)) shares.push(...p.threshold.shares);
    const t = resolveT(ctx);
    const verdict = verifyThreshold({ shares }, message, opts.signerSet, t);
    return verdict.ok
      ? { enforced: true, ok: true }
      : { enforced: true, ok: false, reason: verdict.reason ?? 'threshold not met' };
  };
}

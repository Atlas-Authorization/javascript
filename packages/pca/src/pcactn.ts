import { type Capability, type CapabilityChain, capHash, verifyChain } from './capability';
import { b64u, canonicalBytes, canonicalize, hashCanonical, sha256, utf8 } from './hash';
import { sign, verifyB64u } from './keys';
import {
  type InclusionProof,
  type PlanNode,
  DEFAULT_REVERSIBILITY_CLASS,
  commitPlan,
  conditionsDigest,
  paramsDigest,
  planLeaf,
  verifyInclusion,
} from './merkle';
import type { ThresholdSignature } from './threshold';

/** PCActn wire object (spec §7). */
export interface PCActn {
  ver: number;
  action: {
    verb: string;
    resource: string;
    params_digest: string;
    reversibility_class: string;
  };
  grant_ref: string;
  cap_chain: CapabilityChain;
  /** `conditions_digest` commits the node's pre/post (see merkle.conditionsDigest). */
  plan: { root: string; inclusion_proof: InclusionProof; node_id: string; conditions_digest?: string };
  attestation: { quote_digest: string; epoch: number; model_id: string; measurement: string; operator: string };
  provenance: { causal_hash: string; taint_level: number; trusted_refs: string[] };
  freshness: { beacon_ref: string; epoch: number; accumulator_witness: string };
  counter: number;
  risk_claim: { r: number; inputs: Record<string, unknown> };
  /**
   * M0: single Ed25519 signature (b64u) by the leaf capability holder. This is the AGENT-LEAF
   * baseline and is, on its own, an effective t=1 threshold (the agent role's share). See §6 L2.
   */
  sig: string;
  /**
   * M4 (L2/L3): the risk-adaptive threshold signature. When `requiredThreshold.t > 1` this field
   * carries the additional guardian/principal shares; at t=1 it may be omitted because the agent's
   * `sig` above already stands in as the single agent share. Every share here signs exactly the
   * bytes produced by `thresholdMessage(this)` — the SAME message `sig` covers. Optional and
   * backward-compatible: a PCActn with no `threshold` is a t=1 agent-only action.
   */
  threshold?: ThresholdSignature;
  zk_compliance?: unknown;
  bond_ref?: string;
}

export const PCACTN_VERSION = 1;
const SIG_DOMAIN = 'atlas-pca/actn/v1\0';

export type PCActnBody = Omit<PCActn, 'sig'>;

/**
 * The ONE canonical message every signature over a PCActn covers: the agent-leaf `sig` AND every
 * threshold share (guardian / principal, §6 L2) sign exactly these bytes, so the leaf and the extra
 * shares are provably over the same action. There is a single definition so the message cannot
 * drift between signer and verifier.
 *
 * It is `SIG_DOMAIN ‖ sha256(canonical(body))` where `body` is the PCActn WITHOUT the two signature
 * containers themselves — `sig` and `threshold`. Excluding `threshold` is what lets shares be added
 * after the message is fixed (the shares cannot sign a field that holds the shares). For any PCActn
 * that carries no `threshold` (every M0 object), this is byte-identical to the previous definition.
 */
export function thresholdMessage(p: PCActn | PCActnBody): Uint8Array {
  const { sig: _sig, threshold: _th, ...body } = p as PCActn;
  void _sig;
  void _th;
  const d = sha256(canonicalBytes(body));
  const pre = utf8(SIG_DOMAIN);
  const m = new Uint8Array(pre.length + d.length);
  m.set(pre);
  m.set(d, pre.length);
  return m;
}

/** Sign the body with the leaf holder's key and return the complete PCActn. */
export function signPCActn(body: PCActnBody, leafHolderSecret: Uint8Array): PCActn {
  return { ...body, sig: b64u(sign(leafHolderSecret, thresholdMessage(body))) };
}

export function encodePCActn(p: PCActn): string {
  return canonicalize(p);
}

export function decodePCActn(s: string): PCActn {
  const v = JSON.parse(s) as PCActn;
  if (typeof v !== 'object' || v === null) throw new TypeError('decodePCActn: not an object');
  return v;
}

export function pcactnDigest(p: PCActn): string {
  return hashCanonical(p);
}

/**
 * Build a complete, signed PCActn for plan node `nodeId`. action = node's verb/resource/
 * reversibility_class; params_digest = paramsDigest(params) (the canonical rule in merkle.ts);
 * the node's own params_digest (if any) must match, else this throws (a silent non-match would
 * fail inclusion later). attestation/freshness/provenance default to NOT-YET-ENFORCED stubs
 * (empty values; verifyPCActnCore reports those checks as 'not-enforced').
 */
export function buildPCActn(input: {
  grant: Capability;
  chain: CapabilityChain;
  plan: PlanNode[];
  nodeId: string;
  params?: Record<string, unknown>;
  counter: number;
  signerSecret: Uint8Array;
  provenance?: PCActn['provenance'];
  attestation?: PCActn['attestation'];
  freshness?: PCActn['freshness'];
  riskClaim?: PCActn['risk_claim'];
}): PCActn {
  const node = input.plan.find((n) => n.id === input.nodeId);
  if (!node) throw new Error(`buildPCActn: unknown plan node ${input.nodeId}`);
  const digest = paramsDigest(input.params);
  if (node.params_digest !== undefined && node.params_digest !== digest) {
    throw new Error(`buildPCActn: params do not match plan node ${node.id}'s params_digest`);
  }
  const committed = commitPlan(input.plan);
  const body: PCActnBody = {
    ver: PCACTN_VERSION,
    action: {
      verb: node.verb,
      resource: node.resource,
      params_digest: digest,
      reversibility_class: node.reversibility_class ?? DEFAULT_REVERSIBILITY_CLASS,
    },
    grant_ref: input.grant.id,
    cap_chain: input.chain,
    plan: {
      root: committed.root,
      inclusion_proof: committed.proofFor(node.id),
      node_id: node.id,
      conditions_digest: conditionsDigest(node.pre, node.post),
    },
    // NOT-YET-ENFORCED stub defaults (M5 attestation / M3 freshness / M1 taint gate).
    attestation: input.attestation ?? { quote_digest: '', epoch: 0, model_id: 'unattested', measurement: '', operator: 'unattested' },
    provenance: input.provenance ?? { causal_hash: '', taint_level: 0, trusted_refs: [] },
    freshness: input.freshness ?? { beacon_ref: '', epoch: 0, accumulator_witness: '' },
    counter: input.counter,
    risk_claim: input.riskClaim ?? { r: 0, inputs: {} },
  };
  return signPCActn(body, input.signerSecret);
}

// ---- later-milestone hooks ----------------------------------------------------------------

export type HookResult = { enforced: false } | { enforced: true; ok: boolean; reason?: string };
export interface VerifyContext {
  pcactn: PCActn;
  grant: Capability;
  nowEpoch?: number;
}
export type Hook = (ctx: VerifyContext) => HookResult | Promise<HookResult>;
export type AttestationVerifier = Hook; // L0 / M5
export type ThresholdVerifier = Hook; // L2 / M2, M4
export type RevocationChecker = Hook; // L5 / M3
export type ZkVerifier = Hook; // 9B / M6

export const notEnforced: Hook = () => ({ enforced: false });

export interface VerifyHooks {
  attestation?: AttestationVerifier;
  threshold?: ThresholdVerifier;
  revocation?: RevocationChecker;
  zk?: ZkVerifier;
}

export type CheckStatus = 'pass' | 'fail' | 'not-enforced';
export interface VerifyResult {
  allow: boolean;
  checks: Record<string, CheckStatus>;
  reason?: string;
}

/**
 * Appendix A, M0-available checks. Checks owned by later milestones (attestation, plan-root
 * authorization, taint gate, threshold, revocation, zk, bond) report 'not-enforced' unless a hook
 * is supplied. allow = no check failed; callers requiring a stronger rung must inspect `checks`.
 */
export async function verifyPCActnCore(
  p: PCActn,
  opts: { grant: Capability; nowEpoch?: number; hooks?: VerifyHooks },
): Promise<VerifyResult> {
  const checks: Record<string, CheckStatus> = {};
  let reason: string | undefined;
  const fail = (name: string, why: string) => {
    checks[name] = 'fail';
    reason ??= `${name}: ${why}`;
  };
  const ctx: VerifyContext = { pcactn: p, grant: opts.grant, nowEpoch: opts.nowEpoch };

  try {
    // 0. version
    if (p.ver === PCACTN_VERSION) checks.version = 'pass';
    else fail('version', `unsupported ver ${String(p.ver)}`);

    // 1. capability chain, root == G
    const chain = p.cap_chain;
    if (!Array.isArray(chain) || chain.length === 0) {
      fail('cap_chain', 'empty chain');
    } else if (capHash(chain[0]!) !== capHash(opts.grant)) {
      fail('cap_chain', 'chain root is not the grant');
    } else {
      const r = verifyChain(chain, opts.grant.issuer);
      if (r.ok) checks.cap_chain = 'pass';
      else fail('cap_chain', r.reason ?? 'invalid');
    }

    // 2. plan inclusion (L1): the leaf is recomputed from the action itself
    const cond = p.plan?.conditions_digest ?? conditionsDigest();
    const leaf = planLeaf(p.plan?.node_id, p.action, cond);
    if (verifyInclusion(p.plan?.root, p.plan?.inclusion_proof, leaf)) checks.plan_inclusion = 'pass';
    else fail('plan_inclusion', 'action is not a node of the committed plan');
    checks.plan_root_authorized = 'not-enforced'; // M1/M2

    // 3. leaf-holder signature over the canonical body
    const leafCap = Array.isArray(chain) ? chain[chain.length - 1] : undefined;
    if (leafCap && typeof p.sig === 'string' && verifyB64u(leafCap.holder, thresholdMessage(p), p.sig)) {
      checks.leaf_signature = 'pass';
    } else {
      fail('leaf_signature', 'signature does not verify under the leaf holder key');
    }

    // 4. counter (monotonicity vs. stored state is the RS's job; presence/type here)
    if (typeof p.counter === 'number' && Number.isInteger(p.counter) && p.counter >= 0) checks.counter = 'pass';
    else fail('counter', 'missing or not a non-negative integer');

    // later milestones
    checks.taint_gate = 'not-enforced'; // M1
    const run = async (name: string, hook: Hook | undefined, applicable = true) => {
      if (!applicable) return;
      const res = await (hook ?? notEnforced)(ctx);
      if (!res.enforced) checks[name] = 'not-enforced';
      else if (res.ok) checks[name] = 'pass';
      else fail(name, res.reason ?? 'rejected');
    };
    await run('attestation', opts.hooks?.attestation);
    await run('threshold', opts.hooks?.threshold);
    await run('revocation', opts.hooks?.revocation);
    await run('zk_compliance', opts.hooks?.zk, p.zk_compliance !== undefined);
    if (p.bond_ref !== undefined) checks.bond = 'not-enforced';
  } catch (e) {
    reason ??= `malformed PCActn: ${(e as Error).message}`;
    checks.malformed = 'fail';
  }

  const allow = !Object.values(checks).includes('fail');
  return allow ? { allow, checks } : { allow, checks, reason };
}

import {
  decodePCActn,
  decide,
  evaluateCaveats,
  hashCanonical,
  merkleRoot,
  readEnvelope,
  verifyPCActnCore,
  planNodeLeaf,
  type Capability,
  type CheckStatus,
  type PCActn,
  type PlanNode,
  type RequiredThreshold,
  type RiskInputs,
  type TrustBudget,
  type VerifyHooks,
} from '@atlasauth/pca';


/**
 * Resource-server side Proof-Carrying Authority verifier (spec §4, §7, Appendix A).
 * Deterministic and offline; never throws (any internal error becomes a fail-closed verdict).
 */

export interface PcaContext {
  /** Plaintext action params. If given they MUST hash to `action.params_digest`; needed by predicates. */
  params?: Record<string, unknown>;
  subject?: Record<string, unknown>;
  env?: Record<string, unknown>;
  /** The committed plan, if the RS knows it. Its Merkle root must equal `plan.root`. */
  plan?: PlanNode[];
  /** Risk inputs the RS can vouch for. Missing ones fail closed (worst case) except `taint`, see below. */
  risk?: Partial<RiskInputs>;
  /** Current trust budget for the leaf holder. Absent = a full budget (`budget` check reports not-enforced). */
  budget?: TrustBudget;
  recentActionTimes?: number[];
}

export interface VerifyPCActnOptions {
  grant: Capability;
  hooks?: VerifyHooks;
  /** epoch ms (default Date.now()) */
  now?: number;
  context?: PcaContext;
}

export interface PcaVerdict {
  allow: boolean;
  /** Recomputed risk score in [0,1]. */
  r: number;
  requiredThreshold: RequiredThreshold;
  checks: Record<string, CheckStatus>;
  reasons: string[];
  /** Budget after the decision (leaked, and debited when auto-admitted). Persist it on allow. */
  budget?: TrustBudget;
}

const WORST_THRESHOLD: RequiredThreshold = { t: 3, proof: 'strong', optimisticAllowed: false };

function failClosed(reason: string, checks: Record<string, CheckStatus> = {}): PcaVerdict {
  return {
    allow: false,
    r: 1,
    requiredThreshold: WORST_THRESHOLD,
    checks: { ...checks, malformed: 'fail' },
    reasons: [reason],
  };
}

export async function verifyPCActn(pcactn: PCActn | string, opts: VerifyPCActnOptions): Promise<PcaVerdict> {
  try {
    let p: PCActn;
    try {
      p = typeof pcactn === 'string' ? decodePCActn(pcactn) : pcactn;
    } catch (e) {
      return failClosed(`undecodable PCActn: ${(e as Error).message}`);
    }
    if (p === null || typeof p !== 'object') return failClosed('PCActn is not an object');

    const now = opts.now ?? Date.now();
    const ctx = opts.context ?? {};
    const core = await verifyPCActnCore(p, { grant: opts.grant, nowEpoch: now, hooks: opts.hooks });
    const checks: Record<string, CheckStatus> = { ...core.checks };
    const reasons: string[] = [];
    if (!core.allow && core.reason) reasons.push(core.reason);
    const fail = (name: string, why: string) => {
      checks[name] = 'fail';
      reasons.push(`${name}: ${why}`);
    };

    // grant_ref binds the object to this grant
    if (p.grant_ref === opts.grant.id) checks.grant_ref = 'pass';
    else fail('grant_ref', 'does not reference the supplied grant');

    // params plaintext must open the committed digest
    if (ctx.params !== undefined) {
      if (hashCanonical(ctx.params) === p.action?.params_digest) checks.params_digest = 'pass';
      else fail('params_digest', 'supplied params do not hash to action.params_digest');
    } else checks.params_digest = 'not-enforced';

    // the RS's own copy of the plan must be the committed one
    if (ctx.plan) {
      if (merkleRoot(ctx.plan.map(planNodeLeaf)) === p.plan?.root) checks.plan_root_authorized = 'pass';
      else fail('plan_root_authorized', 'known plan does not match plan.root');
    }

    const chain = Array.isArray(p.cap_chain) ? p.cap_chain : [];
    const leaf = chain[chain.length - 1];
    const depth = Math.max(0, chain.length - 1);
    const now0 = now;
    const budgetIn: TrustBudget = ctx.budget ?? { B: Number.POSITIVE_INFINITY, tau: now0, asOf: now0 };
    checks.budget = ctx.budget ? 'pass' : 'not-enforced';

    // Taint: the agent's claim, used only as a default input (RS-supplied risk.taint wins).
    const claimedTaint = p.provenance?.taint_level;
    const risk: Partial<RiskInputs> = { ...ctx.risk };
    if (risk.taint === undefined && typeof claimedTaint === 'number') risk.taint = claimedTaint;

    const reversibility = p.action?.reversibility_class;
    const bMaxProbe = decideBudget(opts.grant, budgetIn, ctx.budget === undefined);
    const d = decide({
      grant: opts.grant,
      action: {
        action: { verb: p.action?.verb, resource: p.action?.resource, params: ctx.params, reversibility_class: reversibility },
        subject: ctx.subject,
        env: ctx.env,
      },
      plan: ctx.plan,
      nodeId: p.plan?.node_id,
      risk,
      budget: bMaxProbe,
      now,
      caveatContext: { delegationDepth: depth, recentActionTimes: ctx.recentActionTimes },
    });

    // Caveats added by delegation hops (beyond the root's) are conjunctive too.
    if (leaf) {
      const extra = leaf.caveats.slice(opts.grant.caveats.length);
      const cv = evaluateCaveats(extra, {
        now,
        blastRadius: risk.blastRadius,
        reversibilityClass: reversibility,
        delegationDepth: depth,
        recentActionTimes: ctx.recentActionTimes,
      });
      if (cv.ok) checks.delegated_caveats = 'pass';
      else fail('delegated_caveats', `delegation caveat(s) not satisfied: ${cv.failed.join(', ')}`);
    }

    if (d.releaseGuardianShare) checks.policy = 'pass';
    else {
      checks.policy = 'fail';
      reasons.push(...d.reasons.map((x) => `policy: ${x}`));
    }
    if (d.releaseGuardianShare) {
      // informational reasons (step-up, assumed worst case) are kept even when released
      reasons.push(...d.reasons.map((x) => `policy: ${x}`));
    }

    // Threshold: t > 1 needs a proof we can only get from an enforced threshold hook.
    const th = checks.threshold;
    if (d.requiredThreshold.t > 1 && d.releaseGuardianShare && th !== 'pass') {
      fail(
        'threshold',
        th === 'fail'
          ? `t=${d.requiredThreshold.t} required and the threshold proof was rejected`
          : `t=${d.requiredThreshold.t} (${d.requiredThreshold.proof}) required but no threshold verifier is enforced`,
      );
    }

    const allow =
      !Object.values(checks).includes('fail') && d.releaseGuardianShare && core.allow;
    if (allow) {
      return { allow, r: d.r, requiredThreshold: d.requiredThreshold, checks, reasons, budget: ctx.budget ? d.budget : undefined };
    }
    if (reasons.length === 0) reasons.push('denied');
    return { allow: false, r: d.r, requiredThreshold: d.requiredThreshold, checks, reasons };
  } catch (e) {
    return failClosed(`verifier error (fail closed): ${e instanceof Error ? e.message : 'unknown'}`);
  }
}

/** Without a caller-supplied budget, use a full budget (grant's bMax) so absence does not itself deny. */
function decideBudget(grant: Capability, b: TrustBudget, absent: boolean): TrustBudget {
  if (!absent) return b;
  const bMax = readEnvelope(grant)?.risk_policy.bMax;
  return { ...b, B: typeof bMax === 'number' && Number.isFinite(bMax) ? bMax : 0 };
}

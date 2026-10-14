import { randomBytes } from '@noble/hashes/utils';
import { b64u, canonicalize, hashCanonical } from './hash';
import { mintRoot, type Capability, type Caveat } from './capability';
import type { Predicate } from './predicates';
import { validateRiskPolicy, type RiskPolicy } from './risk';

/**
 * Policy envelope + Root Intent Grant (spec §5.1). The grant is a plain M0 root Capability whose
 * first caveat of type `envelope` carries the whole envelope, so it is covered by the root
 * signature and plugs straight into `verifyChain`; tampering with it breaks the signature.
 */

export interface AgentBinding {
  model_allowlist?: string[];
  min_measurement?: string;
  operator?: string;
  /**
   * Optional L0 (M5/M6) pin on the attested model WEIGHTS digest: the set of acceptable
   * `weights_digest` values. A model swap or malicious fine-tune changes the weights digest, so this
   * is what the attestation verifier gates on (see attestation.matchAgentBinding). Omitted => the
   * weights digest is attested and action-bound but not allowlist-gated.
   */
  weights_allowlist?: string[];
}

export interface Envelope {
  goal_commit: string;
  predicates: Predicate[];
  caveats: Caveat[];
  agent_binding: AgentBinding;
  risk_policy: RiskPolicy;
}

export const ENVELOPE_CAVEAT = 'envelope';
const GOAL_DOMAIN = 'atlas-pca/goal/v1\0';

/** Salted commitment to the plaintext goal: base64url(sha256(canonical({d, goal, salt}))). */
export function goalCommitOf(goal: string, salt: string): string {
  return hashCanonical({ d: GOAL_DOMAIN, goal, salt });
}

/** Check that a revealed (goal, salt) opens `commit`. */
export function verifyGoalCommit(commit: string, goal: string, salt: string): boolean {
  return goalCommitOf(goal, salt) === commit;
}

/** JSON-normalize (drops undefined fields) so the envelope is canonicalizable. */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function mintGrant(args: {
  principalSecret: Uint8Array;
  /** b64u */
  principalPublic: string;
  /** b64u holder (agent) key */
  holder: string;
  envelope: Omit<Envelope, 'goal_commit'>;
  /** plaintext goal; only its salted hash goes in the grant */
  goal: string;
  /** optional b64u salt (random 16 bytes if omitted) */
  salt?: string;
}): { grant: Capability; goalCommit: string; goalSalt: string } {
  if (typeof args.goal !== 'string' || args.goal.length === 0) throw new Error('mintGrant: goal required');
  const bad = validateRiskPolicy(args.envelope.risk_policy);
  if (bad) throw new Error(`mintGrant: ${bad}`);
  const goalSalt = args.salt ?? b64u(randomBytes(16));
  const goalCommit = goalCommitOf(args.goal, goalSalt);
  const env: Envelope = plain({
    goal_commit: goalCommit,
    predicates: args.envelope.predicates,
    caveats: args.envelope.caveats,
    agent_binding: args.envelope.agent_binding ?? {},
    risk_policy: args.envelope.risk_policy,
  });
  canonicalize(env); // throws if not canonical-encodable
  const grant = mintRoot({
    principalSecret: args.principalSecret,
    principalPublic: args.principalPublic,
    holder: args.holder,
    caveats: [{ type: ENVELOPE_CAVEAT, ...env }],
  });
  return { grant, goalCommit, goalSalt };
}

/**
 * Extract the envelope: the FIRST `envelope` caveat (the root's; later attenuation can only add
 * caveats, never replace it). Returns null if absent or structurally malformed. Does not verify
 * signatures — run `verifyChain` first.
 */
export function readEnvelope(grant: Capability): Envelope | null {
  try {
    const cv = grant?.caveats?.find((c) => c?.type === ENVELOPE_CAVEAT);
    if (!cv) return null;
    const { type: _t, ...rest } = cv;
    void _t;
    const e = rest as Partial<Envelope>;
    if (typeof e.goal_commit !== 'string') return null;
    if (!Array.isArray(e.predicates) || !Array.isArray(e.caveats)) return null;
    if (e.agent_binding === null || typeof e.agent_binding !== 'object') return null;
    if (validateRiskPolicy(e.risk_policy)) return null;
    return e as Envelope;
  } catch {
    return null;
  }
}

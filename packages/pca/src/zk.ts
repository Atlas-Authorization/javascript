/**
 * §9B — Zero-knowledge proof-of-compliance (intent privacy from the Resource Server).
 *
 * The agent proves "action A is a valid derivation under policy P from committed plan Π" WITHOUT
 * revealing P, Π, or its reasoning to the RS. The RS learns only "authorized" — not why, not what the
 * principal is trying to do. The spec sanctions TWO realizations:
 *
 *   - A real SNARK/STARK over a policy circuit (Groth16/STARK). HONEST SEAM ONLY: we define the
 *     `SnarkBackend` interface and the exact plug-in point (`createZkVerifier({ snarkBackend })`). We
 *     DO NOT implement a proving system — building/auditing a circuit + trusted setup + prover is out
 *     of scope and must not be faked.
 *   - The cheaper ATTESTED-VM equivalent (this file's reference, `createAttestedComplianceProver`): a
 *     trusted attested VM runs the Policy VM `decide` and SIGNS a statement that it yielded release
 *     for the action. This is the spec's "attested-VM equivalent when ZK is too heavy." It gives the
 *     same PRIVACY property — the statement carries only COMMITMENTS (digests) to the policy and plan,
 *     never their plaintext — but a weaker trust model: the RS trusts the prover VM's key, rather than
 *     soundness of a circuit. (A real SNARK removes that trusted party.)
 *
 * The verifier in BOTH modes checks the proof against COMMITMENTS only, so it never needs the
 * plaintext policy or plan. `createZkVerifier` can be given the expected policy commitment(s) as bare
 * hashes — demonstrating that an RS can enforce policy it is not allowed to read.
 */
import { b64u, canonicalBytes, hashCanonical, utf8 } from './hash';
import { publicKeyOf, sign, verifyB64u } from './keys';
import type { Capability } from './capability';
import { type PCActn, type HookResult, type VerifyContext, type ZkVerifier } from './pcactn';
import { type DecideInput, decide } from './policy-vm';

const DOMAIN = 'atlas-pca/zk-compliance/v1\0';

/** Commitment to the policy (what the RS is allowed to KNOW about G, not read): the grant's content address. */
export function policyCommitment(grant: Capability): string {
  // `grant.id` is `hashCanonical(body)` and the body includes the envelope caveat, so it is a binding
  // commitment to the whole policy without exposing predicates/caveats.
  return typeof grant?.id === 'string' ? grant.id : hashCanonical(grant);
}

/** Commitment to the action: content address of the PCActn's action descriptor. */
export function actionCommitment(pcactn: PCActn): string {
  return hashCanonical(pcactn?.action ?? null);
}

/**
 * The statement a compliance proof attests: "action A satisfies policy P over committed plan Π." It
 * carries ONLY commitments — the RS can verify it without learning the plaintext policy or plan.
 */
export interface ComplianceStatement {
  v: 1;
  mode: 'attested-vm';
  /** Commitment to the action proven compliant (`actionCommitment`). */
  action_commit: string;
  /** Commitment to the policy (`policyCommitment` of the grant). */
  policy_commit: string;
  /** Commitment to the committed plan Π (the PCActn's Merkle plan root). */
  plan_commit: string;
  /** The fact proven: the Policy VM released the guardian share for the action. Always true (an
   *  un-released action is unprovable). */
  released: true;
  /** The risk `r` the VM computed (public; does not reveal the policy). */
  r: number;
  issued_at: number;
  expires_at: number;
  /** b64u Ed25519 public key of the attested prover VM. */
  prover: string;
  /** b64u Ed25519 signature over the canonical body (all fields except `sig`). */
  sig: string;
}

export type ComplianceStatementBody = Omit<ComplianceStatement, 'sig'>;

function statementMessage(body: ComplianceStatementBody): Uint8Array {
  const d = canonicalBytes(body);
  const p = utf8(DOMAIN);
  const m = new Uint8Array(p.length + d.length);
  m.set(p);
  m.set(d, p.length);
  return m;
}

export interface ProveOpts {
  pcactn: PCActn;
  /** The Policy VM inputs (incl. grant) the prover evaluates. Its grant commits `policy_commit`. */
  decideInput: DecideInput;
  issued_at: number;
  expires_at: number;
}

export interface AttestedComplianceProver {
  /** b64u public key the RS registers in `trustedProverKeys`. */
  readonly publicKey: string;
  /**
   * Run the Policy VM and, IFF it releases the guardian share, emit a signed `ComplianceStatement`
   * committing to the action/policy/plan. Throws if the action is NOT compliant — you cannot prove a
   * false statement.
   */
  prove(opts: ProveOpts): ComplianceStatement;
}

/**
 * The sanctioned ATTESTED-VM reference prover. It is the stand-in for a SNARK prover: instead of a
 * circuit proof it produces a signed attestation (by `attestorSecret`) that an attested VM ran the
 * Policy VM and got `released=true`. Only commitments go into the statement — never the plaintext
 * policy or plan.
 */
export function createAttestedComplianceProver(attestorSecret: Uint8Array): AttestedComplianceProver {
  const publicKey = b64u(publicKeyOf(attestorSecret));
  return {
    publicKey,
    prove(opts: ProveOpts): ComplianceStatement {
      const decision = decide(opts.decideInput);
      if (!decision.releaseGuardianShare) {
        throw new Error(`createAttestedComplianceProver: action is not compliant, nothing to prove (${decision.reasons.join('; ')})`);
      }
      const body: ComplianceStatementBody = {
        v: 1,
        mode: 'attested-vm',
        action_commit: actionCommitment(opts.pcactn),
        policy_commit: policyCommitment(opts.decideInput.grant),
        plan_commit: typeof opts.pcactn?.plan?.root === 'string' ? opts.pcactn.plan.root : '',
        released: true,
        r: decision.r,
        issued_at: opts.issued_at,
        expires_at: opts.expires_at,
        prover: publicKey,
      };
      return { ...body, sig: b64u(sign(attestorSecret, statementMessage(body))) };
    },
  };
}

/**
 * SEAM for a real ZK backend. A production implementation verifies a Groth16/STARK proof against the
 * public inputs (the three commitments) and a verifying key for the policy circuit. Intentionally not
 * implemented here — a proving system must not be faked. Plug it in via
 * `createZkVerifier({ snarkBackend })`; it receives ONLY commitments as public inputs, preserving the
 * privacy property.
 */
export interface SnarkBackend {
  verify(input: {
    /** The opaque proof carried in `pcactn.zk_compliance`. */
    proof: unknown;
    publicInputs: { action_commit: string; policy_commit: string; plan_commit: string };
    ctx: VerifyContext;
  }): boolean | Promise<boolean>;
}

export interface ZkVerifierOpts {
  /** b64u public keys of attested prover VMs trusted in attested-VM mode. */
  trustedProverKeys: string[];
  /**
   * The expected policy commitment(s), as bare hashes. When set, the verifier checks the statement
   * commits to one of these WITHOUT reading any plaintext policy — this is the intent-privacy path.
   * Omitted => the verifier derives the commitment from `ctx.grant` (non-private: the grant is in hand).
   */
  policyCommitments?: string[];
  /** Supplied => delegate proof verification to a real ZK backend (the statement is the proof). */
  snarkBackend?: SnarkBackend;
  /** Clock for freshness, epoch ms (default `Date.now`). */
  now?: () => number;
  /** Allowed clock skew (ms) for issued_at/expires_at (default 0). A statement with
   *  expires_at < issued_at is treated as malformed and rejected. */
  clockSkewMs?: number;
}

/**
 * Build a `ZkVerifier` hook (the §9B/M6 hook in pcactn.ts). The compliance proof is carried in
 * `pcactn.zk_compliance`. The hook BINDS the proof to this action and the committed plan, then:
 *   - SNARK mode (`snarkBackend` supplied): delegate to the backend with the three commitments as
 *     public inputs; accept iff the backend accepts AND the commitments bind to this PCActn/policy.
 *   - attested-VM mode: verify the statement is well-formed, its `prover ∈ trustedProverKeys`, its
 *     signature verifies, it is fresh, and its commitments match (action_commit = this action,
 *     plan_commit = this PCActn's plan root, policy_commit ∈ expected commitments).
 * In BOTH modes the verifier uses only commitments — never the plaintext policy or plan.
 */
export function createZkVerifier(opts: ZkVerifierOpts): ZkVerifier {
  const trusted = new Set(Array.isArray(opts.trustedProverKeys) ? opts.trustedProverKeys : []);
  const expectedPolicy = Array.isArray(opts.policyCommitments) ? new Set(opts.policyCommitments) : undefined;
  const clock = opts.now ?? (() => Date.now());
  const skew = Number.isFinite(opts.clockSkewMs) ? Math.max(0, opts.clockSkewMs as number) : 0;

  return async (ctx: VerifyContext): Promise<HookResult> => {
    const fail = (reason: string): HookResult => ({ enforced: true, ok: false, reason });
    try {
      const proof = ctx?.pcactn?.zk_compliance;
      if (proof === undefined || proof === null) return fail('no zk_compliance proof present');

      const actionCommit = actionCommitment(ctx.pcactn);
      const planCommit = typeof ctx.pcactn?.plan?.root === 'string' ? ctx.pcactn.plan.root : '';
      const wantPolicy = expectedPolicy ?? new Set([policyCommitment(ctx.grant)]);

      // SNARK seam: the proof is opaque; bind the public inputs to THIS action/plan, then delegate.
      if (opts.snarkBackend) {
        // policy_commit for the backend: the single expected commitment (or the grant-derived one).
        const policyCommit = expectedPolicy && expectedPolicy.size === 1 ? [...expectedPolicy][0]! : policyCommitment(ctx.grant);
        const ok = await opts.snarkBackend.verify({
          proof,
          publicInputs: { action_commit: actionCommit, policy_commit: policyCommit, plan_commit: planCommit },
          ctx,
        });
        return ok ? { enforced: true, ok: true } : fail('snark backend rejected the proof');
      }

      // attested-VM mode: the proof IS a ComplianceStatement.
      const st = proof as Partial<ComplianceStatement>;
      if (st.v !== 1 || st.mode !== 'attested-vm') return fail('unrecognized compliance statement');
      if (st.released !== true) return fail('statement does not assert release');
      if (typeof st.prover !== 'string' || !trusted.has(st.prover)) return fail('prover key is not trusted');

      const { sig, ...body } = st as ComplianceStatement;
      if (typeof sig !== 'string' || !verifyB64u(st.prover, statementMessage(body as ComplianceStatementBody), sig)) {
        return fail('compliance statement signature does not verify');
      }

      // freshness
      if (!Number.isFinite(st.issued_at) || !Number.isFinite(st.expires_at) || (st.expires_at as number) < (st.issued_at as number)) {
        return fail('malformed statement validity window');
      }
      const nowMs = clock();
      if (nowMs + skew < (st.issued_at as number)) return fail('compliance statement not yet valid');
      if (nowMs - skew > (st.expires_at as number)) return fail('compliance statement expired');

      // commitment binding — the ONLY policy/plan knowledge the verifier needs is these hashes.
      if (st.action_commit !== actionCommit) return fail('statement does not bind to this action');
      if (st.plan_commit !== planCommit) return fail('statement does not bind to this plan commitment');
      if (typeof st.policy_commit !== 'string' || !wantPolicy.has(st.policy_commit)) {
        return fail('statement policy commitment is not an expected policy');
      }

      return { enforced: true, ok: true };
    } catch (e) {
      return fail(`zk verification error (fail closed): ${e instanceof Error ? e.message : 'unknown'}`);
    }
  };
}

/** Convenience: the policy commitment an RS pins when it is NOT allowed to read the grant's plaintext. */
export function pinnedPolicyCommitment(grant: Capability): string {
  return policyCommitment(grant);
}

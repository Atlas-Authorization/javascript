/**
 * L0 — Attestation-derived workload identity for AI agents (spec §6 L0, Deep Dive I rows
 * "Model swap / malicious fine-tune" and "Agent RCE / key extraction").
 *
 * The spec's L0 says the agent has NO long-lived key: its per-epoch identity key is derived inside a
 * TEE from a remote-attestation quote that measures `model id + weights digest + runtime measurement
 * + operator identity`. Swap the model, tamper the runtime, or change the operator and the
 * measurement changes, so the identity evaporates. This module is the PROTOCOL + verifier for that
 * quote, with two honest modes:
 *
 *   - SOFTWARE mode (this file, `createDevAttestor`): a signed `AttestationDocument`. This is a real,
 *     checkable attestation for dev, CI and the "attested-VM equivalent" the spec sanctions — but the
 *     measurements are SELF-ASSERTED by the signer, not rooted in hardware. It proves "a key the RS
 *     trusts vouched for these measurements", NOT "this silicon is running exactly these weights".
 *   - HARDWARE mode (the `HardwareAttestationVerifier` seam): real SEV-SNP / TDX / SGX report
 *     verification (cert-chain to the CPU vendor root, measurement register checks, report_data/nonce
 *     binding). We deliberately DO NOT implement SEV-SNP/TDX quote parsing here — that is a large,
 *     vendor-specific, security-critical surface. We define the interface and the exact place it
 *     plugs in; `hardwareVerifier.verify()` returns the HARDWARE-measured identity, which then feeds
 *     the same freshness / nonce-binding / agent_binding checks as software mode. A production AMD
 *     SEV-SNP backend for this seam lives in `hardware-sevsnp.ts` (`createSevSnpVerifier`): it parses
 *     the ATTESTATION_REPORT, verifies the ECDSA-P384 report signature + the VCEK→ASK→ARK cert chain
 *     to a configured ARK trust anchor, and binds report_data to the nonce. Wire it in via
 *     `createAttestationVerifier({ hardwareVerifier: createSevSnpVerifier(...) })`.
 *
 * STANDARDIZATION GAP (spec §15 "Open problems" — "Standardizing weights-level attestation for hosted
 * models"): there is today NO cross-vendor standard for attesting a model's WEIGHTS digest from inside
 * a TEE. SEV-SNP/TDX attest the launch measurement of the confidential VM image, not "these specific
 * fp16 weights are loaded." Closing that gap needs either (a) the model runtime to measure the loaded
 * weights into a PCR/report_data field, or (b) a signed weights manifest the enclave verifies at load.
 * Until that exists, `weights_digest` here is attested by whatever produced the document (the model
 * host / operator) and is only as strong as that signer. `weights_allowlist` on the agent_binding is
 * the policy hook for pinning it once the measurement is trustworthy.
 */
import { b64u, canonicalBytes, hashCanonical, utf8 } from './hash';
import { publicKeyOf, sign, verifyB64u } from './keys';
import type { AgentBinding } from './envelope';
import { readEnvelope } from './envelope';
import type { AttestationVerifier, HookResult, VerifyContext } from './pcactn';

const DOMAIN = 'atlas-pca/attest/v1\0';

/** Attestation mode. `software` = signed self-asserted doc; `hardware` = TEE-report-rooted. */
export type AttestationMode = 'software' | 'hardware';

/**
 * A remote-attestation document (the "quote" of spec §7's `attestation.quote_digest`). In software
 * mode it is signed by a `DevAttestor`; in hardware mode the same shape carries the fields a TEE
 * report yields, and the `HardwareAttestationVerifier` roots them in silicon.
 */
export interface AttestationDocument {
  /** Attested model identifier (matched against agent_binding.model_allowlist). */
  model_id: string;
  /** Digest of the loaded model weights (the field that moves on a model swap / fine-tune). */
  weights_digest: string;
  /** Runtime/launch measurement (matched against agent_binding.min_measurement). */
  runtime_measurement: string;
  /** Operator identity (matched against agent_binding.operator). */
  operator: string;
  /**
   * Freshness/anti-replay challenge echoed into the quote. The PCActn binds to THIS document by
   * carrying `nonce` in its `attestation.quote_digest` field (see `nonceBinds`); a tampered nonce on
   * either side breaks the binding. In a real TEE this is the quote's report_data.
   */
  nonce: string;
  /** Issued-at (epoch ms). */
  issued_at: number;
  /** Expiry (epoch ms). Short-lived: L0 epochs are short and re-derived. */
  expires_at: number;
  /** b64u Ed25519 public key that signed this document (software mode). */
  attestor: string;
  /** Attestation mode this document claims. */
  mode: AttestationMode;
  /** b64u Ed25519 signature over the canonical body (all fields except `sig`). */
  sig: string;
}

export type AttestationBody = Omit<AttestationDocument, 'sig'>;

function attestMessage(body: AttestationBody): Uint8Array {
  const d = canonicalBytes(body);
  const p = utf8(DOMAIN);
  const m = new Uint8Array(p.length + d.length);
  m.set(p);
  m.set(d, p.length);
  return m;
}

/** base64url(sha256(canonical(document))) — a content address for the full signed quote. */
export function attestationDigest(doc: AttestationDocument): string {
  return hashCanonical(doc);
}

/** The claims a caller supplies to mint a document (everything but the signature/attestor/mode). */
export interface AttestationClaims {
  model_id: string;
  weights_digest: string;
  runtime_measurement: string;
  operator: string;
  nonce: string;
  issued_at: number;
  expires_at: number;
}

export interface DevAttestor {
  /** b64u public key clients register in `trustedAttestorKeys`. */
  readonly publicKey: string;
  /** Sign a SOFTWARE-mode attestation document over the given claims. */
  attest(claims: AttestationClaims): AttestationDocument;
}

/**
 * A SOFTWARE-mode attestor for dev + CI: it signs `AttestationDocument`s with `secret`. This is the
 * sanctioned software/attested reference, NOT a hardware root of trust — see the file header. The RS
 * trusts a dev attestor by putting its `publicKey` in `createAttestationVerifier({ trustedAttestorKeys })`.
 */
export function createDevAttestor(secret: Uint8Array): DevAttestor {
  const publicKey = b64u(publicKeyOf(secret));
  return {
    publicKey,
    attest(claims: AttestationClaims): AttestationDocument {
      const body: AttestationBody = {
        model_id: claims.model_id,
        weights_digest: claims.weights_digest,
        runtime_measurement: claims.runtime_measurement,
        operator: claims.operator,
        nonce: claims.nonce,
        issued_at: claims.issued_at,
        expires_at: claims.expires_at,
        attestor: publicKey,
        mode: 'software',
      };
      return { ...body, sig: b64u(sign(secret, attestMessage(body))) };
    },
  };
}

/** The identity a verifier (software or hardware) establishes for a document. */
export interface MeasuredIdentity {
  model_id: string;
  weights_digest: string;
  runtime_measurement: string;
  operator: string;
}

export interface HardwareAttestationResult {
  ok: boolean;
  reason?: string;
  /**
   * The HARDWARE-measured identity. When present the verifier matches THIS against agent_binding
   * (never the document's self-asserted fields), so a lying document cannot pass a real TEE check.
   */
  measured?: MeasuredIdentity;
}

/**
 * SEAM for real TEE attestation. A production implementation parses a SEV-SNP / TDX / SGX report:
 * verifies the vendor cert chain to the CPU root, checks the launch/measurement registers, confirms
 * the report_data binds the expected nonce, and returns the measured identity. Intentionally not
 * implemented in THIS file (vendor-specific, security-critical). The AMD SEV-SNP implementation is in
 * `hardware-sevsnp.ts` (`createSevSnpVerifier`). Plug it in via
 * `createAttestationVerifier({ hardwareVerifier })`.
 */
export interface HardwareAttestationVerifier {
  verify(input: {
    document: AttestationDocument;
    ctx: VerifyContext;
    nowMs: number;
  }): HardwareAttestationResult | Promise<HardwareAttestationResult>;
}

/**
 * Resolve the full `AttestationDocument` for an action. The RS caches attestation quotes per epoch
 * (they are not per-action); the hook finds the one this PCActn binds to. `attestationRegistry`
 * builds the common resolver (index by nonce, match the PCActn's `attestation.quote_digest`).
 */
export type AttestationResolver = (ctx: VerifyContext) => AttestationDocument | undefined;

/**
 * A resolver over a set of known-good documents: it returns the document whose `nonce` equals the
 * PCActn's `attestation.quote_digest` (the action's declared attestation binding). Later duplicates
 * for a nonce overwrite earlier ones.
 */
export function attestationRegistry(docs: AttestationDocument[]): AttestationResolver {
  const byNonce = new Map<string, AttestationDocument>();
  for (const d of Array.isArray(docs) ? docs : []) {
    if (d && typeof d.nonce === 'string') byNonce.set(d.nonce, d);
  }
  return (ctx) => {
    const key = ctx?.pcactn?.attestation?.quote_digest;
    return typeof key === 'string' ? byNonce.get(key) : undefined;
  };
}

export interface AttestationVerifierOpts {
  /** b64u public keys trusted to sign SOFTWARE-mode documents. */
  trustedAttestorKeys: string[];
  /** Supplied => HARDWARE mode: delegate authenticity to this verifier instead of the signature. */
  hardwareVerifier?: HardwareAttestationVerifier;
  /** How to find the document for an action (default: `attestationRegistry([])` — resolves nothing). */
  resolveDocument?: AttestationResolver;
  /** Clock for freshness, epoch ms (default `Date.now`). Injectable for determinism. */
  now?: () => number;
  /** Allowed clock skew (ms) applied to issued_at/expires_at (default 0). */
  clockSkewMs?: number;
}

/** True iff `doc.nonce` is the nonce the PCActn declares in `attestation.quote_digest`. */
export function nonceBinds(doc: AttestationDocument, ctx: VerifyContext): boolean {
  return typeof doc?.nonce === 'string' && doc.nonce === ctx?.pcactn?.attestation?.quote_digest;
}

/** Match a measured identity against the grant's agent_binding. Returns a reason on failure, else null. */
export function matchAgentBinding(id: MeasuredIdentity, binding: AgentBinding | undefined): string | null {
  const b = binding ?? {};
  if (Array.isArray(b.model_allowlist) && b.model_allowlist.length > 0 && !b.model_allowlist.includes(id.model_id)) {
    return `model_id ${id.model_id} not in model_allowlist`;
  }
  // `min_measurement` is an opaque launch measurement: matched for EQUALITY (the pinned acceptable
  // measurement). A real deployment compares against a signed measurement ladder / allowlist; that is
  // the seam. Opaque hashes have no numeric ordering, so "min" here means "the required value".
  if (typeof b.min_measurement === 'string' && b.min_measurement.length > 0 && id.runtime_measurement !== b.min_measurement) {
    return `runtime_measurement does not match required min_measurement`;
  }
  if (typeof b.operator === 'string' && b.operator.length > 0 && id.operator !== b.operator) {
    return `operator ${id.operator} is not the bound operator`;
  }
  if (Array.isArray(b.weights_allowlist) && b.weights_allowlist.length > 0 && !b.weights_allowlist.includes(id.weights_digest)) {
    return `weights_digest not in weights_allowlist (model swap / fine-tune?)`;
  }
  return null;
}

/**
 * Build an `AttestationVerifier` hook (the L0/M5 hook in pcactn.ts). Given a PCActn it:
 *  1. resolves the full `AttestationDocument` for the action (default: none => fail: no attestation);
 *  2. ESTABLISHES IDENTITY:
 *       - hardware mode (`hardwareVerifier` supplied): delegate; use the hardware-measured identity;
 *       - software mode: verify `mode === 'software'`, `attestor ∈ trustedAttestorKeys`, and the
 *         Ed25519 signature; use the document's (now authenticated) fields as the identity;
 *  3. FRESHNESS: now ∈ [issued_at − skew, expires_at + skew];
 *  4. NONCE BINDING: the document's nonce is the one the PCActn declares (`nonceBinds`);
 *  5. AGENT_BINDING: the established identity satisfies the grant envelope's agent_binding
 *     (model_allowlist / min_measurement / operator / weights_allowlist).
 * Any failed step returns an ENFORCED rejection with a reason.
 */
export function createAttestationVerifier(opts: AttestationVerifierOpts): AttestationVerifier {
  const trusted = new Set(Array.isArray(opts.trustedAttestorKeys) ? opts.trustedAttestorKeys : []);
  const resolve = opts.resolveDocument ?? attestationRegistry([]);
  const clock = opts.now ?? (() => Date.now());
  const skew = Number.isFinite(opts.clockSkewMs) ? Math.max(0, opts.clockSkewMs as number) : 0;

  return async (ctx: VerifyContext): Promise<HookResult> => {
    const fail = (reason: string): HookResult => ({ enforced: true, ok: false, reason });
    try {
      const doc = resolve(ctx);
      if (!doc || typeof doc !== 'object') return fail('no attestation document for this action');

      const nowMs = clock();

      // (2) establish identity
      let identity: MeasuredIdentity;
      if (opts.hardwareVerifier) {
        const hw = await opts.hardwareVerifier.verify({ document: doc, ctx, nowMs });
        if (!hw.ok) return fail(`hardware attestation rejected: ${hw.reason ?? 'invalid'}`);
        identity = hw.measured ?? {
          model_id: doc.model_id,
          weights_digest: doc.weights_digest,
          runtime_measurement: doc.runtime_measurement,
          operator: doc.operator,
        };
      } else {
        if (doc.mode !== 'software') return fail(`document mode ${String(doc.mode)} needs a hardwareVerifier`);
        if (typeof doc.attestor !== 'string' || !trusted.has(doc.attestor)) {
          return fail('attestor key is not trusted');
        }
        const { sig, ...body } = doc;
        if (typeof sig !== 'string' || !verifyB64u(doc.attestor, attestMessage(body), sig)) {
          return fail('attestation signature does not verify');
        }
        identity = {
          model_id: doc.model_id,
          weights_digest: doc.weights_digest,
          runtime_measurement: doc.runtime_measurement,
          operator: doc.operator,
        };
      }

      // (3) freshness
      if (!Number.isFinite(doc.issued_at) || !Number.isFinite(doc.expires_at) || doc.expires_at < doc.issued_at) {
        return fail('malformed attestation validity window');
      }
      if (nowMs + skew < doc.issued_at) return fail('attestation not yet valid');
      if (nowMs - skew > doc.expires_at) return fail('attestation expired');

      // (4) nonce binding to the PCActn
      if (!nonceBinds(doc, ctx)) return fail('attestation nonce does not bind to this PCActn');

      // (5) agent_binding
      const env = readEnvelope(ctx.grant);
      const bindErr = matchAgentBinding(identity, env?.agent_binding);
      if (bindErr) return fail(bindErr);

      return { enforced: true, ok: true };
    } catch (e) {
      return fail(`attestation verification error (fail closed): ${e instanceof Error ? e.message : 'unknown'}`);
    }
  };
}

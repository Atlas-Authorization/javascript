/**
 * L0 HARDWARE backend — AMD SEV-SNP attestation report VERIFIER.
 *
 * This is the production implementation of the `HardwareAttestationVerifier` seam declared in
 * attestation.ts. Where the software mode trusts a key that VOUCHED for self-asserted measurements,
 * this module roots the identity in silicon: it parses an AMD SEV-SNP `ATTESTATION_REPORT`, verifies
 * its ECDSA-P384 signature with the VCEK public key, verifies the VCEK→ASK→ARK certificate chain up
 * to a configured ARK trust anchor, and confirms the report's `report_data` cryptographically binds
 * the PCActn's attestation nonce. The HARDWARE-measured identity it returns then flows through the
 * same freshness / nonce / agent_binding gates in `createAttestationVerifier`, so a lying document
 * cannot pass a genuine hardware check.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS CRYPTOGRAPHICALLY VERIFIED HERE (real crypto, exercised end-to-end by the tests):
 *   1. ECDSA-P384 / SHA-384 signature over the report's signed region [0x000, 0x2A0) using the VCEK
 *      public key. AMD stores the signature as little-endian r‖s (72-byte fields); we convert to the
 *      big-endian scalar form @noble/curves expects.
 *   2. The VCEK→ASK→ARK chain: VCEK's TBS is ECDSA-P384-signed by ASK, ASK's TBS by ARK, and the ARK
 *      public key byte-equals the configured `trustAnchorArk`. Fail-closed on any broken link.
 *   3. report_data binds the expected nonce (default: SHA-512(nonce) === report_data; overridable).
 *   4. Policy gates on the verified MEASUREMENT / CHIP_ID / TCB / VMPL / GUEST_SVN.
 *
 * WHAT IS AN EXPLICIT, DOCUMENTED SEAM (NOT implemented here — do not hand-roll it):
 *   • X.509 / PEM certificate DECODING. `SevSnpCertChain` is supplied as ALREADY-PARSED EC public keys
 *     plus the raw TBS bytes and signatures to check. Production obtains these by decoding the genuine
 *     AMD VCEK / ASK / ARK certificates with a vetted X.509 library (e.g. @peculiar/x509): extract each
 *     cert's SubjectPublicKeyInfo EC point, its `tbsCertificate` DER bytes, and its signatureValue, and
 *     map them into the fields below. We deliberately do NOT parse ASN.1/DER here — a full X.509 parser
 *     is a large, security-critical surface that belongs in an audited dependency.
 *   • AMD KDS fetching. Genuine VCEK/ASK/ARK certs are fetched from the AMD Key Distribution Service
 *     (https://kdsintf.amd.com/vcek/v1/...) keyed by CHIP_ID + reported TCB. The `kdsFetch` hook is the
 *     place that goes; it is never called unless you supply it, and this module does no network I/O.
 *   • The raw report bytes + the parsed chain for a given action are produced by `resolveEvidence`
 *     (the evidence seam). A real deployment carries the base64 report + cert bundle alongside the
 *     attestation document (or fetches the certs via `kdsFetch`) and hands back `SevSnpEvidence`.
 *
 * STANDARDIZATION GAP (unchanged from attestation.ts header): SEV-SNP attests the confidential-VM
 * LAUNCH measurement, not the loaded model weights. The MEASUREMENT register and CHIP_ID are
 * hardware-authoritative; `model_id` / `weights_digest` / `operator` are not fields a raw SEV-SNP
 * report carries, so `deriveIdentity` maps them from launch-bound fields (HOST_DATA for the owner's
 * weights/manifest commitment, CHIP_ID for the hardware operator) — honest about what hardware can and
 * cannot prove. Override `deriveIdentity` to match your launch convention.
 *
 * References: AMD SEV-SNP ABI Specification (Rev. 1.55+), "ATTESTATION_REPORT Structure" and
 * "ECDSA_P384_SHA384 Signature" tables; AMD KDS interface documentation.
 */
import { sha384, sha512 } from '@noble/hashes/sha512';
import { p384 } from '@noble/curves/p384';
import { b64u } from './hash';
import type {
  AttestationDocument,
  HardwareAttestationResult,
  HardwareAttestationVerifier,
  MeasuredIdentity,
} from './attestation';
import type { VerifyContext } from './pcactn';

// ════════════════════════════════════════════════════════════════════════════════════════════════
// ATTESTATION_REPORT binary layout — AMD SEV-SNP ABI Specification, "ATTESTATION_REPORT Structure".
// All multi-byte integers are LITTLE-ENDIAN. Byte offsets are quoted from the spec.
// ════════════════════════════════════════════════════════════════════════════════════════════════
const OFF = {
  VERSION: 0x000, //            u32   report format version (>= 2 for the layout below)
  GUEST_SVN: 0x004, //          u32   guest security version
  POLICY: 0x008, //             u64   guest policy
  FAMILY_ID: 0x010, //          16 B  guest family id
  IMAGE_ID: 0x020, //           16 B  guest image id
  VMPL: 0x030, //               u32   VMPL the report was requested at
  SIGNATURE_ALGO: 0x034, //     u32   1 = ECDSA_P384_SHA384
  CURRENT_TCB: 0x038, //        u64   current TCB version
  PLATFORM_INFO: 0x040, //      u64   platform info (SMT / TSME ...)
  // 0x048 u32 flags (AUTHOR_KEY_EN bit0, MASK_CHIP_KEY bit1, SIGNING_KEY bits4:2); 0x04C u32 reserved
  REPORT_DATA: 0x050, //        64 B  guest-supplied data — the nonce binding lives here
  MEASUREMENT: 0x090, //        48 B  launch measurement (hardware-authoritative)
  HOST_DATA: 0x0c0, //          32 B  data the host/owner supplied at launch
  ID_KEY_DIGEST: 0x0e0, //      48 B  SHA-384 of the ID key
  AUTHOR_KEY_DIGEST: 0x110, //  48 B  SHA-384 of the author key (zero if AUTHOR_KEY_EN=0)
  REPORT_ID: 0x140, //          32 B  report id
  REPORT_ID_MA: 0x160, //       32 B  report id of the migration agent
  REPORTED_TCB: 0x180, //       u64   reported TCB version
  // 0x188 reserved (24 B)
  CHIP_ID: 0x1a0, //            64 B  unique chip id (hardware operator identity)
  // ... reserved / build fields ...
  SIGNED_END: 0x2a0, //         signed region is [0x000, 0x2A0)
  SIG_R: 0x2a0, //              72 B  signature r, LITTLE-ENDIAN (P-384 uses the low 48 B)
  SIG_S: 0x2e8, //              72 B  signature s, LITTLE-ENDIAN
  REPORT_LEN: 0x4a0, //         1184  canonical report size (signature block is 0x2A0..0x4A0)
} as const;

/** The SIGNATURE_ALGO value for ECDSA over P-384 with SHA-384 (the only algo SEV-SNP uses today). */
export const SEV_SNP_SIG_ALGO_ECDSA_P384_SHA384 = 1;

/** A fully parsed AMD SEV-SNP `ATTESTATION_REPORT`. Byte-array fields are fresh copies. */
export interface ParsedSevSnpReport {
  version: number;
  guest_svn: number;
  policy: bigint;
  family_id: Uint8Array; // 16
  image_id: Uint8Array; // 16
  vmpl: number;
  signature_algo: number;
  current_tcb: bigint;
  platform_info: bigint;
  report_data: Uint8Array; // 64
  measurement: Uint8Array; // 48
  host_data: Uint8Array; // 32
  id_key_digest: Uint8Array; // 48
  author_key_digest: Uint8Array; // 48
  report_id: Uint8Array; // 32
  report_id_ma: Uint8Array; // 32
  reported_tcb: bigint;
  chip_id: Uint8Array; // 64
  /** AMD's little-endian r‖s, each a 72-byte field exactly as it sits in the report. */
  signature: { r: Uint8Array; s: Uint8Array };
  /** The signed region, report bytes [0x000, 0x2A0). The ECDSA signature is over SHA-384 of this. */
  signed: Uint8Array;
  /** The full report bytes (a copy). */
  raw: Uint8Array;
}

function u32le(dv: DataView, off: number): number {
  return dv.getUint32(off, true);
}
function u64le(dv: DataView, off: number): bigint {
  return dv.getBigUint64(off, true);
}
function slice(bytes: Uint8Array, off: number, len: number): Uint8Array {
  return bytes.slice(off, off + len);
}

/** Interpret a little-endian byte array as a non-negative bigint. */
function leToBigInt(le: Uint8Array): bigint {
  let n = 0n;
  for (let i = le.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(le[i]!);
  return n;
}

/** Lowercase hex of a byte array (stable identity string for measurement / chip_id / host_data). */
export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}

/**
 * Parse the AMD SEV-SNP `ATTESTATION_REPORT` binary layout (see `OFF` above). Throws on a buffer too
 * short to contain the signed region and the r/s signature fields. Does NOT verify anything — call
 * `verifySevSnpReportSignature` and the chain checks for that.
 */
export function parseSevSnpReport(bytes: Uint8Array): ParsedSevSnpReport {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('parseSevSnpReport: expected Uint8Array');
  const minLen = OFF.SIG_S + 72; // everything up to and including s must be present
  if (bytes.length < minLen) {
    throw new RangeError(`parseSevSnpReport: report too short (${bytes.length} < ${minLen})`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: u32le(dv, OFF.VERSION),
    guest_svn: u32le(dv, OFF.GUEST_SVN),
    policy: u64le(dv, OFF.POLICY),
    family_id: slice(bytes, OFF.FAMILY_ID, 16),
    image_id: slice(bytes, OFF.IMAGE_ID, 16),
    vmpl: u32le(dv, OFF.VMPL),
    signature_algo: u32le(dv, OFF.SIGNATURE_ALGO),
    current_tcb: u64le(dv, OFF.CURRENT_TCB),
    platform_info: u64le(dv, OFF.PLATFORM_INFO),
    report_data: slice(bytes, OFF.REPORT_DATA, 64),
    measurement: slice(bytes, OFF.MEASUREMENT, 48),
    host_data: slice(bytes, OFF.HOST_DATA, 32),
    id_key_digest: slice(bytes, OFF.ID_KEY_DIGEST, 48),
    author_key_digest: slice(bytes, OFF.AUTHOR_KEY_DIGEST, 48),
    report_id: slice(bytes, OFF.REPORT_ID, 32),
    report_id_ma: slice(bytes, OFF.REPORT_ID_MA, 32),
    reported_tcb: u64le(dv, OFF.REPORTED_TCB),
    chip_id: slice(bytes, OFF.CHIP_ID, 64),
    signature: { r: slice(bytes, OFF.SIG_R, 72), s: slice(bytes, OFF.SIG_S, 72) },
    signed: slice(bytes, 0, OFF.SIGNED_END),
    raw: bytes.slice(),
  };
}

/**
 * Serialize a report back to its binary layout. Primarily a TOOLING / TEST utility (the inverse of
 * `parseSevSnpReport`, keeping the field offsets in one place); production only ever PARSES reports
 * produced by real hardware. Fields default to zero; byte fields are left-padded/truncated to size.
 */
export function serializeSevSnpReport(
  fields: Partial<{
    version: number;
    guest_svn: number;
    policy: bigint;
    family_id: Uint8Array;
    image_id: Uint8Array;
    vmpl: number;
    signature_algo: number;
    current_tcb: bigint;
    platform_info: bigint;
    report_data: Uint8Array;
    measurement: Uint8Array;
    host_data: Uint8Array;
    id_key_digest: Uint8Array;
    author_key_digest: Uint8Array;
    report_id: Uint8Array;
    report_id_ma: Uint8Array;
    reported_tcb: bigint;
    chip_id: Uint8Array;
    signature: { r: Uint8Array; s: Uint8Array };
  }>,
): Uint8Array {
  const out = new Uint8Array(OFF.REPORT_LEN);
  const dv = new DataView(out.buffer);
  const put = (off: number, len: number, src?: Uint8Array) => {
    if (!src) return;
    out.set(src.subarray(0, len), off);
  };
  dv.setUint32(OFF.VERSION, fields.version ?? 2, true);
  dv.setUint32(OFF.GUEST_SVN, fields.guest_svn ?? 0, true);
  dv.setBigUint64(OFF.POLICY, fields.policy ?? 0n, true);
  put(OFF.FAMILY_ID, 16, fields.family_id);
  put(OFF.IMAGE_ID, 16, fields.image_id);
  dv.setUint32(OFF.VMPL, fields.vmpl ?? 0, true);
  dv.setUint32(OFF.SIGNATURE_ALGO, fields.signature_algo ?? SEV_SNP_SIG_ALGO_ECDSA_P384_SHA384, true);
  dv.setBigUint64(OFF.CURRENT_TCB, fields.current_tcb ?? 0n, true);
  dv.setBigUint64(OFF.PLATFORM_INFO, fields.platform_info ?? 0n, true);
  put(OFF.REPORT_DATA, 64, fields.report_data);
  put(OFF.MEASUREMENT, 48, fields.measurement);
  put(OFF.HOST_DATA, 32, fields.host_data);
  put(OFF.ID_KEY_DIGEST, 48, fields.id_key_digest);
  put(OFF.AUTHOR_KEY_DIGEST, 48, fields.author_key_digest);
  put(OFF.REPORT_ID, 32, fields.report_id);
  put(OFF.REPORT_ID_MA, 32, fields.report_id_ma);
  dv.setBigUint64(OFF.REPORTED_TCB, fields.reported_tcb ?? 0n, true);
  put(OFF.CHIP_ID, 64, fields.chip_id);
  if (fields.signature) {
    put(OFF.SIG_R, 72, fields.signature.r);
    put(OFF.SIG_S, 72, fields.signature.s);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// EC public keys + signature primitives (P-384 / SHA-384).
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * A P-384 public key, carried as the uncompressed SEC1 point encoding (`0x04 ‖ X(48) ‖ Y(48)`, 97
 * bytes). Production decodes this out of an X.509 SubjectPublicKeyInfo with a vetted library and calls
 * `ecdsaP384PublicKey` — see the module header's X.509 SEAM note.
 */
export interface EcdsaP384PublicKey {
  /** Uncompressed SEC1 point bytes: 0x04 ‖ X(48) ‖ Y(48). */
  readonly point: Uint8Array;
}

/**
 * Wrap/validate a P-384 public key. Accepts the uncompressed (97-byte) or compressed (49-byte) SEC1
 * encoding; normalizes to uncompressed. Throws if the bytes are not a valid curve point.
 */
export function ecdsaP384PublicKey(sec1: Uint8Array): EcdsaP384PublicKey {
  const pt = p384.ProjectivePoint.fromHex(sec1); // throws on an off-curve / malformed point
  return { point: pt.toRawBytes(false) };
}

/**
 * Convert AMD's little-endian r‖s (72-byte fields) into the big-endian compact (r‖s, 96-byte) form
 * @noble/curves expects. The P-384 scalars occupy the low 48 bytes; the remaining field bytes must be
 * zero. Throws if r or s is zero or ≥ curve order (a structurally invalid signature).
 */
export function sevSnpSignatureToCompact(sig: { r: Uint8Array; s: Uint8Array }): Uint8Array {
  const n = p384.CURVE.n;
  const r = leToBigInt(sig.r);
  const s = leToBigInt(sig.s);
  if (r <= 0n || r >= n) throw new RangeError('sev-snp signature: r out of range');
  if (s <= 0n || s >= n) throw new RangeError('sev-snp signature: s out of range');
  return new p384.Signature(r, s).toCompactRawBytes();
}

/**
 * Verify the report's ECDSA-P384/SHA-384 signature over its signed region [0x000, 0x2A0) with the VCEK
 * public key. Never throws: a malformed signature or key simply returns false (fail closed).
 */
export function verifySevSnpReportSignature(report: ParsedSevSnpReport, vcek: EcdsaP384PublicKey): boolean {
  try {
    const digest = sha384(report.signed);
    const compact = sevSnpSignatureToCompact(report.signature);
    // lowS:false — ECDSA validity does not require a low-S value, and AMD hardware does not normalize.
    return p384.verify(compact, digest, vcek.point, { lowS: false });
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Certificate chain (VCEK → ASK → ARK). X.509 decoding / KDS fetching are the documented SEAM; this
// module checks the cryptographic signature RELATIONSHIPS given already-parsed inputs.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The AMD cert chain as ALREADY-PARSED inputs. Each link carries the signer-independent "to be signed"
 * bytes (`*_tbs`, the X.509 tbsCertificate DER) and the ECDSA-P384 signature over SHA-384 of them
 * (`*_sig`, big-endian compact r‖s, 96 bytes). Production fills this by X.509-decoding the genuine AMD
 * VCEK / ASK / ARK certificates (see the module header). The ARK public key must equal the configured
 * `trustAnchorArk`; it is the root of trust, never taken from the chain itself.
 */
export interface SevSnpCertChain {
  /** AMD Root Key public key — compared for equality against the configured trust anchor. */
  ark: EcdsaP384PublicKey;
  /** AMD SEV Key (intermediate) public key — must be signed by ARK. */
  ask: EcdsaP384PublicKey;
  /** Versioned Chip Endorsement Key (leaf) public key — must be signed by ASK; signs the report. */
  vcek: EcdsaP384PublicKey;
  /** ASK certificate's tbsCertificate DER bytes (signed by ARK). */
  ask_tbs: Uint8Array;
  /** ECDSA-P384 signature over SHA-384(ask_tbs), big-endian compact r‖s. */
  ask_sig: Uint8Array;
  /** VCEK certificate's tbsCertificate DER bytes (signed by ASK). */
  vcek_tbs: Uint8Array;
  /** ECDSA-P384 signature over SHA-384(vcek_tbs), big-endian compact r‖s. */
  vcek_sig: Uint8Array;
}

/** All the evidence needed to verify one action's attestation: the raw report + its cert chain. */
export interface SevSnpEvidence {
  /** The raw ATTESTATION_REPORT bytes exactly as the hardware emitted them. */
  report: Uint8Array;
  /** The parsed VCEK/ASK/ARK chain (X.509-decoded and/or KDS-fetched — the SEAM). */
  chain: SevSnpCertChain;
}

function pubEq(a: EcdsaP384PublicKey, b: EcdsaP384PublicKey): boolean {
  if (a.point.length !== b.point.length) return false;
  let diff = 0;
  for (let i = 0; i < a.point.length; i++) diff |= a.point[i]! ^ b.point[i]!;
  return diff === 0;
}

function verifyTbsSig(tbs: Uint8Array, sig: Uint8Array, signer: EcdsaP384PublicKey): boolean {
  try {
    return p384.verify(sig, sha384(tbs), signer.point, { lowS: false });
  } catch {
    return false;
  }
}

/** The outcome of chain verification: ok, or a specific reason it failed closed. */
export interface SevSnpChainResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify the SEV-SNP certificate chain cryptographically:
 *   1. the chain's ARK byte-equals the configured `trustAnchorArk` (root of trust is NOT self-asserted);
 *   2. ASK's tbsCertificate is ECDSA-P384-signed by ARK;
 *   3. VCEK's tbsCertificate is ECDSA-P384-signed by ASK.
 * Returns the first failing link's reason. The actual X.509 decode that produced the keys/tbs/sigs is
 * the caller's responsibility (the SEAM) — this checks only the signature relationships.
 */
export function verifyVcekChain(input: { chain: SevSnpCertChain; trustAnchorArk: EcdsaP384PublicKey }): SevSnpChainResult {
  const { chain, trustAnchorArk } = input;
  try {
    if (!pubEq(chain.ark, trustAnchorArk)) return { ok: false, reason: 'ARK does not match the configured trust anchor' };
    if (!verifyTbsSig(chain.ask_tbs, chain.ask_sig, chain.ark)) return { ok: false, reason: 'ASK is not signed by ARK' };
    if (!verifyTbsSig(chain.vcek_tbs, chain.vcek_sig, chain.ask)) return { ok: false, reason: 'VCEK is not signed by ASK' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `chain verification error: ${e instanceof Error ? e.message : 'unknown'}` };
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Policy + identity mapping.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Acceptance policy for a verified report. Every gate is optional; an omitted/empty gate accepts any
 * value. All hex comparisons are lowercase.
 */
export interface SevSnpPolicy {
  /** Allowed MEASUREMENT values (lowercase hex of the 48-byte register). Empty/omitted => accept any. */
  measurements?: string[];
  /** Allowed CHIP_ID values (lowercase hex of the 64-byte id). Empty/omitted => accept any. */
  chipIds?: string[];
  /** Minimum acceptable GUEST_SVN. */
  minGuestSvn?: number;
  /** Minimum acceptable REPORTED_TCB (raw u64). Rejects down-rev / rolled-back TCB. */
  minReportedTcb?: bigint;
  /** Required VMPL the report must have been requested at (e.g. 0). Omitted => accept any. */
  requireVmpl?: number;
  /** Require SIGNATURE_ALGO === ECDSA_P384_SHA384 (default true). */
  requireEcdsaP384?: boolean;
  /**
   * Map a verified report into the `MeasuredIdentity` that `agent_binding` is checked against. Default:
   *   runtime_measurement = hex(MEASUREMENT)  — hardware-authoritative launch measurement
   *   operator            = hex(CHIP_ID)      — hardware operator identity
   *   weights_digest      = hex(HOST_DATA)    — owner's launch-time weights/manifest commitment (seam)
   *   model_id            = ''                — SEV-SNP carries no model id; override to supply one
   * Override to match your launch convention (e.g. a measurement → model_id registry).
   */
  deriveIdentity?: (report: ParsedSevSnpReport) => MeasuredIdentity;
}

function defaultDeriveIdentity(report: ParsedSevSnpReport): MeasuredIdentity {
  return {
    model_id: '',
    weights_digest: toHex(report.host_data),
    runtime_measurement: toHex(report.measurement),
    operator: toHex(report.chip_id),
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The SEV-SNP HardwareAttestationVerifier.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** How the expected 64-byte report_data is derived from the PCActn's attestation nonce. */
export type NonceBinder = (expectedNonce: string) => Uint8Array;

/** Default nonce binding: SHA-512(utf8(nonce)) === report_data (64 bytes exactly). */
export const defaultNonceBinder: NonceBinder = (nonce: string) => sha512(new TextEncoder().encode(nonce));

export interface SevSnpVerifierOptions {
  /** The configured ARK trust anchor. The chain's ARK must byte-equal this; it is the root of trust. */
  trustAnchorArk: EcdsaP384PublicKey;
  /** Acceptance policy for the verified report (measurements, chip ids, TCB floor, VMPL, ...). */
  policy: SevSnpPolicy;
  /** How to derive the expected report_data from the nonce (default: SHA-512(nonce)). */
  nonceBinder?: NonceBinder;
  /**
   * EVIDENCE SEAM: produce the raw report bytes + parsed cert chain for an action. Production reads the
   * base64 report + cert bundle carried with the attestation document, or fetches certs via `kdsFetch`.
   * If omitted, the verifier fails closed (no evidence) — there is no safe default source of a report.
   */
  resolveEvidence?: (
    document: AttestationDocument,
    ctx: VerifyContext,
  ) => SevSnpEvidence | undefined | Promise<SevSnpEvidence | undefined>;
  /**
   * KDS SEAM (optional, documented, NEVER called by this module on its own): fetch the genuine AMD
   * VCEK/ASK/ARK certs from https://kdsintf.amd.com keyed by CHIP_ID + reported TCB, returning a parsed
   * chain. Wire it into your own `resolveEvidence` if you fetch certs lazily.
   */
  kdsFetch?: (chipId: Uint8Array, reportedTcb: bigint) => Promise<SevSnpCertChain>;
}

/** Check the report against the acceptance policy. Returns a reason on the first failure, else null. */
export function checkSevSnpPolicy(report: ParsedSevSnpReport, policy: SevSnpPolicy): string | null {
  if (policy.requireEcdsaP384 !== false && report.signature_algo !== SEV_SNP_SIG_ALGO_ECDSA_P384_SHA384) {
    return `unexpected signature_algo ${report.signature_algo}`;
  }
  if (typeof policy.minGuestSvn === 'number' && report.guest_svn < policy.minGuestSvn) {
    return `guest_svn ${report.guest_svn} below minimum ${policy.minGuestSvn}`;
  }
  if (typeof policy.minReportedTcb === 'bigint' && report.reported_tcb < policy.minReportedTcb) {
    return `reported_tcb below minimum (rollback?)`;
  }
  if (typeof policy.requireVmpl === 'number' && report.vmpl !== policy.requireVmpl) {
    return `vmpl ${report.vmpl} is not the required ${policy.requireVmpl}`;
  }
  if (Array.isArray(policy.measurements) && policy.measurements.length > 0) {
    const m = toHex(report.measurement);
    if (!policy.measurements.map((x) => x.toLowerCase()).includes(m)) {
      return 'measurement not in policy allowlist';
    }
  }
  if (Array.isArray(policy.chipIds) && policy.chipIds.length > 0) {
    const c = toHex(report.chip_id);
    if (!policy.chipIds.map((x) => x.toLowerCase()).includes(c)) {
      return 'chip_id not in policy allowlist';
    }
  }
  return null;
}

/**
 * Build a `HardwareAttestationVerifier` backed by AMD SEV-SNP. Given an attestation document + context
 * it resolves the raw report + cert chain (the evidence seam), then:
 *   1. parses the ATTESTATION_REPORT;
 *   2. verifies the VCEK→ASK→ARK chain up to the configured ARK trust anchor;
 *   3. verifies the report's ECDSA-P384 signature with the (now chain-trusted) VCEK;
 *   4. confirms report_data binds the document's nonce (`nonceBinder`);
 *   5. applies the acceptance policy to MEASUREMENT / CHIP_ID / TCB / VMPL / GUEST_SVN;
 *   6. returns the hardware-measured identity (`deriveIdentity`) — which `createAttestationVerifier`
 *      then matches against the grant's agent_binding (the MEASURED identity wins over the document).
 * Fails CLOSED with a specific reason on any mismatch or error.
 *
 * Wire it in: `createAttestationVerifier({ trustedAttestorKeys: [], hardwareVerifier: createSevSnpVerifier(opts), resolveDocument })`.
 */
export function createSevSnpVerifier(opts: SevSnpVerifierOptions): HardwareAttestationVerifier {
  const nonceBinder = opts.nonceBinder ?? defaultNonceBinder;
  const deriveIdentity = opts.policy.deriveIdentity ?? defaultDeriveIdentity;

  return {
    async verify(input): Promise<HardwareAttestationResult> {
      const fail = (reason: string): HardwareAttestationResult => ({ ok: false, reason });
      try {
        if (!opts.resolveEvidence) return fail('no SEV-SNP evidence resolver configured (fail closed)');
        const evidence = await opts.resolveEvidence(input.document, input.ctx);
        if (!evidence || !(evidence.report instanceof Uint8Array) || !evidence.chain) {
          return fail('no SEV-SNP evidence for this action');
        }

        // (1) parse
        let report: ParsedSevSnpReport;
        try {
          report = parseSevSnpReport(evidence.report);
        } catch (e) {
          return fail(`report parse failed: ${e instanceof Error ? e.message : 'unknown'}`);
        }

        // (2) chain to the ARK trust anchor
        const chain = verifyVcekChain({ chain: evidence.chain, trustAnchorArk: opts.trustAnchorArk });
        if (!chain.ok) return fail(`cert chain invalid: ${chain.reason}`);

        // (3) report signature with the chain-trusted VCEK
        if (!verifySevSnpReportSignature(report, evidence.chain.vcek)) {
          return fail('report signature does not verify under VCEK');
        }

        // (4) nonce binding: report_data must commit to the document's nonce
        const nonce = input.document?.nonce;
        if (typeof nonce !== 'string' || nonce.length === 0) return fail('attestation document has no nonce to bind');
        const expected = nonceBinder(nonce);
        if (!(expected instanceof Uint8Array) || expected.length !== 64) {
          return fail('nonceBinder must yield 64 bytes (report_data width)');
        }
        if (!timingSafeEq(expected, report.report_data)) {
          return fail('report_data does not bind the attestation nonce');
        }

        // (5) acceptance policy
        const polErr = checkSevSnpPolicy(report, opts.policy);
        if (polErr) return fail(polErr);

        // (6) hardware-measured identity
        const measured = deriveIdentity(report);
        return { ok: true, measured };
      } catch (e) {
        return fail(`sev-snp verification error (fail closed): ${e instanceof Error ? e.message : 'unknown'}`);
      }
    },
  };
}

function timingSafeEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** base64url of a public key point — handy for logging / pinning a trust anchor. */
export function fingerprintPublicKey(pk: EcdsaP384PublicKey): string {
  return b64u(sha384(pk.point)).slice(0, 16);
}

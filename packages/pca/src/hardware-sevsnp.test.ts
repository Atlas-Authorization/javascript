/**
 * HONEST VALIDATION of the AMD SEV-SNP hardware attestation VERIFIER (`hardware-sevsnp.ts`).
 *
 * There is NO AMD SEV-SNP hardware in CI to GENERATE a genuine ATTESTATION_REPORT, nor genuine
 * VCEK/ASK/ARK certificates. So these tests build a SYNTHETIC-but-cryptographically-real P-384 trust
 * chain: fresh ARK → ASK → VCEK P-384 keypairs, real ECDSA-P384/SHA-384 signatures binding each link,
 * and a report crafted with a known measurement + report_data and signed with the test VCEK. The
 * decisive test asserts the FULL path verifies end-to-end — report signature, VCEK→ASK→ARK chain to
 * the ARK trust anchor, report_data↔nonce binding, policy, and the hardware-measured identity flowing
 * through `createAttestationVerifier` into the agent_binding check. The negative tests exercise every
 * fail-closed branch.
 *
 * WHAT THIS DOES NOT PROVE: that AMD's real report byte-layout matches ours on a live CPU, or that a
 * genuine VCEK cert decodes to the point we check. Those are the remaining production integration — a
 * real report plus X.509 decode of the AMD certs (and/or AMD KDS fetch). What IS proven here is the
 * cryptographic machinery: parse → P-384 signature verify → chain verify → nonce bind → policy →
 * measured identity, all against real @noble/curves P-384 operations.
 */
import { describe, expect, it } from 'vitest';
import { p384 } from '@noble/curves/p384';
import { sha384, sha512 } from '@noble/hashes/sha512';
import {
  type EcdsaP384PublicKey,
  type SevSnpCertChain,
  type SevSnpEvidence,
  checkSevSnpPolicy,
  createSevSnpVerifier,
  defaultNonceBinder,
  ecdsaP384PublicKey,
  parseSevSnpReport,
  serializeSevSnpReport,
  sevSnpSignatureToCompact,
  toHex,
  verifySevSnpReportSignature,
  verifyVcekChain,
} from './hardware-sevsnp';
import { createAttestationVerifier, type AttestationDocument } from './attestation';
import { mintGrant, type AgentBinding } from './envelope';
import { buildPCActn, type PCActn } from './pcactn';
import { encodeKey, generateKeyPair } from './keys';
import { DEFAULT_RISK_POLICY } from './risk';
import type { Capability } from './capability';

// ── synthetic P-384 key material ───────────────────────────────────────────────────────────────
interface TestKey {
  priv: Uint8Array;
  pub: EcdsaP384PublicKey;
}
function genP384(): TestKey {
  const priv = p384.utils.randomPrivateKey();
  return { priv, pub: ecdsaP384PublicKey(p384.getPublicKey(priv, false)) };
}
/** ECDSA-P384/SHA-384 sign, returning the big-endian compact r‖s the chain/report verify expects. */
function signP384(priv: Uint8Array, msg: Uint8Array): Uint8Array {
  return p384.sign(sha384(msg), priv, { lowS: false }).toCompactRawBytes();
}
/** Encode a big-endian 48-byte scalar back into AMD's 72-byte little-endian signature field. */
function toLe72(beCompactHalf: Uint8Array): Uint8Array {
  const le = new Uint8Array(72);
  for (let i = 0; i < beCompactHalf.length; i++) le[i] = beCompactHalf[beCompactHalf.length - 1 - i]!;
  return le;
}

const ARK = genP384();
const ASK = genP384();
const VCEK = genP384();

const MEASUREMENT = new Uint8Array(48).fill(0xab); // a known launch measurement
const CHIP_ID = new Uint8Array(64).fill(0x5c);
const HOST_DATA = new Uint8Array(32).fill(0x7d);
const NONCE = 'nonce-epoch-1';
const T = 1_000_000;

/** Build a VALID chain: ASK signed by ARK, VCEK signed by ASK. tbs bytes are arbitrary-but-fixed. */
function buildChain(over: Partial<SevSnpCertChain> = {}): SevSnpCertChain {
  const ask_tbs = new TextEncoder().encode('ASK-tbsCertificate');
  const vcek_tbs = new TextEncoder().encode('VCEK-tbsCertificate');
  return {
    ark: ARK.pub,
    ask: ASK.pub,
    vcek: VCEK.pub,
    ask_tbs,
    ask_sig: signP384(ARK.priv, ask_tbs),
    vcek_tbs,
    vcek_sig: signP384(ASK.priv, vcek_tbs),
    ...over,
  };
}

/** Craft a report with known fields and sign the signed region [0x000,0x2A0) with the test VCEK. */
function buildSignedReport(
  over: Partial<Parameters<typeof serializeSevSnpReport>[0]> = {},
  signer: Uint8Array = VCEK.priv,
): Uint8Array {
  const base = serializeSevSnpReport({
    version: 2,
    guest_svn: 3,
    vmpl: 0,
    reported_tcb: 0x0000_0003_0000_0007n,
    report_data: defaultNonceBinder(NONCE),
    measurement: MEASUREMENT,
    chip_id: CHIP_ID,
    host_data: HOST_DATA,
    ...over,
  });
  const parsed = parseSevSnpReport(base);
  const compact = signP384(signer, parsed.signed); // real ECDSA-P384 over SHA-384(signed)
  const r = compact.subarray(0, 48);
  const s = compact.subarray(48, 96);
  return serializeSevSnpReport({
    version: 2,
    guest_svn: 3,
    vmpl: 0,
    reported_tcb: 0x0000_0003_0000_0007n,
    report_data: defaultNonceBinder(NONCE),
    measurement: MEASUREMENT,
    chip_id: CHIP_ID,
    host_data: HOST_DATA,
    ...over,
    signature: { r: toLe72(r), s: toLe72(s) },
  });
}

function evidence(over: { report?: Uint8Array; chain?: SevSnpCertChain } = {}): SevSnpEvidence {
  return { report: over.report ?? buildSignedReport(), chain: over.chain ?? buildChain() };
}

// ── grant / pcactn / document plumbing (mirrors attestation.test.ts) ─────────────────────────────
const P = generateKeyPair();
const A = generateKeyPair();

const MEASURED_BINDING: AgentBinding = {
  // The measured identity the default deriveIdentity yields: runtime_measurement = hex(MEASUREMENT),
  // operator = hex(CHIP_ID), weights_digest = hex(HOST_DATA).
  min_measurement: toHex(MEASUREMENT),
  operator: toHex(CHIP_ID),
  weights_allowlist: [toHex(HOST_DATA)],
};

function grantWith(binding: AgentBinding): Capability {
  return mintGrant({
    principalSecret: P.secretKey,
    principalPublic: encodeKey(P.publicKey),
    holder: encodeKey(A.publicKey),
    goal: 'secure my account',
    envelope: { predicates: [{ verb: 'read', resource: '/acct/*' }], caveats: [], agent_binding: binding, risk_policy: DEFAULT_RISK_POLICY },
  }).grant;
}

function pcactn(grant: Capability, quoteDigest = NONCE): PCActn {
  return buildPCActn({
    grant,
    chain: [grant],
    plan: [{ id: 'n1', verb: 'read', resource: '/acct/1', reversibility_class: 'reversible' }],
    nodeId: 'n1',
    counter: 1,
    signerSecret: A.secretKey,
    attestation: { quote_digest: quoteDigest, epoch: 1, model_id: 'gpt-x', measurement: toHex(MEASUREMENT), operator: toHex(CHIP_ID) },
  });
}

/** A hardware-mode document carrying only the nonce + validity window (fields are self-asserted). */
function hwDoc(nonce = NONCE): AttestationDocument {
  return {
    model_id: 'self-asserted-ignored',
    weights_digest: 'self-asserted-ignored',
    runtime_measurement: 'self-asserted-ignored',
    operator: 'self-asserted-ignored',
    nonce,
    issued_at: T - 1000,
    expires_at: T + 60_000,
    attestor: 'n/a',
    mode: 'hardware',
    sig: 'n/a',
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
describe('parseSevSnpReport / serializeSevSnpReport', () => {
  it('round-trips the documented field layout', () => {
    const bytes = buildSignedReport();
    const r = parseSevSnpReport(bytes);
    expect(r.version).toBe(2);
    expect(r.guest_svn).toBe(3);
    expect(r.vmpl).toBe(0);
    expect(r.signature_algo).toBe(1);
    expect(r.reported_tcb).toBe(0x0000_0003_0000_0007n);
    expect(toHex(r.measurement)).toBe(toHex(MEASUREMENT));
    expect(r.measurement.length).toBe(48);
    expect(r.report_data.length).toBe(64);
    expect(r.chip_id.length).toBe(64);
    expect(toHex(r.report_data)).toBe(toHex(defaultNonceBinder(NONCE)));
    expect(r.signed.length).toBe(0x2a0);
    expect(r.signature.r.length).toBe(72);
    expect(r.signature.s.length).toBe(72);
  });

  it('rejects a buffer too short to hold the signature fields', () => {
    expect(() => parseSevSnpReport(new Uint8Array(100))).toThrow(/too short/);
  });
});

describe('SEV-SNP primitives', () => {
  it('verifies a real P-384 report signature and rejects a tampered signed region', () => {
    const bytes = buildSignedReport();
    const report = parseSevSnpReport(bytes);
    expect(verifySevSnpReportSignature(report, VCEK.pub)).toBe(true);
    // wrong key fails
    expect(verifySevSnpReportSignature(report, ASK.pub)).toBe(false);
    // flip a byte inside the signed region → signature no longer covers it
    const tampered = bytes.slice();
    tampered[0x090] = (tampered[0x090]! ^ 0x01) & 0xff; // first measurement byte
    expect(verifySevSnpReportSignature(parseSevSnpReport(tampered), VCEK.pub)).toBe(false);
  });

  it('sevSnpSignatureToCompact rejects out-of-range scalars', () => {
    expect(() => sevSnpSignatureToCompact({ r: new Uint8Array(72), s: new Uint8Array(72) })).toThrow(/out of range/);
  });

  it('verifyVcekChain accepts a valid chain and rejects every broken link', () => {
    expect(verifyVcekChain({ chain: buildChain(), trustAnchorArk: ARK.pub })).toEqual({ ok: true });
    // wrong trust anchor
    expect(verifyVcekChain({ chain: buildChain(), trustAnchorArk: genP384().pub })).toMatchObject({ ok: false });
    // VCEK not signed by ASK (sign it with ARK instead)
    const badVcek = buildChain({ vcek_sig: signP384(ARK.priv, new TextEncoder().encode('VCEK-tbsCertificate')) });
    expect(verifyVcekChain({ chain: badVcek, trustAnchorArk: ARK.pub }).reason).toMatch(/VCEK is not signed by ASK/);
    // ASK not signed by ARK
    const badAsk = buildChain({ ask_sig: signP384(ASK.priv, new TextEncoder().encode('ASK-tbsCertificate')) });
    expect(verifyVcekChain({ chain: badAsk, trustAnchorArk: ARK.pub }).reason).toMatch(/ASK is not signed by ARK/);
  });

  it('checkSevSnpPolicy gates measurement / chip / tcb / vmpl / svn', () => {
    const r = parseSevSnpReport(buildSignedReport());
    expect(checkSevSnpPolicy(r, { measurements: [toHex(MEASUREMENT)] })).toBeNull();
    expect(checkSevSnpPolicy(r, { measurements: ['00'] })).toMatch(/measurement not in policy/);
    expect(checkSevSnpPolicy(r, { chipIds: ['00'] })).toMatch(/chip_id/);
    expect(checkSevSnpPolicy(r, { minGuestSvn: 99 })).toMatch(/guest_svn/);
    expect(checkSevSnpPolicy(r, { minReportedTcb: 0xffff_ffff_ffff_ffffn })).toMatch(/reported_tcb/);
    expect(checkSevSnpPolicy(r, { requireVmpl: 1 })).toMatch(/vmpl/);
  });
});

describe('createSevSnpVerifier — decisive end-to-end path', () => {
  const policy = { measurements: [toHex(MEASUREMENT)], chipIds: [toHex(CHIP_ID)], requireVmpl: 0, minGuestSvn: 1 };

  it('FULL PATH: synthetic ARK→ASK→VCEK report verifies end-to-end through createAttestationVerifier', async () => {
    const hw = createSevSnpVerifier({ trustAnchorArk: ARK.pub, policy, resolveEvidence: () => evidence() });
    const grant = grantWith(MEASURED_BINDING);
    const verify = createAttestationVerifier({
      trustedAttestorKeys: [],
      hardwareVerifier: hw,
      resolveDocument: () => hwDoc(),
      now: () => T,
    });
    const res = await verify({ pcactn: pcactn(grant), grant });
    expect(res).toEqual({ enforced: true, ok: true });
  });

  it('the MEASURED identity (not the document) is matched against agent_binding', async () => {
    // Bind to a DIFFERENT operator than the measured chip_id → must fail even though the (lying)
    // document says nothing useful; the hardware-derived operator = hex(CHIP_ID) is what is checked.
    const hw = createSevSnpVerifier({ trustAnchorArk: ARK.pub, policy, resolveEvidence: () => evidence() });
    const grant = grantWith({ ...MEASURED_BINDING, operator: 'some-other-operator' });
    const verify = createAttestationVerifier({ trustedAttestorKeys: [], hardwareVerifier: hw, resolveDocument: () => hwDoc(), now: () => T });
    const res = await verify({ pcactn: pcactn(grant), grant });
    expect(res).toMatchObject({ enforced: true, ok: false });
    expect((res as { reason: string }).reason).toMatch(/operator/);
  });

  it('negative: a tampered report byte breaks the report signature', async () => {
    const bad = buildSignedReport();
    bad[0x090] = (bad[0x090]! ^ 0xff) & 0xff; // flip a measurement byte after signing
    const hw = createSevSnpVerifier({ trustAnchorArk: ARK.pub, policy, resolveEvidence: () => evidence({ report: bad }) });
    const r = await hw.verify({ document: hwDoc(), ctx: {} as never, nowMs: T });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/report signature does not verify/);
  });

  it('negative: a VCEK not endorsed by the chain fails chain verification', async () => {
    const rogue = genP384();
    const report = buildSignedReport({}, rogue.priv); // signed by a rogue key
    const chain = buildChain({ vcek: rogue.pub, vcek_sig: new Uint8Array(96) }); // chain cannot endorse it
    const hw = createSevSnpVerifier({ trustAnchorArk: ARK.pub, policy, resolveEvidence: () => evidence({ report, chain }) });
    const r = await hw.verify({ document: hwDoc(), ctx: {} as never, nowMs: T });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cert chain invalid.*VCEK is not signed by ASK/);
  });

  it('negative: wrong ARK trust anchor fails', async () => {
    const hw = createSevSnpVerifier({ trustAnchorArk: genP384().pub, policy, resolveEvidence: () => evidence() });
    const r = await hw.verify({ document: hwDoc(), ctx: {} as never, nowMs: T });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ARK does not match the configured trust anchor/);
  });

  it('negative: report_data nonce mismatch fails', async () => {
    // report_data binds NONCE, but the document (and PCActn) declare a different nonce.
    const hw = createSevSnpVerifier({ trustAnchorArk: ARK.pub, policy, resolveEvidence: () => evidence() });
    const r = await hw.verify({ document: hwDoc('a-different-nonce'), ctx: {} as never, nowMs: T });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/report_data does not bind the attestation nonce/);
  });

  it('negative: measurement not in policy fails', async () => {
    const hw = createSevSnpVerifier({ trustAnchorArk: ARK.pub, policy: { measurements: ['00'.repeat(48)] }, resolveEvidence: () => evidence() });
    const r = await hw.verify({ document: hwDoc(), ctx: {} as never, nowMs: T });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/measurement not in policy/);
  });

  it('negative: no evidence resolver fails closed', async () => {
    const hw = createSevSnpVerifier({ trustAnchorArk: ARK.pub, policy });
    const r = await hw.verify({ document: hwDoc(), ctx: {} as never, nowMs: T });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no SEV-SNP evidence resolver/);
  });

  it('custom nonceBinder is honored (binds a differently-hashed report_data)', async () => {
    const binder = (n: string) => sha512(new TextEncoder().encode('salt|' + n));
    const report = buildSignedReport({ report_data: binder(NONCE) });
    const hw = createSevSnpVerifier({ trustAnchorArk: ARK.pub, policy, nonceBinder: binder, resolveEvidence: () => evidence({ report }) });
    const r = await hw.verify({ document: hwDoc(), ctx: {} as never, nowMs: T });
    expect(r.ok).toBe(true);
    expect(r.measured?.runtime_measurement).toBe(toHex(MEASUREMENT));
  });
});

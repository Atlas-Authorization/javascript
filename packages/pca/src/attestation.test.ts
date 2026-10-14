import { describe, expect, it } from 'vitest';
import {
  type AttestationDocument,
  type HardwareAttestationVerifier,
  attestationRegistry,
  createAttestationVerifier,
  createDevAttestor,
  matchAgentBinding,
} from './attestation';
import { mintGrant, type AgentBinding } from './envelope';
import { buildPCActn, type PCActn, type VerifyContext } from './pcactn';
import { encodeKey, generateKeyPair } from './keys';
import { DEFAULT_RISK_POLICY } from './risk';
import type { Capability } from './capability';

const P = generateKeyPair();
const A = generateKeyPair();
const NONCE = 'nonce-epoch-1';
const T = 1_000_000; // "now" in ms

const CLAIMS = {
  model_id: 'gpt-x',
  weights_digest: 'w-sha-1',
  runtime_measurement: 'm-launch-1',
  operator: 'acme-cloud',
  nonce: NONCE,
  issued_at: T - 1000,
  expires_at: T + 60_000,
};

function grantWith(binding: AgentBinding): Capability {
  return mintGrant({
    principalSecret: P.secretKey,
    principalPublic: encodeKey(P.publicKey),
    holder: encodeKey(A.publicKey),
    goal: 'secure my account',
    envelope: {
      predicates: [{ verb: 'read', resource: '/acct/*' }],
      caveats: [],
      agent_binding: binding,
      risk_policy: DEFAULT_RISK_POLICY,
    },
  }).grant;
}

function pcactn(grant: Capability, quoteDigest = NONCE): PCActn {
  const nodes = [{ id: 'n1', verb: 'read', resource: '/acct/1', reversibility_class: 'reversible' }];
  return buildPCActn({
    grant,
    chain: [grant],
    plan: nodes,
    nodeId: 'n1',
    counter: 1,
    signerSecret: A.secretKey,
    attestation: { quote_digest: quoteDigest, epoch: 1, model_id: 'gpt-x', measurement: 'm-launch-1', operator: 'acme-cloud' },
  });
}

const FULL_BINDING: AgentBinding = {
  model_allowlist: ['gpt-x', 'gpt-y'],
  min_measurement: 'm-launch-1',
  operator: 'acme-cloud',
  weights_allowlist: ['w-sha-1'],
};

describe('createAttestationVerifier (L0, software mode)', () => {
  it('valid dev doc passes and binds to agent_binding', async () => {
    const attestor = createDevAttestor(generateKeyPair().secretKey);
    const doc = attestor.attest(CLAIMS);
    const grant = grantWith(FULL_BINDING);
    const verify = createAttestationVerifier({
      trustedAttestorKeys: [attestor.publicKey],
      resolveDocument: attestationRegistry([doc]),
      now: () => T,
    });
    const res = await verify({ pcactn: pcactn(grant), grant });
    expect(res).toEqual({ enforced: true, ok: true });
  });

  it('expired attestation fails', async () => {
    const attestor = createDevAttestor(generateKeyPair().secretKey);
    const doc = attestor.attest({ ...CLAIMS, issued_at: T - 10_000, expires_at: T - 5_000 });
    const grant = grantWith(FULL_BINDING);
    const verify = createAttestationVerifier({
      trustedAttestorKeys: [attestor.publicKey],
      resolveDocument: attestationRegistry([doc]),
      now: () => T,
    });
    const res = await verify({ pcactn: pcactn(grant), grant });
    expect(res).toMatchObject({ enforced: true, ok: false });
    expect((res as { reason: string }).reason).toMatch(/expired/);
  });

  it('attestor key not trusted fails', async () => {
    const attestor = createDevAttestor(generateKeyPair().secretKey);
    const doc = attestor.attest(CLAIMS);
    const grant = grantWith(FULL_BINDING);
    const verify = createAttestationVerifier({
      trustedAttestorKeys: [createDevAttestor(generateKeyPair().secretKey).publicKey], // a DIFFERENT key
      resolveDocument: attestationRegistry([doc]),
      now: () => T,
    });
    const res = await verify({ pcactn: pcactn(grant), grant });
    expect(res).toMatchObject({ enforced: true, ok: false });
    expect((res as { reason: string }).reason).toMatch(/not trusted/);
  });

  it('tampered document breaks the signature', async () => {
    const attestor = createDevAttestor(generateKeyPair().secretKey);
    const doc = attestor.attest(CLAIMS);
    const tampered: AttestationDocument = { ...doc, weights_digest: 'w-EVIL' };
    const grant = grantWith(FULL_BINDING);
    const verify = createAttestationVerifier({
      trustedAttestorKeys: [attestor.publicKey],
      resolveDocument: () => tampered,
      now: () => T,
    });
    const res = await verify({ pcactn: pcactn(grant), grant });
    expect(res).toMatchObject({ enforced: true, ok: false });
    expect((res as { reason: string }).reason).toMatch(/signature does not verify/);
  });

  it('model not in allowlist fails', async () => {
    const attestor = createDevAttestor(generateKeyPair().secretKey);
    const doc = attestor.attest(CLAIMS);
    const grant = grantWith({ ...FULL_BINDING, model_allowlist: ['only-other-model'] });
    const verify = createAttestationVerifier({
      trustedAttestorKeys: [attestor.publicKey],
      resolveDocument: attestationRegistry([doc]),
      now: () => T,
    });
    const res = await verify({ pcactn: pcactn(grant), grant });
    expect(res).toMatchObject({ enforced: true, ok: false });
    expect((res as { reason: string }).reason).toMatch(/model_allowlist/);
  });

  it('weights not in weights_allowlist fails (model swap / fine-tune)', async () => {
    const attestor = createDevAttestor(generateKeyPair().secretKey);
    const doc = attestor.attest(CLAIMS);
    const grant = grantWith({ ...FULL_BINDING, weights_allowlist: ['w-DIFFERENT'] });
    const verify = createAttestationVerifier({
      trustedAttestorKeys: [attestor.publicKey],
      resolveDocument: attestationRegistry([doc]),
      now: () => T,
    });
    const res = await verify({ pcactn: pcactn(grant), grant });
    expect(res).toMatchObject({ enforced: true, ok: false });
    expect((res as { reason: string }).reason).toMatch(/weights_digest/);
  });

  it('nonce mismatch (document does not bind to the PCActn) fails', async () => {
    const attestor = createDevAttestor(generateKeyPair().secretKey);
    const doc = attestor.attest(CLAIMS); // nonce = NONCE
    const grant = grantWith(FULL_BINDING);
    const verify = createAttestationVerifier({
      trustedAttestorKeys: [attestor.publicKey],
      resolveDocument: () => doc, // return the doc regardless of the PCActn's quote_digest
      now: () => T,
    });
    const p = pcactn(grant, 'a-different-nonce'); // PCActn declares a different attestation
    const res = await verify({ pcactn: p, grant });
    expect(res).toMatchObject({ enforced: true, ok: false });
    expect((res as { reason: string }).reason).toMatch(/nonce does not bind/);
  });

  it('no document resolved fails closed', async () => {
    const attestor = createDevAttestor(generateKeyPair().secretKey);
    const grant = grantWith(FULL_BINDING);
    const verify = createAttestationVerifier({
      trustedAttestorKeys: [attestor.publicKey],
      resolveDocument: attestationRegistry([]), // empty registry
      now: () => T,
    });
    const res = await verify({ pcactn: pcactn(grant), grant });
    expect(res).toMatchObject({ enforced: true, ok: false });
    expect((res as { reason: string }).reason).toMatch(/no attestation document/);
  });

  it('hardware seam: delegates authenticity and binds the hardware-measured identity', async () => {
    const grant = grantWith(FULL_BINDING);
    // A document whose SELF-ASSERTED fields lie, but the hardware verifier returns the true measured
    // identity — the agent_binding check runs against the hardware identity, so the lie is irrelevant.
    const lyingDoc: AttestationDocument = {
      model_id: 'LIE',
      weights_digest: 'LIE',
      runtime_measurement: 'LIE',
      operator: 'LIE',
      nonce: NONCE,
      issued_at: T - 1000,
      expires_at: T + 60_000,
      attestor: 'n/a',
      mode: 'hardware',
      sig: 'n/a',
    };
    const hw: HardwareAttestationVerifier = {
      verify: () => ({
        ok: true,
        measured: { model_id: 'gpt-x', weights_digest: 'w-sha-1', runtime_measurement: 'm-launch-1', operator: 'acme-cloud' },
      }),
    };
    const verify = createAttestationVerifier({ trustedAttestorKeys: [], hardwareVerifier: hw, resolveDocument: () => lyingDoc, now: () => T });
    const res = await verify({ pcactn: pcactn(grant), grant });
    expect(res).toEqual({ enforced: true, ok: true });

    // A rejecting hardware verifier fails.
    const hwReject: HardwareAttestationVerifier = { verify: () => ({ ok: false, reason: 'bad report' }) };
    const verify2 = createAttestationVerifier({ trustedAttestorKeys: [], hardwareVerifier: hwReject, resolveDocument: () => lyingDoc, now: () => T });
    const res2 = await verify2({ pcactn: pcactn(grant), grant });
    expect(res2).toMatchObject({ enforced: true, ok: false });
    expect((res2 as { reason: string }).reason).toMatch(/hardware attestation rejected/);
  });
});

describe('matchAgentBinding', () => {
  const id = { model_id: 'gpt-x', weights_digest: 'w-sha-1', runtime_measurement: 'm-launch-1', operator: 'acme-cloud' };
  it('empty binding matches anything', () => {
    expect(matchAgentBinding(id, {})).toBeNull();
    expect(matchAgentBinding(id, undefined)).toBeNull();
  });
  it('each field is gated independently', () => {
    expect(matchAgentBinding(id, { model_allowlist: ['gpt-x'] })).toBeNull();
    expect(matchAgentBinding(id, { model_allowlist: ['no'] })).toMatch(/model_allowlist/);
    expect(matchAgentBinding(id, { min_measurement: 'm-launch-1' })).toBeNull();
    expect(matchAgentBinding(id, { min_measurement: 'other' })).toMatch(/min_measurement/);
    expect(matchAgentBinding(id, { operator: 'acme-cloud' })).toBeNull();
    expect(matchAgentBinding(id, { operator: 'evil' })).toMatch(/operator/);
  });
});

// Compile-time: the verifier is assignable to the AttestationVerifier hook type.
const _hook: (ctx: VerifyContext) => unknown = createAttestationVerifier({ trustedAttestorKeys: [] });
void _hook;

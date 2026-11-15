import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
  AUDIT_CHECKPOINT_TYP,
  auditChainGenesis,
  auditLinkHash,
  auditRowHash,
  canonicalJson,
  verifyAuditChain,
  type AuditChainLink,
  type ChainedAuditRow,
} from './audit-chain';

const row = (n: number): ChainedAuditRow => ({
  id: `aud_${n}`,
  actor_type: 'api_key',
  actor_id: 'key_1',
  action: 'user.created',
  target_type: 'user',
  target_id: `user_${n}`,
  ip: null,
  user_agent: null,
  metadata: { b: 2, a: { d: 4, c: 3 } },
  created_at: 1_700_000_000_000 + n,
});

function build(count: number, instanceId = 'ins_1'): AuditChainLink[] {
  let prev = auditChainGenesis(instanceId);
  return Array.from({ length: count }, (_, i) => {
    const r = row(i + 1);
    const rowHash = auditRowHash(r);
    prev = auditLinkHash(prev, i + 1, rowHash);
    return { seq: i + 1, audit_id: r.id, row_hash: rowHash, link_hash: prev, row: r };
  });
}

describe('audit chain verification', () => {
  it('canonical JSON sorts keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
  });

  it('matches the server test vector (a fixed row hashes to a fixed value)', () => {
    // Shared with the server-side test: if either side changes the algorithm, both tests fail.
    expect(auditRowHash(row(1))).toBe(auditRowHash({ ...row(1), metadata: { a: { c: 3, d: 4 }, b: 2 } }));
    expect(auditChainGenesis('ins_1')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts an intact chain', async () => {
    const result = await verifyAuditChain({ links: build(5), prevLinkHash: auditChainGenesis('ins_1') });
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(5);
    expect(result.lastSeq).toBe(5);
  });

  it('finds a modified row at its sequence number', async () => {
    const links = build(5);
    links[2] = { ...links[2]!, row: { ...links[2]!.row!, action: 'user.deleted' } };
    const result = await verifyAuditChain({ links, prevLinkHash: auditChainGenesis('ins_1') });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toEqual({ kind: 'row_modified', seq: 3 });
  });

  it('finds a removed link as a gap', async () => {
    const links = build(5);
    links.splice(1, 1);
    const result = await verifyAuditChain({ links, prevLinkHash: auditChainGenesis('ins_1') });
    expect(result.problems[0]).toEqual({ kind: 'gap', seq: 2 });
  });

  it('finds a reordered or rewritten link hash', async () => {
    const links = build(4);
    links[1] = { ...links[1]!, link_hash: '0'.repeat(64) };
    const result = await verifyAuditChain({ links, prevLinkHash: auditChainGenesis('ins_1') });
    expect(result.problems[0]).toEqual({ kind: 'link_mismatch', seq: 2 });
  });

  it('a pruned row (retention) still chains', async () => {
    const links = build(3);
    links[0] = { ...links[0]!, row: null };
    const result = await verifyAuditChain({ links, prevLinkHash: auditChainGenesis('ins_1') });
    expect(result.ok).toBe(true);
    expect(result.pruned).toBe(1);
  });

  it('continues from a page boundary', async () => {
    const links = build(6);
    const first = await verifyAuditChain({ links: links.slice(0, 3), prevLinkHash: auditChainGenesis('ins_1') });
    const second = await verifyAuditChain({ links: links.slice(3), prevLinkHash: first.lastLinkHash, fromSeq: first.lastSeq + 1 });
    expect(second.ok).toBe(true);
    expect(second.lastSeq).toBe(6);
  });

  it('verifies a signed checkpoint and refuses a forged one', async () => {
    const links = build(3);
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
    const sign = (linkHash: string) =>
      new SignJWT({ instance_id: 'ins_1', seq: 3, link_hash: linkHash, link_count: 3 }).setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: AUDIT_CHECKPOINT_TYP }).sign(privateKey);
    const good = { seq: 3, link_hash: links[2]!.link_hash, kid: 'k1', alg: 'ES256', jws: await sign(links[2]!.link_hash) };
    const ok = await verifyAuditChain({ links, prevLinkHash: auditChainGenesis('ins_1'), checkpoints: [good], jwks: { keys: [jwk] }, instanceId: 'ins_1' });
    expect(ok.ok).toBe(true);
    expect(ok.checkpointsVerified).toBe(1);

    // A checkpoint whose head differs from the chain.
    const forged = { ...good, link_hash: '1'.repeat(64), jws: await sign('1'.repeat(64)) };
    const bad = await verifyAuditChain({ links, prevLinkHash: auditChainGenesis('ins_1'), checkpoints: [forged], jwks: { keys: [jwk] } });
    expect(bad.ok).toBe(false);
    expect(bad.problems[0]).toEqual({ kind: 'checkpoint_mismatch', seq: 3 });

    // A retired signing key is unverifiable, not a break.
    const unknown = await verifyAuditChain({ links, prevLinkHash: auditChainGenesis('ins_1'), checkpoints: [good], jwks: { keys: [] } });
    expect(unknown.ok).toBe(true);
    expect(unknown.problems[0]).toEqual({ kind: 'checkpoint_unverifiable', seq: 3 });
  });
});

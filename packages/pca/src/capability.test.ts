import { describe, expect, it } from 'vitest';
import { attenuate, capHash, delegate, mintRoot, verifyChain, type Capability } from './capability';
import { encodeKey, generateKeyPair } from './keys';
import { b64u, hashCanonical, sha256, utf8 } from './hash';

function setup() {
  const P = generateKeyPair();
  const A = generateKeyPair();
  const S = generateKeyPair();
  const root = mintRoot({
    principalSecret: P.secretKey,
    principalPublic: encodeKey(P.publicKey),
    holder: encodeKey(A.publicKey),
    caveats: [{ type: 'ttl', secs: 3600 }, { type: 'rate', perHour: 10 }],
  });
  return { P, A, S, root };
}

describe('capability chain', () => {
  it('mint -> attenuate -> delegate verifies', () => {
    const { P, A, S, root } = setup();
    const c1 = attenuate(root, [{ type: 'resource', prefix: '/acct' }], A.secretKey);
    const c2 = delegate(c1, encodeKey(S.publicKey), [{ type: 'depth', max: 0 }], A.secretKey);
    expect(c2.caveats).toHaveLength(4);
    expect(c2.holder).toBe(encodeKey(S.publicKey));
    expect(verifyChain([root, c1, c2], encodeKey(P.publicKey))).toEqual({ ok: true });
    expect(verifyChain([root])).toEqual({ ok: true });
  });
  it('wrong expected root issuer rejected', () => {
    const { root } = setup();
    expect(verifyChain([root], encodeKey(generateKeyPair().publicKey)).ok).toBe(false);
  });
  it('re-signed child that DROPS a parent caveat is rejected', () => {
    const { A, root } = setup();
    const good = attenuate(root, [], A.secretKey);
    const body = { issuer: good.issuer, holder: good.holder, caveats: good.caveats.slice(1), parent: good.parent! };
    const forged = forge(body, A.secretKey);
    const r = verifyChain([root, forged]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/drops/);
  });
  it('REORDERED caveats rejected', () => {
    const { A, root } = setup();
    const good = attenuate(root, [{ type: 'x' }], A.secretKey);
    const caveats = [good.caveats[1]!, good.caveats[0]!, good.caveats[2]!];
    const r = verifyChain([root, forge({ issuer: good.issuer, holder: good.holder, caveats, parent: good.parent! }, A.secretKey)]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/altered or reordered/);
  });
  it('LOOSENED (edited) caveat rejected', () => {
    const { A, root } = setup();
    const good = attenuate(root, [], A.secretKey);
    const caveats = [{ type: 'ttl', secs: 999999 }, good.caveats[1]!];
    const r = verifyChain([root, forge({ issuer: good.issuer, holder: good.holder, caveats, parent: good.parent! }, A.secretKey)]);
    expect(r.ok).toBe(false);
  });
  it('mutating caveats after signing breaks the digest', () => {
    const { A, root } = setup();
    const c = attenuate(root, [{ type: 'x' }], A.secretKey);
    const t: Capability = { ...c, caveats: [...c.caveats.slice(0, 2), { type: 'y' }] };
    expect(verifyChain([root, t]).ok).toBe(false);
  });
  it('hop signed by the wrong key is rejected', () => {
    const { root } = setup();
    const evil = generateKeyPair();
    const c = attenuate(root, [], evil.secretKey);
    const r = verifyChain([root, c]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/bad signature/);
  });
  it('issuer not equal to parent holder rejected (binding continuity)', () => {
    const { root, A } = setup();
    const evil = generateKeyPair();
    const c = forge({ issuer: encodeKey(evil.publicKey), holder: root.holder, caveats: root.caveats, parent: capHash(root) }, evil.secretKey);
    expect(verifyChain([root, c])).toMatchObject({ ok: false });
    expect(A).toBeDefined();
  });
  it('broken parent link rejected', () => {
    const { P, A, root } = setup();
    const other = mintRoot({ principalSecret: P.secretKey, principalPublic: encodeKey(P.publicKey), holder: encodeKey(A.publicKey), caveats: [] });
    const c = attenuate(other, [], A.secretKey);
    const r = verifyChain([root, c]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/parent link/);
  });
  it('empty chain and rooted-with-parent rejected', () => {
    const { A, root } = setup();
    expect(verifyChain([]).ok).toBe(false);
    expect(verifyChain([attenuate(root, [], A.secretKey)]).ok).toBe(false);
  });
});

// Re-sign an arbitrary body with the real signing scheme (simulates a malicious but key-holding hop).
import { sign } from './keys';
function forge(body: { issuer: string; holder: string; caveats: unknown[]; parent: string }, secret: Uint8Array): Capability {
  const digest = hashCanonical({ issuer: body.issuer, holder: body.holder, caveats: body.caveats, parent: body.parent });
  const d = sha256(utf8('x')); void d;
  const p = utf8('atlas-pca/cap/v1\0');
  const raw = Buffer.from(digest, 'base64url');
  const m = new Uint8Array(p.length + raw.length);
  m.set(p);
  m.set(raw, p.length);
  return { id: digest, issuer: body.issuer, holder: body.holder, caveats: body.caveats as Capability['caveats'], parent: body.parent, body_digest: digest, sig: b64u(sign(secret, m)) };
}

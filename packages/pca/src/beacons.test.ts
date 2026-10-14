import { describe, expect, it } from 'vitest';
import { GLOBAL_SCOPE, isFrozen, issueBeacon, verifyBeacon } from './beacons';
import { encodeKey, generateKeyPair } from './keys';

const G = generateKeyPair();

describe('beacons', () => {
  it('issue -> verify inside the window (inclusive bounds)', () => {
    const b = issueBeacon({ guardianSecret: G.secretKey, epoch: 10, notAfter: 12 });
    expect(b.scope).toBe(GLOBAL_SCOPE);
    for (const e of [10, 11, 12]) expect(verifyBeacon(b, G.publicKey, e).ok).toBe(true);
    expect(verifyBeacon(b, encodeKey(G.publicKey), 11).ok).toBe(true);
  });
  it('expired and not-yet-valid fail', () => {
    const b = issueBeacon({ guardianSecret: G.secretKey, epoch: 10, notAfter: 12 });
    expect(verifyBeacon(b, G.publicKey, 13)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyBeacon(b, G.publicKey, 9)).toEqual({ ok: false, reason: 'not yet valid' });
  });
  it('wrong key fails; tampering fails', () => {
    const b = issueBeacon({ guardianSecret: G.secretKey, epoch: 10, notAfter: 12 });
    expect(verifyBeacon(b, generateKeyPair().publicKey, 11).ok).toBe(false);
    expect(verifyBeacon({ ...b, not_after: 999 }, G.publicKey, 500).ok).toBe(false);
    const other = generateKeyPair();
    const forged = { ...issueBeacon({ guardianSecret: other.secretKey, epoch: 10, notAfter: 12 }), guardian: b.guardian };
    expect(verifyBeacon(forged, G.publicKey, 11).ok).toBe(false);
    expect(verifyBeacon({} as never, G.publicKey, 11).ok).toBe(false);
  });
  it('rejects bad windows at issue time', () => {
    expect(() => issueBeacon({ guardianSecret: G.secretKey, epoch: 5, notAfter: 4 })).toThrow();
    expect(() => issueBeacon({ guardianSecret: G.secretKey, epoch: 1.5, notAfter: 4 })).toThrow();
  });
  it('scopes: global covers all, scoped covers only itself', () => {
    const s = issueBeacon({ guardianSecret: G.secretKey, epoch: 1, notAfter: 5, scope: 'agent:a' });
    expect(verifyBeacon(s, G.publicKey, 3, 'agent:a').ok).toBe(true);
    expect(verifyBeacon(s, G.publicKey, 3, 'agent:b').ok).toBe(false);
    const g = issueBeacon({ guardianSecret: G.secretKey, epoch: 1, notAfter: 5 });
    expect(verifyBeacon(g, G.publicKey, 3, 'agent:b').ok).toBe(true);
  });
  it('freezes when beacons are absent, stopped, forged, or from the wrong guardian', () => {
    expect(isFrozen([], 5, G.publicKey)).toBe(true);
    const bs = [1, 2, 3].map((e) => issueBeacon({ guardianSecret: G.secretKey, epoch: e, notAfter: e }));
    expect(isFrozen(bs, 3, G.publicKey)).toBe(false);
    expect(isFrozen(bs, 4, G.publicKey)).toBe(true); // guardian stopped issuing
    expect(isFrozen(bs, 3, generateKeyPair().publicKey)).toBe(true);
    const rogue = issueBeacon({ guardianSecret: generateKeyPair().secretKey, epoch: 4, notAfter: 9 });
    expect(isFrozen([...bs, rogue], 4, G.publicKey)).toBe(true);
    expect(isFrozen(bs, 3, G.publicKey, 'x')).toBe(false);
  });
});

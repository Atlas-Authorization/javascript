import { describe, expect, it } from 'vitest';
import { verifyPCActn } from './verify';
import { NOW, setup } from './fixture.test-util';
import { encodePCActn } from '@atlasauth/pca';

describe('verifyPCActn', () => {
  it('allows a valid in-plan low-risk action; later-milestone hooks report not-enforced', async () => {
    const s = setup();
    const v = await verifyPCActn(s.mk(s.plan[0]!), { grant: s.grant, now: NOW, context: { plan: s.plan, risk: s.lowRisk, params: {} } });
    expect(v.allow).toBe(true);
    expect(v.requiredThreshold.t).toBe(1);
    expect(v.checks.cap_chain).toBe('pass');
    expect(v.checks.plan_inclusion).toBe('pass');
    expect(v.checks.leaf_signature).toBe('pass');
    expect(v.checks.attestation).toBe('not-enforced');
    expect(v.checks.revocation).toBe('not-enforced');
    expect(v.checks.threshold).toBe('not-enforced');
  });

  it('accepts a string-encoded PCActn', async () => {
    const s = setup();
    const v = await verifyPCActn(encodePCActn(s.mk(s.plan[0]!)), { grant: s.grant, now: NOW, context: { plan: s.plan, risk: s.lowRisk } });
    expect(v.allow).toBe(true);
  });

  it('denies an out-of-plan action (bad inclusion)', async () => {
    const s = setup();
    const a = s.mk(s.plan[0]!, { tweak: (x) => { x.resource = 'session:other'; } });
    const v = await verifyPCActn(a, { grant: s.grant, now: NOW, context: { risk: s.lowRisk } });
    expect(v.allow).toBe(false);
    expect(v.checks.plan_inclusion).toBe('fail');
    expect(v.reasons.join(' ')).toMatch(/plan_inclusion/);
  });

  it('denies a tampered body (signature)', async () => {
    const s = setup();
    const a = s.mk(s.plan[0]!);
    const t = { ...a, counter: 99 };
    const v = await verifyPCActn(t, { grant: s.grant, now: NOW, context: { risk: s.lowRisk } });
    expect(v.allow).toBe(false);
    expect(v.checks.leaf_signature).toBe('fail');
  });

  it('denies when a RevocationChecker hook reports revoked', async () => {
    const s = setup();
    const v = await verifyPCActn(s.mk(s.plan[0]!), {
      grant: s.grant, now: NOW, context: { plan: s.plan, risk: s.lowRisk },
      hooks: { revocation: () => ({ enforced: true, ok: false, reason: 'leaf revoked' }) },
    });
    expect(v.allow).toBe(false);
    expect(v.checks.revocation).toBe('fail');
    expect(v.reasons.join(' ')).toContain('leaf revoked');
  });

  it('denies by policy when action is outside the envelope predicates', async () => {
    const s = setup();
    const n = { ...s.plan[0]!, verb: 'delete_account' };
    const v = await verifyPCActn(s.mk(n), { grant: s.grant, now: NOW, context: { risk: s.lowRisk } });
    expect(v.allow).toBe(false);
    expect(v.checks.policy).toBe('fail');
  });

  it('denies an expired delegation caveat', async () => {
    const s = setup();
    const v = await verifyPCActn(s.mk(s.plan[0]!), { grant: s.grant, now: NOW + 700_000, context: { plan: s.plan, risk: s.lowRisk } });
    expect(v.allow).toBe(false);
    expect(v.checks.delegated_caveats).toBe('fail');
  });

  it('denies params that do not open the digest', async () => {
    const s = setup();
    const v = await verifyPCActn(s.mk(s.plan[0]!), { grant: s.grant, now: NOW, context: { params: { evil: 1 }, risk: s.lowRisk } });
    expect(v.allow).toBe(false);
    expect(v.checks.params_digest).toBe('fail');
  });

  it('step-up (t>1) without an enforced threshold verifier is denied; with one it passes', async () => {
    const s = setup();
    const a = s.mk(s.plan[1]!);
    const ctx = { plan: s.plan, risk: { reversibility: 0, blastRadius: 0.5, confidence: 0.5, semanticDistance: 1 }, params: s.params };
    const no = await verifyPCActn(a, { grant: s.grant, now: NOW, context: ctx });
    expect(no.requiredThreshold.t).toBeGreaterThan(1);
    expect(no.allow).toBe(false);
    expect(no.checks.threshold).toBe('fail');
    const yes = await verifyPCActn(a, { grant: s.grant, now: NOW, context: ctx, hooks: { threshold: () => ({ enforced: true, ok: true }) } });
    expect(yes.allow).toBe(true);
  });

  it('never throws on garbage; fails closed', async () => {
    const s = setup();
    for (const g of ['not json', '{}', 'null', '[]'] as const) {
      const v = await verifyPCActn(g, { grant: s.grant, now: NOW });
      expect(v.allow).toBe(false);
      expect(v.reasons.length).toBeGreaterThan(0);
    }
    expect((await verifyPCActn(undefined as never, { grant: s.grant })).allow).toBe(false);
  });
});

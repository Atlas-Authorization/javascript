import { describe, expect, it } from 'vitest';
import { encodePCActn } from '@atlasauth/pca';
import { memoryPcaStore, requirePCA } from './require-pca';
import { NOW, setup } from './fixture.test-util';

const b64u = (s: string) => Buffer.from(s).toString('base64url');

describe('requirePCA', () => {
  const s = setup();
  const guard = (extra = {}) =>
    requirePCA({ resolveGrant: async (ref) => (ref === s.grant.id ? s.grant : null), now: () => NOW, context: () => ({ plan: s.plan, risk: s.lowRisk }), ...extra });

  it('401 + WWW-Authenticate when no PCActn', async () => {
    const r = await guard()({ headers: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.wwwAuthenticate).toMatch(/^PCA realm=/);
    }
  });

  it('401 on undecodable header', async () => {
    const r = await guard()({ headers: { 'pca-action': b64u('not json') } });
    expect(!r.ok && r.status).toBe(401);
  });

  it('401 on unknown grant', async () => {
    const a = { ...s.mk(s.plan[0]!), grant_ref: 'nope' };
    const r = await guard()({ headers: {}, body: { pcactn: a } });
    expect(!r.ok && r.status).toBe(401);
  });

  it('ok via header and via JSON body', async () => {
    const a = s.mk(s.plan[0]!);
    const h = await guard()({ headers: { 'pca-action': b64u(encodePCActn(a)) } });
    expect(h.ok).toBe(true);
    const b = await guard()({ headers: new Headers(), body: JSON.stringify({ pcactn: a }) });
    expect(b.ok).toBe(true);
  });

  it('403 on policy deny', async () => {
    const n = { ...s.plan[0]!, verb: 'delete_account' };
    const r = await guard()({ headers: {}, body: { pcactn: s.mk(n) } });
    expect(!r.ok && r.status).toBe(403);
  });

  it('401 on tampered signature', async () => {
    const r = await guard()({ headers: {}, body: { pcactn: { ...s.mk(s.plan[0]!), counter: 7 } } });
    expect(!r.ok && r.status).toBe(401);
  });

  it('replay is denied with a store; budget drains', async () => {
    const store = memoryPcaStore();
    const g = guard({ budgetStore: store });
    const a = s.mk(s.plan[0]!, { counter: 5 });
    expect((await g({ headers: {}, body: { pcactn: a } })).ok).toBe(true);
    const again = await g({ headers: {}, body: { pcactn: a } });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.verdict.checks.counter).toBe('fail');
  });
});

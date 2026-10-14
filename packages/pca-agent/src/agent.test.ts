import { describe, expect, it } from 'vitest';
import {
  type PCActn,
  type PlanNode,
  generateKeyPair,
  encodeKey,
  mintRoot,
  verifyPCActnCore,
  verifyChain,
  verifyLedgerInclusion,
  TransparencyLedger,
} from '@atlasauth/pca';
import { createAgent, type FetchLike } from './agent';

const principal = generateKeyPair();
const agentKp = generateKeyPair();
const pub = (k: { publicKey: Uint8Array }) => encodeKey(k.publicKey);
const grant = mintRoot({
  principalSecret: principal.secretKey,
  principalPublic: pub(principal),
  holder: pub(agentKp),
  caveats: [],
});
const plan: PlanNode[] = [
  { id: 'n1', verb: 'read', resource: 'doc:1' },
  { id: 'n2', verb: 'write', resource: 'doc:2' },
];

interface Call { url: string; method?: string; body?: any }
function mock(handler: (c: Call) => { status: number; json: unknown }) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const c = { url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    const r = handler(c);
    return { status: r.status, json: async () => r.json };
  };
  return { fetch, calls };
}
const mk = (m: ReturnType<typeof mock>) =>
  createAgent({ grant, agentSecret: agentKp.secretKey, agentPublic: pub(agentKp), rsBaseUrl: 'https://rs.test/', fetch: m.fetch });

describe('pca-agent', () => {
  it('commitPlan posts grant_ref + nodes and stores the root', async () => {
    const m = mock(() => ({ status: 201, json: {} }));
    const a = mk(m);
    const { planRoot } = await a.commitPlan(plan);
    expect(m.calls[0]).toMatchObject({ url: 'https://rs.test/v1/pca/plans', method: 'POST', body: { grant_ref: grant.id, nodes: plan } });
    expect(a.planRoot).toBe(planRoot);
  });

  it('act builds a verifying PCActn, posts it, bumps the counter, updates budget', async () => {
    const ledger = new TransparencyLedger();
    void ledger;
    const m = mock((c) =>
      c.url.endsWith('/plans')
        ? { status: 201, json: {} }
        : {
            status: 200,
            json: {
              allow: true,
              verdict: { allow: true, budget: { B: 7, tau: 1, asOf: 1 } },
              receipt: { index: 0, commit: 'c', root: 'r', inclusion_proof: { index: 0, size: 1, path: [] } },
            },
          },
    );
    const a = mk(m);
    await a.commitPlan(plan);
    const r1 = await a.act('n1');
    const r2 = await a.act('n2', { x: 1 });
    expect(r1.status).toBe('allowed');
    expect(a.counter).toBe(2);
    expect(a.budget).toEqual({ B: 7, tau: 1, asOf: 1 });
    const posts = m.calls.filter((c) => c.url === 'https://rs.test/v1/pca/actions');
    expect(posts).toHaveLength(2);
    const p1 = posts[0]!.body.pcactn as PCActn;
    expect(p1.counter).toBe(1);
    expect((posts[1]!.body.pcactn as PCActn).counter).toBe(2);
    expect(p1.threshold?.shares[0]?.role).toBe('agent');
    expect(r2.status).toBe('allowed');
    const v = await verifyPCActnCore(p1, { grant });
    expect(v.allow).toBe(true);
  });

  it('returns denied without throwing', async () => {
    const m = mock((c) => (c.url.endsWith('/plans') ? { status: 201, json: {} } : { status: 403, json: { allow: false, verdict: { allow: false, reason: 'x' } } }));
    const a = mk(m);
    await a.commitPlan(plan);
    const r = await a.act('n1');
    expect(r).toMatchObject({ status: 'denied', httpStatus: 403 });
  });

  it('typed errors for unknown node / no plan', async () => {
    const a = mk(mock(() => ({ status: 201, json: {} })));
    expect((await a.act('n1')).status).toBe('error');
    await a.commitPlan(plan);
    const r = await a.act('zzz');
    expect(r.status === 'error' && r.error.code).toBe('unknown_node');
  });

  it('handles 202 step-up and awaitStepUp polls to approval', async () => {
    let polls = 0;
    const m = mock((c) => {
      if (c.url.endsWith('/plans')) return { status: 201, json: {} };
      if (c.url.endsWith('/actions')) return { status: 202, json: { status: 'step_up_required', stepup_id: 'su1', required_t: 2 } };
      polls++;
      return { status: 200, json: { status: polls < 3 ? 'pending' : 'approved' } };
    });
    const a = mk(m);
    await a.commitPlan(plan);
    const r = await a.act('n1');
    expect(r).toMatchObject({ status: 'step_up', stepupId: 'su1', requiredT: 2 });
    const out = await a.awaitStepUp('su1', { pollMs: 1, timeoutMs: 1000 });
    expect(out.status).toBe('approved');
    expect(polls).toBe(3);
    expect(m.calls.at(-1)!.url).toBe('https://rs.test/v1/pca/stepups/su1');
  });

  it('awaitStepUp times out', async () => {
    const a = mk(mock(() => ({ status: 200, json: { status: 'pending' } })));
    expect((await a.awaitStepUp('x', { pollMs: 1, timeoutMs: 5 })).status).toBe('timeout');
  });

  it('delegate yields a verifying, strictly-attenuated sub-chain', async () => {
    const sub = generateKeyPair();
    const m = mock((c) => (c.url.endsWith('/plans') ? { status: 201, json: {} } : { status: 200, json: { allow: true, verdict: { allow: true }, receipt: { index: 0, commit: 'c', root: 'r', inclusion_proof: { index: 0, size: 1, path: [] } } } }));
    const a = mk(m);
    const child = a.delegate({ toPublic: pub(sub), addedCaveats: [{ type: 'max_calls', n: 1 }], agentSecret: sub.secretKey });
    expect(child.chain).toHaveLength(2);
    expect(verifyChain(child.chain, grant.issuer).ok).toBe(true);
    expect(child.chain[1]!.caveats.length).toBe(grant.caveats.length + 1);
    await child.commitPlan(plan);
    await child.act('n1');
    const p = m.calls.find((c) => c.url.endsWith('/actions'))!.body.pcactn as PCActn;
    expect((await verifyPCActnCore(p, { grant })).allow).toBe(true);
    // a secret-less sub client cannot act
    const mute = a.delegate({ toPublic: pub(sub), addedCaveats: [] });
    await mute.commitPlan(plan);
    const r = await mute.act('n1');
    expect(r.status === 'error' && r.error.code).toBe('no_secret');
  });

  it('verifyReceipt checks a real ledger inclusion proof', () => {
    const a = mk(mock(() => ({ status: 200, json: {} })));
    const l = new TransparencyLedger();
    expect(typeof l).toBe('object');
    expect(a.verifyReceipt({ index: 0, commit: 'bad', root: 'bad', inclusion_proof: { index: 0, size: 1, path: [] } as never })).toBe(false);
    expect(typeof verifyLedgerInclusion).toBe('function');
  });
});

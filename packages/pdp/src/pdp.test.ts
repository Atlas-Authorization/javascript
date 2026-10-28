import { CompactSign, exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { buildBundle } from '../../core/src/policy-bundle/bundle';
import { DecisionShipper, LocalPdp, PdpSync, createSidecar, PolicyBundleError } from './index';

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let jwks: { keys: JWK[] };

beforeAll(async () => {
  const kp = await generateKeyPair('ES256');
  privateKey = kp.privateKey;
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }] };
});

const content = {
  abac_policies: [
    { name: 'docs', description: null, enabled: true, fga_store: 'main', source: 'permit (principal, action == Action::"read", resource) when { fga.check(principal, "viewer", resource) };', tests: [] },
    { name: 'off', description: null, enabled: false, fga_store: null, source: 'permit (principal, action, resource);', tests: [] },
  ],
  fga_stores: [
    {
      name: 'main',
      model: {
        schema_version: '1.1',
        type_definitions: [
          { type: 'user' },
          { type: 'doc', relations: { viewer: { this: {} } }, metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } } },
        ],
      },
    },
  ],
};

async function signed(c = content) {
  const b = buildBundle(c);
  const jws = await new CompactSign(b.archive).setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'atlas-policy-bundle+jws' }).sign(privateKey);
  const [h, , s] = jws.split('.');
  return { bundle: b.archive, signature: `${h}..${s}`, revision: b.revision };
}

const req = (id: string) => ({ principal: { type: 'User', id }, action: { id: 'read' }, resource: { type: 'Doc', id: '1' } });

describe('LocalPdp', () => {
  it('verifies a bundle offline, then decides with tuple data and honours expiry', async () => {
    const b = await signed();
    let now = 1_000;
    const pdp = await LocalPdp.load({ bundle: b.bundle, signature: b.signature, jwks, expectedRevision: b.revision, now: () => now });
    expect(pdp.revision).toBe(b.revision);
    expect((await pdp.authorize(req('a'))).decision).toBe('deny');
    pdp.loadTuples('main', [
      { user: 'user:a', relation: 'viewer', object: 'doc:1', expires_at: 5_000 },
      { user: 'user:b', relation: 'viewer', object: 'doc:1' },
    ], { revision: 3 });
    expect((await pdp.authorize(req('a'))).decision).toBe('allow');
    expect((await pdp.authorize(req('b'))).reasons).toEqual(['docs']);
    now = 5_000;
    expect((await pdp.authorize(req('a'))).decision).toBe('deny');
    pdp.applyChanges('main', [{ operation: 'delete', user: 'user:b', relation: 'viewer', object: 'doc:1' }], 4);
    expect((await pdp.authorize(req('b'))).decision).toBe('deny');
    expect(pdp.storeRevision('main')).toBe(4);
    expect(await pdp.check('main', { user: 'user:zed', relation: 'viewer', object: 'doc:1' })).toBe(false);
  });

  it('refuses a tampered archive, a foreign key and a pinned-revision mismatch', async () => {
    const b = await signed();
    const tampered = Uint8Array.from(b.bundle);
    tampered[tampered.length - 12]! ^= 0xff;
    await expect(LocalPdp.load({ bundle: tampered, signature: b.signature, jwks })).rejects.toBeInstanceOf(PolicyBundleError);
    const other = await generateKeyPair('ES256');
    const foreign = { keys: [{ ...(await exportJWK(other.publicKey)), kid: 'k1', alg: 'ES256' }] };
    await expect(LocalPdp.load({ bundle: b.bundle, signature: b.signature, jwks: foreign })).rejects.toMatchObject({ code: 'invalid_signature' });
    await expect(LocalPdp.load({ bundle: b.bundle, signature: b.signature, jwks, expectedRevision: 'rev_other' })).rejects.toBeInstanceOf(PolicyBundleError);
  });

  it('keeps tuples across a bundle swap for stores that keep their name', async () => {
    const b = await signed();
    const pdp = await LocalPdp.load({ bundle: b.bundle, signature: b.signature, jwks });
    pdp.loadTuples('main', [{ user: 'user:a', relation: 'viewer', object: 'doc:1' }]);
    const b2 = await signed({ ...content, abac_policies: [...content.abac_policies, { name: 'x', description: null, enabled: true, fga_store: null, source: 'forbid (principal, action, resource) when { false };', tests: [] }] });
    await pdp.loadBundle({ bundle: b2.bundle, signature: b2.signature, jwks });
    expect(pdp.revision).toBe(b2.revision);
    expect((await pdp.authorize(req('a'))).decision).toBe('allow');
  });
});

describe('sidecar', () => {
  it('serves AuthZEN and OpenFGA-shaped calls, fails closed on bad input, and enforces the token', async () => {
    const b = await signed();
    const pdp = await LocalPdp.load({ bundle: b.bundle, signature: b.signature, jwks });
    pdp.loadTuples('main', [{ user: 'user:a', relation: 'viewer', object: 'doc:1' }]);
    const server = createSidecar({ pdp, token: 'secret' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (path: string, body: unknown, token = 'secret') => fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await call('/access/v1/evaluation', {}, 'nope')).status).toBe(401);
      const ev = { subject: { type: 'user', id: 'a' }, resource: { type: 'doc', id: '1' }, action: { name: 'read' } };
      expect(await (await call('/access/v1/evaluation', ev)).json()).toMatchObject({ decision: true });
      expect(await (await call('/access/v1/evaluation', { ...ev, subject: { type: 'user', id: 'z' } })).json()).toMatchObject({ decision: false });
      expect(await (await call('/access/v1/evaluations', { ...ev, evaluations: [{}, { subject: { type: 'user', id: 'z' } }] })).json()).toEqual({ evaluations: [{ decision: true }, { decision: false }] });
      expect((await call('/access/v1/evaluation', { subject: ev.subject })).status).toBe(400);
      expect(await (await call('/stores/main/check', { tuple_key: { user: 'user:a', relation: 'viewer', object: 'doc:1' } })).json()).toEqual({ allowed: true });
      expect(await (await call('/stores/main/list-objects', { user: 'user:a', relation: 'viewer', type: 'doc' })).json()).toEqual({ objects: ['doc:1'] });
      expect((await call('/stores/nope/check', { tuple_key: { user: 'user:a', relation: 'viewer', object: 'doc:1' } })).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('PdpSync and DecisionShipper', () => {
  it('syncs bundle then tuples (full, then delta) and ships decisions', async () => {
    const b = await signed();
    const calls: string[] = [];
    let ingested: { decisions: unknown[]; pdp: { bundle_revision: string } } | undefined;
    const base64 = Buffer.from(b.bundle).toString('base64');
    const fakeFetch = (async (url: string, init?: { method?: string; body?: string }) => {
      const path = url.replace('https://atlas.test', '');
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v });
      if (path === '/v1/policy_bundles/current') return json({ revision: b.revision });
      if (path.startsWith('/v1/policy_bundles/rev')) return json({ bundle: base64, signature: b.signature, revision: b.revision });
      if (path === '/v1/fga/stores') return json({ data: [{ id: 'fgas_1', name: 'main' }] });
      if (path === '/v1/fga/stores/fgas_1/snapshot') return json({ full: true, revision: 7, tuples: [{ user: 'user:a', relation: 'viewer', object: 'doc:1' }], has_more: false });
      if (path === '/v1/fga/stores/fgas_1/snapshot?since=7') return json({ full: false, revision: 8, changes: [{ operation: 'write', user: 'user:c', relation: 'viewer', object: 'doc:1' }], has_more: false });
      if (path === '/v1/authz_decisions/ingest') {
        ingested = JSON.parse(init!.body!);
        return json({ accepted: 1 });
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const pdp = new LocalPdp();
    const sync = new PdpSync({ pdp, baseUrl: 'https://atlas.test', apiKey: 'sk', jwks: jwks as unknown as { keys: Record<string, unknown>[] }, fetch: fakeFetch });
    expect((await sync.syncOnce()).bundleChanged).toBe(true);
    expect((await pdp.authorize(req('a'))).decision).toBe('allow');
    expect((await sync.syncOnce()).bundleChanged).toBe(false);
    expect(pdp.storeRevision('main')).toBe(8);
    expect((await pdp.authorize(req('c'))).decision).toBe('allow');
    expect(calls.filter((c) => c.includes('policy_bundles/rev')).length).toBe(1);

    const shipper = new DecisionShipper({ baseUrl: 'https://atlas.test', apiKey: 'sk', pdp: { id: 'p1' }, revision: () => pdp.revision, fetch: fakeFetch });
    pdp.onDecision = shipper.push;
    await pdp.authorize(req('a'));
    expect(await shipper.flush()).toBe(1);
    expect(ingested!.decisions).toHaveLength(1);
    expect(ingested!.pdp.bundle_revision).toBe(b.revision);
  });
});

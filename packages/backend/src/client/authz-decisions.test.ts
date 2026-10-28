import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

const SECRET = 'sk_test_placeholder_not_a_real_key';
const API_URL = 'https://api.example.test';

function setup(responses: unknown[]) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined });
    return new Response(JSON.stringify(responses[Math.min(i++, responses.length - 1)]), { status: 200 });
  });
  return { atlas: createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl as unknown as typeof fetch }), calls };
}

const row = (id: string) => ({ object: 'authz_decision', id, source: 'abac', decision: 'allow', principal: null, action: null, resource: null, input: null, result: {}, policy_revision: null, policy_version: null, latency_ms: 1, sample_rate: 1, actor_id: null, created_at: 1 });

describe('authzDecisions', () => {
  it('lists with filters, and iterate() follows the cursor', async () => {
    const { atlas, calls } = setup([
      { object: 'list', data: [row('a'), row('b')], has_more: true, next_cursor: 'b' },
      { object: 'list', data: [row('c')], has_more: false, next_cursor: null },
    ]);
    const seen: string[] = [];
    for await (const d of atlas.authzDecisions.iterate({ source: 'abac', decision: 'deny', limit: 2 })) seen.push(d.id);
    expect(seen).toEqual(['a', 'b', 'c']);
    const first = new URL(calls[0]!.url);
    expect(first.pathname).toBe('/v1/authz_decisions');
    expect(Object.fromEntries(first.searchParams)).toEqual({ source: 'abac', decision: 'deny', limit: '2' });
    expect(new URL(calls[1]!.url).searchParams.get('starting_after')).toBe('b');
  });

  it('gets one, reads stats, and reads/updates the settings', async () => {
    const { atlas, calls } = setup([row('x'), { object: 'authz_decision_stats' }, { object: 'authz_decision_settings', enabled: false }, { object: 'authz_decision_settings', enabled: true }]);
    await atlas.authzDecisions.get('x');
    await atlas.authzDecisions.stats({ since: 1000 });
    await atlas.authzDecisions.settings.get();
    await atlas.authzDecisions.settings.update({ enabled: true, input_mode: 'full', redact: ['context.ip'] });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /v1/authz_decisions/x',
      'GET /v1/authz_decisions/stats',
      'GET /v1/authz_decision_settings',
      'PUT /v1/authz_decision_settings',
    ]);
    expect(JSON.parse(calls[3]!.body!)).toEqual({ enabled: true, input_mode: 'full', redact: ['context.ip'] });
    expect(new URL(calls[1]!.url).searchParams.get('since')).toBe('1000');
  });
});

describe('policyBundles', () => {
  it('exports, lists, reads and checks the current revision', async () => {
    const { atlas, calls } = setup([{ object: 'policy_bundle' }, { object: 'list', data: [], has_more: false }, { object: 'policy_bundle_revision', revision: 'rev_1' }, { object: 'policy_bundle' }]);
    await atlas.policyBundles.export();
    await atlas.policyBundles.list();
    expect((await atlas.policyBundles.current()).revision).toBe('rev_1');
    await atlas.policyBundles.get('rev_1');
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['POST /v1/policy_bundles', 'GET /v1/policy_bundles', 'GET /v1/policy_bundles/current', 'GET /v1/policy_bundles/rev_1']);
  });

  it('verifies and imports, base64-encoding a Uint8Array bundle', async () => {
    const { atlas, calls } = setup([{ object: 'policy_bundle_verification', valid: true }, { object: 'policy_bundle_import', dry_run: true }]);
    await atlas.policyBundles.verify({ bundle: new Uint8Array([1, 2, 3]), signature: 'h..s' });
    await atlas.policyBundles.import({ bundle: 'AQID', signature: 'h..s', dry_run: true, prune: false, trusted_jwks: { keys: [] } });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ bundle: 'AQID', signature: 'h..s' });
    expect(calls[1]!.url).toBe(`${API_URL}/v1/policy_bundles/import`);
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({ dry_run: true, prune: false, trusted_jwks: { keys: [] } });
  });
});

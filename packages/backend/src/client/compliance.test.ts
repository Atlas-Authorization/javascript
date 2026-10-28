import { describe, expect, it } from 'vitest';
import { createAtlasClient, createAtlasPlatformClient } from './index';

/** A fetch stub recording each call and answering with `body`. */
function stub(body: unknown = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('provisioning, notices, advisories, sub-processors and audit export', () => {
  it('dryRun adds ?dry_run=true to writes only and never sends an Idempotency-Key', async () => {
    const { calls, fetchImpl } = stub({ object: 'dry_run' });
    const atlas = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: 'https://api.test', fetch: fetchImpl }).withOptions({ dryRun: true });
    await atlas.oauthClients.create({ name: 'web', redirect_uris: ['https://a.test/cb'] }, 'idem-1');
    await atlas.oauthClients.list();
    expect(calls[0]!.url).toBe('https://api.test/v1/oauth_clients?dry_run=true');
    expect((calls[0]!.init.headers as Record<string, string>)['idempotency-key']).toBeUndefined();
    expect(calls[1]!.url).toBe('https://api.test/v1/oauth_clients');
  });

  it('serializes metadata filters as metadata[key]=value', async () => {
    const { calls, fetchImpl } = stub({ object: 'list', data: [] });
    const atlas = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: 'https://api.test', fetch: fetchImpl });
    await atlas.webhooks.endpoints.list({ metadata: { product: 'referalli', sandbox: true } });
    expect(calls[0]!.url).toBe('https://api.test/v1/webhook_endpoints?metadata%5Bproduct%5D=referalli&metadata%5Bsandbox%5D=true');
  });

  it('calls the notice, advisory, sub-processor and audit export routes', async () => {
    const { calls, fetchImpl } = stub({});
    const atlas = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: 'https://api.test', fetch: fetchImpl });
    await atlas.notices.list({ all: true });
    await atlas.notices.acknowledge('email_verified_requires_proof');
    await atlas.securityAdvisories.list();
    await atlas.subProcessors.get();
    await atlas.auditExports.create({ name: 'siem', type: 'webhook', destination: { url: 'https://siem.test/in' } });
    await atlas.auditExports.test('aex_1');
    expect(calls.map((c) => `${c.init.method} ${c.url.replace('https://api.test', '')}`)).toEqual([
      'GET /v1/instance/notices?all=true',
      'POST /v1/instance/notices/email_verified_requires_proof/acknowledge',
      'GET /v1/security_advisories',
      'GET /v1/instance/sub_processors',
      'POST /v1/audit_exports',
      'POST /v1/audit_exports/aex_1/test',
    ]);
  });

  it('platform: external_ref create, sandbox teardown, clone_config, named secret keys', async () => {
    const { calls, fetchImpl } = stub({});
    const platform = createAtlasPlatformClient({ platformKey: 'psk_x', apiUrl: 'https://api.test', fetch: fetchImpl });
    await platform.apps.create({ name: 'R', external_ref: 'referalli/prod', metadata: { env: 'prod' } });
    await platform.apps.list({ metadata: { product: 'referalli' } });
    await platform.apps.sandboxTeardown({ sandbox: true }, { dryRun: true });
    await platform.apps.cloneConfig('ins_1');
    await platform.apps.createSecretKey('ins_1', { name: 'deploy', external_ref: 'keys/deploy' });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ external_ref: 'referalli/prod' });
    expect(calls[1]!.url).toContain('metadata%5Bproduct%5D=referalli');
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ metadata: { sandbox: true }, dry_run: true });
    expect(calls[3]!.url).toBe('https://api.test/v1/platform/apps/ins_1/clone_config');
    expect(calls[4]!.url).toBe('https://api.test/v1/platform/apps/ins_1/secret_keys');
  });
});

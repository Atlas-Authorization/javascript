import { describe, expect, it } from 'vitest';
import { createAtlasClient, createAtlasPlatformClient } from './index';

function stub(body: unknown = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('config snapshots', () => {
  const client = (fetchImpl: typeof fetch) => createAtlasClient({ secretKey: 'sk_test_x', apiUrl: 'https://api.test', fetch: fetchImpl });

  it('saves, lists, reads and deletes', async () => {
    const { calls, fetchImpl } = stub({});
    const atlas = client(fetchImpl);
    await atlas.configSnapshots.create({ label: 'before launch' }, 'idem-1');
    await atlas.configSnapshots.list({ source: 'manual', limit: 5 });
    await atlas.configSnapshots.get('csnap_1');
    await atlas.configSnapshots.delete('csnap_1');
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'POST https://api.test/v1/instance/config_snapshots',
      'GET https://api.test/v1/instance/config_snapshots?source=manual&limit=5',
      'GET https://api.test/v1/instance/config_snapshots/csnap_1',
      'DELETE https://api.test/v1/instance/config_snapshots/csnap_1',
    ]);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ label: 'before launch' });
    expect((calls[0]!.init.headers as Record<string, string>)['idempotency-key']).toBe('idem-1');
  });

  it('diffs against the live configuration and restores with a preview first', async () => {
    const { calls, fetchImpl } = stub({});
    const atlas = client(fetchImpl);
    await atlas.configSnapshots.diff({ from: 'csnap_1' });
    await atlas.configSnapshots.restore('csnap_1', { dry_run: true });
    await atlas.configSnapshots.restore('csnap_1', { expected_sha256: 'abc' });
    expect(calls[0]!.url).toBe('https://api.test/v1/instance/config_snapshots/diff?from=csnap_1');
    expect(calls[1]!.url).toBe('https://api.test/v1/instance/config_snapshots/csnap_1/restore');
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ dry_run: true });
    expect(JSON.parse(calls[2]!.init.body as string)).toEqual({ expected_sha256: 'abc' });
  });
});

describe('environment clones and previews', () => {
  it('opens, lists, reads and deletes a preview through the platform client', async () => {
    const { calls, fetchImpl } = stub({});
    const platform = createAtlasPlatformClient({ platformKey: 'psk_test_x', apiUrl: 'https://api.test', fetch: fetchImpl });
    await platform.apps.instances.clones.create('ins_app', 'ins_src', { mode: 'preview', ref: 'pr-42', include: ['config', 'roles'], ttl_hours: 24 }, 'idem-2');
    await platform.apps.instances.clones.list('ins_app', 'ins_src', { kind: 'preview' });
    await platform.apps.instances.clones.get('ins_app', 'ins_src', 'iclone_1');
    await platform.apps.instances.clones.refresh('ins_app', 'ins_src', 'iclone_1', { synthetic_users: { count: 3, seed: 's' } });
    await platform.apps.instances.clones.delete('ins_app', 'ins_src', 'iclone_1');
    const base = 'https://api.test/v1/platform/apps/ins_app/instances/ins_src/clones';
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([`POST ${base}`, `GET ${base}?kind=preview`, `GET ${base}/iclone_1`, `POST ${base}/iclone_1/refresh`, `DELETE ${base}/iclone_1`]);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ mode: 'preview', ref: 'pr-42', include: ['config', 'roles'], ttl_hours: 24 });
  });
});

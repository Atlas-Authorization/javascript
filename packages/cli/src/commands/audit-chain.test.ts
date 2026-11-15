import { describe, expect, it } from 'vitest';
import { auditChainGenesis, auditLinkHash, auditRowHash, type AuditChainLink, type ChainedAuditRow } from '@atlasauth/backend';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';

const row = (n: number): ChainedAuditRow => ({
  id: `aud_${n}`,
  actor_type: 'api_key',
  actor_id: 'key_1',
  action: 'user.created',
  target_type: 'user',
  target_id: `user_${n}`,
  ip: null,
  user_agent: null,
  metadata: {},
  created_at: 1_700_000_000_000 + n,
});

function chain(count: number): AuditChainLink[] {
  let prev = auditChainGenesis('ins_1');
  return Array.from({ length: count }, (_, i) => {
    const r = row(i + 1);
    const rowHash = auditRowHash(r);
    prev = auditLinkHash(prev, i + 1, rowHash);
    return { seq: i + 1, audit_id: r.id, row_hash: rowHash, link_hash: prev, row: r };
  });
}

function ctx(io: ReturnType<typeof captureIO>, links: AuditChainLink[], enabled = true): RunContext {
  const status = { enabled, genesis_hash: auditChainGenesis('ins_1'), head_seq: links.length, head_hash: links.at(-1)?.link_hash ?? null, jwks_uri: 'https://auth.test/jwks', unchained_rows: 0 };
  const http = {
    get: async (p: string) => {
      if (p === '/v1/audit/chain') return status;
      if (p.startsWith('/v1/audit/chain/checkpoints')) return { data: [], has_more: false };
      const m = /after_seq=(\d+)&limit=(\d+)/.exec(p);
      if (m) {
        const data = links.filter((l) => l.seq > Number(m[1])).slice(0, Number(m[2]));
        return { data, has_more: links.filter((l) => l.seq > Number(m[1])).length > data.length, next_after_seq: data.at(-1)?.seq ?? Number(m[1]) };
      }
      throw new Error(`unexpected ${p}`);
    },
  } as unknown as ConfigHttp;
  return {
    io,
    env: {},
    config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: () => http,
    readFile: () => '',
    sleep: async () => undefined,
    fetch: (async () => new Response(JSON.stringify({ keys: [] }), { status: 200 })) as unknown as typeof fetch,
  };
}

describe('atlas audit verify', () => {
  it('exits 0 and reports an intact chain', async () => {
    const io = captureIO();
    expect(await run(['audit', 'verify'], ctx(io, chain(4)))).toBe(0);
    expect(io.stdout()).toContain('Audit chain intact: 4 links verified up to #4');
  });

  it('exits 1 and names the first broken link when a row was changed', async () => {
    const links = chain(4);
    links[1] = { ...links[1]!, row: { ...links[1]!.row!, action: 'user.deleted' } };
    const io = captureIO();
    expect(await run(['audit', 'verify'], ctx(io, links))).toBe(1);
    expect(io.stdout()).toContain('DOES NOT VERIFY after 1 good link');
    expect(io.stdout()).toContain('#2: an audit row was changed after it was chained');
  });

  it('exits 1 when a link was removed', async () => {
    const links = chain(5);
    links.splice(2, 1);
    const io = captureIO();
    expect(await run(['audit', 'verify'], ctx(io, links))).toBe(1);
    expect(io.stdout()).toContain('#3: a link is missing from the sequence');
  });

  it('refuses when the chain is not on, and prints JSON on request', async () => {
    const io = captureIO();
    expect(await run(['audit', 'verify'], ctx(io, [], false))).toBe(1);
    expect(io.stderr()).toContain('not on');
    const io2 = captureIO();
    expect(await run(['audit', 'verify', '--json'], ctx(io2, chain(2)))).toBe(0);
    expect(JSON.parse(io2.stdout())).toMatchObject({ ok: true, checked: 2, last_seq: 2 });
  });

  it('starts after a link with --after', async () => {
    const io = captureIO();
    expect(await run(['audit', 'verify', '--after', '2'], ctx(io, chain(5)))).toBe(0);
    expect(io.stdout()).toContain('3 links verified up to #5');
  });
});

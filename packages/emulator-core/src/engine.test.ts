/* eslint-disable @typescript-eslint/no-explicit-any */
import { AtlasBackend, verifyAtlasWebhook } from '@atlasauth/backend';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ERROR_CATALOG } from './error-catalog';
import { KEY, client, makeEngine } from './test-support';

describe('error catalog copy', () => {
  it('matches the API error catalog (run npm run sync-error-catalog when it fails)', () => {
    const src = JSON.parse(readFileSync(resolve(__dirname, '../../shared/src/error-catalog.json'), 'utf8')) as Record<string, { status: number; title: string }>;
    for (const [code, v] of Object.entries(src)) expect(ERROR_CATALOG[code]).toEqual({ status: v.status, title: v.title });
  });
});

describe('request pipeline', () => {
  const e = makeEngine();
  const call = client(e);

  it('refuses a missing key (401 UNAUTHENTICATED) and a wrong key (401 INVALID_KEY)', async () => {
    expect((await client(e, null)('GET', '/v1/users')).json.errors[0].code).toBe('UNAUTHENTICATED');
    const bad = await client(e, 'sk_nope')('GET', '/v1/users');
    expect(bad.status).toBe(401);
    expect(bad.json.errors[0].code).toBe('INVALID_KEY');
  });

  it('answers 404 ROUTE_NOT_FOUND with the methods the path does support', async () => {
    const r = await call('DELETE', '/v1/roles');
    expect(r.status).toBe(404);
    expect(r.json.errors[0]).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
    expect(r.json.errors[0].allowed_methods).toContain('GET');
  });

  it('enforces the scope the OpenAPI document names', async () => {
    const limited = makeEngine({ secretKeys: [{ key: 'sk_ro', scopes: ['users:read'] }] });
    const c = client(limited, 'sk_ro');
    expect((await c('GET', '/v1/users')).status).toBe(200);
    const w = await c('POST', '/v1/users', { email_address: 'a@example.com' });
    expect(w.status).toBe(403);
    expect(w.json.errors[0].code).toBe('SCOPE_MISSING');
  });

  it('validates bodies: 400 with the field path, unknown fields noted, 422 when strict', async () => {
    const bad = await call('POST', '/v1/users', { email_address: 5 });
    expect(bad.status).toBe(400);
    expect(bad.json.errors[0].code).toBe('VALIDATION_FAILED');
    const lenient = await call('POST', '/v1/users', { email_address: 'lenient@example.com', surprise: true });
    expect(lenient.status).toBe(201);
    expect(lenient.headers.get('atlas-unknown-fields')).toBe('surprise');
    const strict = await call('POST', '/v1/users', { email_address: 'strict@example.com', surprise: true }, { 'Atlas-Strict': 'true' });
    expect(strict.status).toBe(422);
    expect(strict.json.errors[0]).toMatchObject({ code: 'UNKNOWN_FIELD', param: 'surprise' });
    expect((await makeEngine({ strict: true }).handle(new Request('http://x/v1/users', { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ email_address: 'a@example.com', surprise: 1 }) }))).status).toBe(422);
  });

  it('replays an idempotent POST and refuses the same key with a different body', async () => {
    const h = { 'Idempotency-Key': 'k1' };
    const a = await call('POST', '/v1/organizations', { name: 'Idem' }, h);
    const b = await call('POST', '/v1/organizations', { name: 'Idem' }, h);
    expect(b.json.id).toBe(a.json.id);
    expect(b.headers.get('idempotent-replayed')).toBe('true');
    const c = await call('POST', '/v1/organizations', { name: 'Other' }, h);
    expect(c.status).toBe(409);
    expect(c.json.errors[0].code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('users, organizations, roles', () => {
  it('creates, finds, updates and deletes a user; never shows private metadata', async () => {
    const e = makeEngine();
    const call = client(e);
    const created = await call('POST', '/v1/users', { email_address: 'Ada@Example.com', first_name: 'Ada', public_metadata: { a: 1 }, private_metadata: { secret: true } });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ object: 'user', primary_email: 'Ada@Example.com', public_metadata: { a: 1 }, banned: false, version: 1 });
    expect(JSON.stringify(created.json)).not.toContain('secret');
    const id = created.json.id as string;
    expect((await call('POST', '/v1/users', { email_address: 'ada@example.com' })).json.errors[0].code).toBe('IDENTIFIER_EXISTS');
    expect((await call('GET', '/v1/users?email_address=ada@example.com')).json.data.map((u: any) => u.id)).toEqual([id]);
    const patched = await call('PATCH', `/v1/users/${id}`, { last_name: 'Lovelace', public_metadata: { b: 2 } });
    expect(patched.json).toMatchObject({ last_name: 'Lovelace', public_metadata: { a: 1, b: 2 }, version: 2 });
    const replaced = await call('PUT', `/v1/users/${id}/metadata`, { public_metadata: { only: 1 } });
    expect(replaced.json.public_metadata).toEqual({ only: 1 });
    expect((await call('POST', `/v1/users/${id}/ban`, { reason: 'spam' })).json).toMatchObject({ banned: true, ban_reason: 'spam' });
    expect((await call('DELETE', `/v1/users/${id}`)).status).toBe(200);
    expect((await call('GET', `/v1/users/${id}`)).status).toBe(404);
    expect((await call('GET', '/v1/users')).json.data).toEqual([]);
  });

  it('paginates newest first by cursor', async () => {
    const e = makeEngine();
    const call = client(e);
    for (const n of [1, 2, 3]) await call('POST', '/v1/users', { email_address: `p${n}@example.com` });
    const first = await call('GET', '/v1/users?limit=2');
    expect(first.json).toMatchObject({ object: 'list', has_more: true });
    expect(first.json.data.map((u: any) => u.primary_email)).toEqual(['p3@example.com', 'p2@example.com']);
    const next = await call('GET', `/v1/users?limit=2&starting_after=${first.json.next_cursor}`);
    expect(next.json.data.map((u: any) => u.primary_email)).toEqual(['p1@example.com']);
    expect(next.json.has_more).toBe(false);
  });

  it('organizations: unique slug, creator seated as admin, memberships, cascade on delete', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'owner@example.com' })).json;
    const m = (await call('POST', '/v1/users', { email_address: 'member@example.com' })).json;
    const a = (await call('POST', '/v1/organizations', { name: 'Acme Inc', created_by: u.id })).json;
    const b = (await call('POST', '/v1/organizations', { name: 'Acme Inc' })).json;
    expect([a.slug, b.slug]).toEqual(['acme-inc', 'acme-inc-2']);
    expect((await call('POST', '/v1/organizations', { name: 'X', slug: 'acme-inc' })).json.errors[0].code).toBe('IDENTIFIER_EXISTS');
    expect((await call('GET', `/v1/organizations/${a.id}/memberships`)).json.data.map((x: any) => [x.user_id, x.role])).toEqual([[u.id, 'org:admin']]);
    const add = await call('POST', `/v1/organizations/${a.id}/memberships`, { user_id: m.id });
    expect(add.json).toMatchObject({ role: 'org:member', organization_id: a.id });
    expect((await call('POST', `/v1/organizations/${a.id}/memberships`, { user_id: m.id })).status).toBe(409);
    expect((await call('GET', `/v1/users/${m.id}/organization_memberships`)).json.data).toHaveLength(1);
    await call('DELETE', `/v1/organizations/${a.id}`);
    expect((await call('GET', `/v1/users/${m.id}/organization_memberships`)).json.data).toEqual([]);
  });

  it('roles and permissions: system roles are seeded and protected; in-use roles cannot be deleted', async () => {
    const e = makeEngine();
    const call = client(e);
    const roles = (await call('GET', '/v1/roles')).json.data as any[];
    expect(roles.map((r) => r.key)).toEqual(expect.arrayContaining(['org:admin', 'org:member']));
    expect((await call('POST', '/v1/roles', { key: 'sys_x' })).status).toBe(400);
    const perm = await call('POST', '/v1/permissions', { key: 'org:invoices:manage', name: 'Manage invoices' });
    expect(perm.status).toBe(200);
    expect((await call('POST', '/v1/permissions', { key: 'badkey' })).status).toBe(400);
    const role = (await call('POST', '/v1/roles', { key: 'org:billing', name: 'Billing', permissions: ['org:invoices:manage'] })).json;
    expect(role.permissions).toEqual(['org:invoices:manage']);
    expect((await call('POST', '/v1/roles', { key: 'org:billing' })).status).toBe(409);
    expect((await call('POST', '/v1/roles', { key: 'org:x', permissions: ['nope:nope'] })).status).toBe(400);
    const u = (await call('POST', '/v1/users', { email_address: 'r@example.com' })).json;
    const o = (await call('POST', '/v1/organizations', { name: 'R' })).json;
    await call('POST', `/v1/organizations/${o.id}/memberships`, { user_id: u.id, role: 'org:billing' });
    expect((await call('DELETE', `/v1/roles/${role.id}`)).json.errors[0].code).toBe('ROLE_IN_USE');
    expect((await call('DELETE', `/v1/roles/${roles.find((r) => r.key === 'org:admin').id}`)).status).toBe(403);
  });

  it('org invitation emails land in the message sink', async () => {
    const e = makeEngine();
    const call = client(e);
    const o = (await call('POST', '/v1/organizations', { name: 'Inv' })).json;
    await call('POST', `/v1/organizations/${o.id}/invitations`, { email: 'new@example.com', role: 'org:member' });
    const msg = await e.messages.waitFor({ to: 'NEW@example.com', channel: 'email' }, 100);
    expect(msg.link).toContain('/accept-invitation?token=');
  });
});

describe('API keys', () => {
  it('mints once, verifies, enforces scope and use budget, lists revocations', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'k@example.com' })).json;
    expect((await call('POST', '/v1/api_keys', { subject_type: 'user', subject_id: 'user_nope' })).status).toBe(404);
    const k = (await call('POST', '/v1/api_keys', { subject_type: 'user', subject_id: u.id, name: 'ci', scopes: ['read'], remaining: 1, expires_in_seconds: 60 })).json;
    expect(k.secret).toMatch(/^ak_/);
    expect(JSON.stringify((await call('GET', `/v1/api_keys/${k.id}`)).json)).not.toContain(k.secret);
    expect((await call('POST', '/v1/api_keys/verify', { secret: k.secret, required_scopes: ['write'] })).json).toMatchObject({ valid: false, code: 'insufficient_scope' });
    expect((await call('POST', '/v1/api_keys/verify', { secret: k.secret })).json).toMatchObject({ valid: true, subject_id: u.id });
    expect((await call('POST', '/v1/api_keys/verify', { secret: k.secret })).json).toMatchObject({ valid: false, code: 'usage_exhausted' });
    expect((await call('POST', '/v1/api_keys/verify', { secret: 'ak_unknown' })).json).toEqual({ object: 'api_key_verification', valid: false });
    await call('DELETE', `/v1/api_keys/${k.id}`);
    expect((await call('POST', '/v1/api_keys/verify', { secret: k.secret })).json.valid).toBe(false);
    expect((await call('GET', '/v1/api_keys/revoked')).json.data.map((r: any) => r.id)).toEqual([k.id]);
  });

  it('a key expires when the clock passes expires_at', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'x@example.com' })).json;
    const k = (await call('POST', '/v1/api_keys', { subject_type: 'user', subject_id: u.id, expires_in_seconds: 60 })).json;
    expect((await call('POST', '/v1/api_keys/verify', { secret: k.secret })).json.valid).toBe(true);
    e.clock.advance(61_000);
    expect((await call('POST', '/v1/api_keys/verify', { secret: k.secret })).json.valid).toBe(false);
  });
});

describe('machines, grants and usage counters', () => {
  const setup = async () => {
    const e = makeEngine();
    const call = client(e);
    const m = (await call('POST', '/v1/machines', { name: 'bot' })).json;
    const g = (await call('POST', `/v1/machines/${m.id}/grants`, { resource_server_id: 'rs_1', scopes: ['orders:write'], constraints: { counters: { orders: { limit: 3, window: 'day' }, spend: { limit: 100, window: 'none', amount_field: 'cents' } } } })).json;
    return { e, call, m, g };
  };

  it('creates a machine with a one-time secret; refuses a second live grant for a resource server', async () => {
    const { call, m } = await setup();
    expect(m.secret).toMatch(/^mk_/);
    expect(JSON.stringify((await call('GET', `/v1/machines/${m.id}`)).json)).not.toContain(m.secret);
    expect((await call('POST', `/v1/machines/${m.id}/grants`, { resource_server_id: 'rs_1', scopes: [] })).status).toBe(409);
    expect((await call('POST', `/v1/machines/${m.id}/grants`, { resource_server_id: 'rs_2', scopes: [], constraints: { counters: { Bad: { limit: 1 } } } })).status).toBe(400);
  });

  it('consume stops exactly at the limit; a denial is a 200; a replay returns the stored decision', async () => {
    const { call, g } = await setup();
    const consume = (key: string) => call('POST', `/v1/grants/machine/${g.id}/consume`, { counter: 'orders', idempotency_key: key });
    const results = [];
    for (const k of ['a', 'b', 'c', 'd']) results.push((await consume(k)).json);
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3]).toMatchObject({ reason: 'limit_reached', used: 3, remaining: 0 });
    expect((await consume('b')).json).toMatchObject({ allowed: true, replayed: true, used: 2 });
    expect((await call('POST', `/v1/grants/machine/${g.id}/consume`, { counter: 'nope', idempotency_key: 'z' })).status).toBe(400);
  });

  it('the limit is read from the grant: PATCH raises it live; windows roll with the clock', async () => {
    const { e, call, m, g } = await setup();
    const consume = (key: string) => call('POST', `/v1/grants/machine/${g.id}/consume`, { counter: 'orders', amount: 3, idempotency_key: key });
    expect((await consume('1')).json.allowed).toBe(true);
    expect((await consume('2')).json.allowed).toBe(false);
    await call('PATCH', `/v1/machines/${m.id}/grants/${g.id}`, { constraints: { counters: { orders: { limit: 6, window: 'day' } } } });
    expect((await consume('3')).json).toMatchObject({ allowed: true, used: 6 });
    e.clock.advance(2 * 86_400_000);
    expect((await consume('4')).json).toMatchObject({ allowed: true, used: 3 });
  });

  it('amount_field counters take the amount from context and refuse leases', async () => {
    const { call, g } = await setup();
    const spend = (body: object) => call('POST', `/v1/grants/machine/${g.id}/consume`, { counter: 'spend', ...body });
    expect((await spend({ idempotency_key: 's1', context: { cents: 60 } })).json).toMatchObject({ allowed: true, used: 60 });
    expect((await spend({ idempotency_key: 's2', context: { cents: 60 } })).json.allowed).toBe(false);
    expect((await spend({ idempotency_key: 's3' })).status).toBe(400);
    expect((await spend({ idempotency_key: 's4', context: { cents: 1 }, lease: true })).status).toBe(400);
  });

  it('refund is bounded by the consume and idempotent', async () => {
    const { call, g } = await setup();
    const base = `/v1/grants/machine/${g.id}`;
    await call('POST', `${base}/consume`, { counter: 'orders', amount: 2, idempotency_key: 'c1' });
    const r1 = await call('POST', `${base}/refund`, { counter: 'orders', idempotency_key: 'r1', consume_idempotency_key: 'c1', amount: 1 });
    expect(r1.json).toMatchObject({ refunded: true, amount: 1, used: 1 });
    expect((await call('POST', `${base}/refund`, { counter: 'orders', idempotency_key: 'r1', consume_idempotency_key: 'c1', amount: 1 })).json).toMatchObject({ replayed: true, used: 1 });
    expect((await call('POST', `${base}/refund`, { counter: 'orders', idempotency_key: 'r2', consume_idempotency_key: 'c1', amount: 5 })).json).toMatchObject({ refunded: false, reason: 'exceeds_consumed' });
    expect((await call('POST', `${base}/refund`, { counter: 'orders', idempotency_key: 'r3', consume_idempotency_key: 'missing' })).json.reason).toBe('unknown_consume');
  });

  it('leases return the unconsumed amount on release and the whole amount on expiry', async () => {
    const { e, call, g } = await setup();
    const base = `/v1/grants/machine/${g.id}`;
    const leased = (await call('POST', `${base}/consume`, { counter: 'orders', amount: 3, idempotency_key: 'l1', lease: true, ttl_seconds: 30 })).json;
    expect(leased.lease.id).toBeTruthy();
    expect((await call('POST', `${base}/consume`, { counter: 'orders', idempotency_key: 'x' })).json.allowed).toBe(false);
    const released = await call('POST', `${base}/leases/${leased.lease.id}/release`, { consumed: 1 });
    expect(released.json).toMatchObject({ status: 'released', returned: 2 });
    expect((await call('GET', `${base}/usage`)).json.counters.find((c: any) => c.counter === 'orders').used).toBe(1);
    const second = (await call('POST', `${base}/consume`, { counter: 'orders', amount: 2, idempotency_key: 'l2', lease: true, ttl_seconds: 10 })).json;
    e.clock.advance(11_000);
    expect((await call('GET', `${base}/usage`)).json.counters.find((c: any) => c.counter === 'orders').used).toBe(1);
    expect((await call('POST', `${base}/leases/${second.lease.id}/release`, {})).json.status).toBe('expired');
  });

  it('denies an expired grant and a revoked machine; emits the threshold events once', async () => {
    const { e, call, m, g } = await setup();
    const base = `/v1/grants/machine/${g.id}`;
    for (const k of ['a', 'b', 'c']) await call('POST', `${base}/consume`, { counter: 'orders', idempotency_key: k });
    const types = e.webhooks.events.map((x) => x.type);
    expect(types.filter((t) => t === 'grant.usage_threshold')).toHaveLength(2);
    expect(types.filter((t) => t === 'grant.exhausted')).toHaveLength(1);
    await call('POST', `/v1/machines/${m.id}/revoke`);
    expect((await call('POST', `${base}/consume`, { counter: 'spend', idempotency_key: 'z', context: { cents: 1 } })).json.reason).toBe('grant_inactive');
    expect((await call('POST', `/v1/grants/agent/${g.id}/consume`, { counter: 'orders', idempotency_key: 'q' })).status).toBe(404);
  });
});

describe('webhooks', () => {
  const receiver = () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    let status = 200;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()), body: String(init.body) });
      return new Response('ok', { status });
    }) as unknown as typeof fetch;
    return { seen, fetchImpl, set: (s: number) => (status = s) };
  };

  it('delivers signed events that the backend verifier accepts, to matching endpoints only', async () => {
    const r = receiver();
    const e = makeEngine({ fetch: r.fetchImpl });
    const call = client(e);
    const all = (await call('POST', '/v1/webhook_endpoints', { url: 'https://hooks.test/all' })).json;
    await call('POST', '/v1/webhook_endpoints', { url: 'https://hooks.test/orgs', enabled_events: ['organization.created'] });
    expect(all.secret).toMatch(/^whsec_/);
    await call('POST', '/v1/users', { email_address: 'w@example.com' });
    await e.flush();
    expect(r.seen.map((s) => s.url)).toEqual(['https://hooks.test/all']);
    const d = r.seen[0]!;
    const v = await verifyAtlasWebhook({ body: d.body, headers: d.headers, secret: all.secret, now: new Date(e.clock.now()) });
    expect(v.verified).toBe(true);
    expect((v.event as any).type).toBe('user.created');
    expect((v.event as any).data.primary_email).toBe('w@example.com');
    expect(JSON.stringify(v.event)).not.toContain('private');
    expect((await verifyAtlasWebhook({ body: d.body, headers: d.headers, secret: 'whsec_other', now: new Date(e.clock.now()) })).verified).toBe(false);
  });

  it('fault injection fails deliveries, records them, and redeliver succeeds', async () => {
    const r = receiver();
    const e = makeEngine({ fetch: r.fetchImpl });
    const call = client(e);
    const ep = (await call('POST', '/v1/webhook_endpoints', { url: 'https://hooks.test/x' })).json;
    await call('POST', '/__emulator/faults', { status: 500, times: 1 }, {});
    await call('POST', '/v1/users', { email_address: 'f@example.com' });
    await e.flush();
    expect(r.seen).toHaveLength(0);
    const log = (await call('GET', `/v1/webhook_endpoints/${ep.id}/deliveries`)).json.data;
    expect(log[0]).toMatchObject({ success: false, response_status: 500, attempt: 1 });
    expect((await call('GET', `/v1/webhook_endpoints/${ep.id}`)).json.consecutive_failures).toBe(1);
    expect((await call('POST', `/v1/webhook_endpoints/${ep.id}/redeliver`, {})).json.count).toBe(1);
    expect(r.seen).toHaveLength(1);
    expect((await call('GET', `/v1/webhook_endpoints/${ep.id}`)).json.consecutive_failures).toBe(0);
  });

  it('retries on the configured schedule', async () => {
    const r = receiver();
    r.set(503);
    const e = makeEngine({ fetch: r.fetchImpl, webhookRetryDelaysMs: [5, 5] });
    const call = client(e);
    await call('POST', '/v1/webhook_endpoints', { url: 'https://hooks.test/retry' });
    await call('POST', '/v1/users', { email_address: 'rt@example.com' });
    for (let i = 0; i < 50 && r.seen.length < 3; i++) await new Promise((ok) => setTimeout(ok, 10));
    expect(r.seen).toHaveLength(3);
    await e.close();
  });

  it('sends Standard Webhooks headers too, and /v1/events lists what was emitted', async () => {
    const r = receiver();
    const e = makeEngine({ fetch: r.fetchImpl });
    const call = client(e);
    await call('POST', '/v1/webhook_endpoints', { url: 'https://hooks.test/std' });
    await call('POST', '/v1/organizations', { name: 'Std' });
    await e.flush();
    expect(Object.keys(r.seen[0]!.headers)).toEqual(expect.arrayContaining(['webhook-id', 'webhook-timestamp', 'webhook-signature', 'atlas-signature']));
    const events = (await call('GET', '/v1/events')).json;
    expect(events.data[0]).toMatchObject({ object: 'event', type: 'organization.created' });
    expect((await call('GET', '/v1/events?types=user.created')).json.data).toEqual([]);
  });
});

describe('change feed', () => {
  it('orders changes, tombstones deletes, pages, and supports snapshot then resume', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'c@example.com' })).json;
    await call('PATCH', `/v1/users/${u.id}`, { first_name: 'C' });
    const o = (await call('POST', '/v1/organizations', { name: 'Feed' })).json;
    const feed = (await call('GET', '/v1/changes')).json;
    expect(feed.data.map((c: any) => [c.seq, c.resource_type, c.op])).toEqual([[1, 'user', 'create'], [2, 'user', 'update'], [3, 'organization', 'create']]);
    expect(feed.data[0].data).toMatchObject({ id: u.id, first_name: 'C' });
    expect(feed).toMatchObject({ has_more: false, next_after: 3, head_seq: 3, retention_floor_seq: 0 });
    expect((await call('GET', '/v1/changes?types=organization')).json.data.map((c: any) => c.resource_id)).toEqual([o.id]);
    const p1 = (await call('GET', '/v1/changes?limit=2')).json;
    expect(p1).toMatchObject({ has_more: true, next_after: 2 });
    const snap = (await call('GET', '/v1/changes/snapshot/user')).json;
    expect(snap).toMatchObject({ snapshot_seq: 3, has_more: false });
    expect(snap.data.map((x: any) => x.id)).toEqual([u.id]);
    await call('DELETE', `/v1/users/${u.id}`);
    const tail = (await call('GET', `/v1/changes?after=${snap.snapshot_seq}`)).json;
    expect(tail.data[0]).toMatchObject({ op: 'delete', resource_id: u.id, data: null, version: 4 });
  });

  it('400 beyond the head or on bad input, 410 below the retention floor', async () => {
    const e = makeEngine();
    const call = client(e);
    await call('POST', '/v1/users', { email_address: 'g@example.com' });
    expect((await call('GET', '/v1/changes?after=99')).status).toBe(400);
    expect((await call('GET', '/v1/changes?limit=0')).status).toBe(400);
    expect((await call('GET', '/v1/changes?types=bogus')).status).toBe(400);
    await call('POST', '/__emulator/changes/trim', { seq: 1 });
    const gone = await call('GET', '/v1/changes?after=0');
    expect(gone.status).toBe(410);
    expect(gone.json.errors[0].code).toBe('RESYNC_REQUIRED');
    expect((await call('GET', '/v1/changes?after=1')).status).toBe(200);
  });

  it('consumer positions are monotonic, bounded by the head, and per key', async () => {
    const e = makeEngine({ secretKeys: ['sk_a', 'sk_b'].map((key) => ({ key })) });
    const a = client(e, 'sk_a');
    const b = client(e, 'sk_b');
    await a('POST', '/v1/users', { email_address: 'h@example.com' });
    await a('POST', '/v1/users', { email_address: 'i@example.com' });
    expect((await a('GET', '/v1/changes/consumers/mirror')).json).toMatchObject({ seq: null, lag: 2 });
    expect((await a('PUT', '/v1/changes/consumers/mirror/ack', { seq: 2 })).json).toMatchObject({ seq: 2, lag: 0 });
    expect((await a('PUT', '/v1/changes/consumers/mirror/ack', { seq: 1 })).json.seq).toBe(2);
    expect((await a('PUT', '/v1/changes/consumers/mirror/ack', { seq: 3 })).status).toBe(400);
    expect((await b('GET', '/v1/changes/consumers/mirror')).json.seq).toBeNull();
    expect((await a('GET', '/v1/changes/consumers/bad name')).status).toBe(400);
  });
});

describe('tokens, sessions and the clock', () => {
  it('mints a real session token that AtlasBackend verifies against the engine JWKS, with org claims', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 't@example.com' })).json;
    const o = (await call('POST', '/v1/organizations', { name: 'Tok', created_by: u.id })).json;
    const s = (await call('POST', '/v1/sessions', { user_id: u.id, organization_id: o.id })).json;
    expect(s.jwt.split('.')).toHaveLength(3);
    const jwks = await (await e.handle(new Request('http://x/.well-known/jwks.json'))).json();
    const backend = new AtlasBackend({ jwks: jwks as any, issuer: e.issuer, now: e.clock.now } as any);
    const r = await backend.verify(s.jwt);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims).toMatchObject({ sub: u.id, sid: s.id, org_id: o.id, org_role: 'org:admin', atlas_emulator: true });
    expect((await call('POST', '/v1/tokens/verify', { token: s.jwt })).json).toMatchObject({ verified: true, user_id: u.id, organization_id: o.id });
  });

  it('the issuer can never be a production issuer, and a foreign engine key does not verify', async () => {
    const a = makeEngine();
    const b = makeEngine();
    expect(a.issuer).toMatch(/\.invalid$/);
    const ua = (await client(a)('POST', '/v1/users', { email_address: 'a@example.com' })).json;
    const sa = (await client(a)('POST', '/v1/sessions', { user_id: ua.id })).json;
    expect((await client(b)('POST', '/v1/tokens/verify', { token: sa.jwt })).json.verified).toBe(false);
  });

  it('the clock reaches token expiry: a token verifies, then expires after advance', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'e@example.com' })).json;
    const s = (await call('POST', '/v1/sessions', { user_id: u.id })).json;
    expect((await call('POST', '/v1/tokens/verify', { token: s.jwt })).json.verified).toBe(true);
    await call('POST', '/__emulator/time/advance', { ms: 120_000 });
    expect((await call('POST', '/v1/tokens/verify', { token: s.jwt })).json.verified).toBe(false);
    const fresh = await call('POST', `/v1/sessions/${s.id}/tokens/session`);
    expect((await call('POST', '/v1/tokens/verify', { token: fresh.json.jwt })).json.verified).toBe(true);
  });

  it('revoking a session fails verification; JWT templates add claims', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'j@example.com' })).json;
    const s = (await call('POST', '/v1/sessions', { user_id: u.id })).json;
    await call('POST', '/v1/jwt_templates', { name: 'hasura', claims: { role: 'admin' } });
    const t = (await call('POST', `/v1/sessions/${s.id}/tokens/hasura`)).json.jwt as string;
    expect(JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString())).toMatchObject({ role: 'admin' });
    expect((await call('POST', `/v1/sessions/${s.id}/tokens/missing`)).status).toBe(404);
    await call('POST', `/v1/sessions/${s.id}/revoke`);
    expect((await call('POST', '/v1/tokens/verify', { token: s.jwt })).json).toMatchObject({ verified: false, reason: 'revoked' });
  });

  it('rotating the signing key keeps old tokens valid and signs new ones with the new kid', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'rk@example.com' })).json;
    const before = (await call('POST', '/v1/sessions', { user_id: u.id })).json;
    const rot = (await call('POST', '/v1/instance/signing_keys/rotate', {})).json;
    const after = (await call('POST', '/v1/sessions', { user_id: u.id })).json;
    const kid = (t: string) => JSON.parse(Buffer.from(t.split('.')[0]!, 'base64url').toString()).kid;
    expect(kid(after.jwt)).toBe(rot.kid);
    expect(kid(before.jwt)).toBe(rot.previous_kid);
    expect((await call('POST', '/v1/tokens/verify', { token: before.jwt })).json.verified).toBe(true);
    const jwks = (await (await e.handle(new Request('http://x/.well-known/jwks.json'))).json()) as any;
    expect(jwks.keys.map((k: any) => k.kid)).toEqual([rot.previous_kid, rot.kid]);
    expect((await call('GET', '/v1/instance/signing_keys')).json.data[0]).toMatchObject({ kid: rot.kid, current: true });
  });

  it('refresh rotation: the new token works once; reusing a spent one revokes the session', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'rf@example.com' })).json;
    const s = (await call('POST', '/v1/sessions', { user_id: u.id })).json;
    const r1 = await call('POST', '/__emulator/sessions/refresh', { refresh_token: s.refresh_token });
    expect(r1.json.refresh_token).not.toBe(s.refresh_token);
    // Inside the grace window a replay is a client that lost the reply: same successor, no second rotation.
    const replay = await call('POST', '/__emulator/sessions/refresh', { refresh_token: s.refresh_token });
    expect(replay.json.refresh_token).toBe(r1.json.refresh_token);
    await call('POST', '/__emulator/time/advance', { ms: 31_000 });
    const reuse = await call('POST', '/__emulator/sessions/refresh', { refresh_token: s.refresh_token });
    expect(reuse.json.errors[0].code).toBe('REFRESH_REUSE_DETECTED');
    expect((await call('POST', '/__emulator/sessions/refresh', { refresh_token: r1.json.refresh_token })).json.errors[0].code).toBe('SESSION_REVOKED');
  });
});

describe('message sink, scenarios, reset, generic CRUD', () => {
  it('lists, filters and long-polls messages', async () => {
    const e = makeEngine();
    const call = client(e, null);
    const pending = call('GET', '/__emulator/messages?to=late@example.com&wait=2000');
    setTimeout(() => e.messages.send({ channel: 'sms', to: 'late@example.com', body: 'code 1', code: '1' }), 20);
    expect((await pending).json.data[0]).toMatchObject({ channel: 'sms', code: '1' });
    expect((await call('GET', '/__emulator/messages?channel=email')).json.data).toEqual([]);
    await call('DELETE', '/__emulator/messages');
    expect((await call('GET', '/__emulator/messages')).json.data).toEqual([]);
  });

  it('a scenario creates linked users, organizations and members through the real routes', async () => {
    const e = makeEngine();
    const call = client(e, null);
    const r = await call('POST', '/__emulator/scenarios', { users: [{ ref: 'ada', email: 'ada@example.com' }, { ref: 'bob', email: 'bob@example.com' }], organizations: [{ ref: 'acme', name: 'Acme', created_by: 'ada', members: [{ user: 'ada' }, { user: 'bob', role: 'org:member' }] }] });
    expect(r.status).toBe(201);
    const acme = r.json.refs.acme.id;
    const members = (await client(e)('GET', `/v1/organizations/${acme}/memberships`)).json.data;
    expect(members.map((m: any) => m.role).sort()).toEqual(['org:admin', 'org:member']);
    expect(e.feed.head).toBeGreaterThanOrEqual(5);
  });

  it('reset clears state, seeds the system roles again and restarts the feed', async () => {
    const e = makeEngine();
    const call = client(e);
    await call('POST', '/v1/users', { email_address: 'z@example.com' });
    await call('POST', '/__emulator/reset');
    expect((await call('GET', '/v1/users')).json.data).toEqual([]);
    expect((await call('GET', '/v1/changes')).json.head_seq).toBe(0);
    expect((await call('GET', '/v1/roles')).json.data.length).toBe(2);
  });

  it('routes without hand-written behaviour get document-shaped CRUD (groups)', async () => {
    const e = makeEngine();
    const call = client(e);
    const bad = await call('POST', '/v1/groups', { name: 'No slug' });
    expect(bad.status).toBe(400);
    expect(bad.json.errors[0].param).toBe('slug');
    const g = (await call('POST', '/v1/groups', { slug: 'eng', name: 'Engineering' })).json;
    expect(g).toMatchObject({ object: 'group', slug: 'eng', name: 'Engineering', include_in_token: false });
    expect(typeof g.created_at).toBe('number');
    expect((await call('PATCH', `/v1/groups/${g.id}`, { name: 'Eng' })).json.name).toBe('Eng');
    expect((await call('GET', '/v1/groups')).json.data).toHaveLength(1);
    await call('DELETE', `/v1/groups/${g.id}`);
    expect((await call('GET', `/v1/groups/${g.id}`)).status).toBe(404);
  });
});

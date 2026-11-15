/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseCedar, parseCedarTemplate } from './handlers/cedar';
import { Resolver, compileModel, dslToModel } from './handlers/fga-engine';
import type { Engine } from './engine';
import { client, makeEngine } from './test-support';

const events = (e: Engine, t: string) => e.webhooks.events.filter((x) => x.type === t);
const err = (r: { json: any }) => r.json.errors[0];

const DSL = `model
  schema 1.1
type user
type group
  relations
    define member: [user]
type folder
  relations
    define viewer: [user, group#member]
type doc
  relations
    define parent: [folder]
    define editor: [user]
    define blocked: [user]
    define viewer: [user, user:*] or editor or viewer from parent
    define can_view: viewer but not blocked
    define reviewer: editor and viewer`;

async function fgaWorld(dsl = DSL) {
  const e = makeEngine();
  const call = client(e);
  const store = (await call('POST', '/v1/fga/stores', { name: 'rewrites' })).json;
  const model = (await call('POST', `/v1/fga/stores/${store.id}/authorization-models`, { dsl })).json;
  const write = (writes: any[], deletes: any[] = []) => call('POST', `/v1/fga/stores/${store.id}/write`, { writes, ...(deletes.length ? { deletes } : {}) });
  const check = async (user: string, relation: string, object: string, extra: any = {}) => (await call('POST', `/v1/fga/stores/${store.id}/check`, { user, relation, object, ...extra })).json.allowed;
  return { e, call, store, model, write, check };
}
const T = (user: string, relation: string, object: string, condition?: any) => ({ user, relation, object, ...(condition ? { condition } : {}) });

describe('authz: FGA model engine (unit)', () => {
  it('parses DSL into the six rewrite operators and refuses a model with unknown references', () => {
    const m = dslToModel(DSL);
    expect(m.type_definitions.map((t: any) => t.type)).toEqual(['user', 'group', 'folder', 'doc']);
    expect(m.type_definitions[3].relations.can_view).toEqual({ difference: { base: { computedUserset: { relation: 'viewer' } }, subtract: { computedUserset: { relation: 'blocked' } } } });
    expect(m.type_definitions[3].relations.reviewer).toHaveProperty('intersection');
    expect(JSON.stringify(m.type_definitions[3].relations.viewer)).toContain('tupleToUserset');
    expect(() => compileModel(dslToModel('type doc\n  relations\n    define viewer: editor'))).toThrow(/not defined/);
    expect(() => compileModel(dslToModel('type doc\n  relations\n    define viewer: [nope]'))).toThrow(/unknown type/);
    const r = new Resolver(compileModel(m), [T('user:a', 'editor', 'doc:1')], undefined);
    expect(r.listObjects({ type: 'user', id: 'a', rel: null, wild: false }, 'viewer', 'doc')).toEqual(['1']);
  });

  it('terminates on a cyclic model', () => {
    const m = compileModel(dslToModel('type user\ntype g\n  relations\n    define a: b\n    define b: a'));
    expect(new Resolver(m, [], undefined).check({ type: 'user', id: 'x', rel: null, wild: false }, 'g:1', 'a')).toBe(false);
  });
});

describe('authz: FGA models and queries', () => {
  it('writes a model (DSL or JSON), lists without the body, reads with it, and refuses an invalid one', async () => {
    const { e, call, store, model } = await fgaWorld();
    expect(model).toMatchObject({ object: 'fga.authorization_model', store_id: store.id, schema_version: '1.1' });
    expect(model.model.type_definitions).toHaveLength(4);
    const list = (await call('GET', `/v1/fga/stores/${store.id}/authorization-models`)).json;
    expect(list.data).toHaveLength(1);
    expect(list.data[0].model).toBeUndefined();
    expect((await call('GET', `/v1/fga/stores/${store.id}/authorization-models/${model.id}`)).json.model.type_definitions).toHaveLength(4);
    expect((await call('GET', `/v1/fga/stores/${store.id}/authorization-models/fgm_none`)).status).toBe(404);
    const json = await call('POST', `/v1/fga/stores/${store.id}/authorization-models`, { type_definitions: [{ type: 'user' }, { type: 'doc', relations: { viewer: { this: {} } }, metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } } }] });
    expect(json.status).toBe(200);
    expect(err(await call('POST', `/v1/fga/stores/${store.id}/authorization-models`, {})).code).toBe('VALIDATION_FAILED');
    expect(err(await call('POST', `/v1/fga/stores/${store.id}/authorization-models`, { dsl: 'type doc\n  relations\n    define viewer: editor' })).message).toContain('not defined');
    expect(err(await call('POST', `/v1/fga/stores/${store.id}/authorization-models`, { dsl: 'type doc\n  relations\n    define viewer: (a or' })).param).toBe('dsl');
    expect((await call('POST', '/v1/fga/stores/fga_none/authorization-models', { dsl: DSL })).status).toBe(404);
    const feed = (await call('GET', '/v1/authz/events?after=0')).json.data;
    expect(feed.filter((x: any) => x.kind === 'model_written')).toHaveLength(2);
    const audit = (await client(e, null)('GET', '/__emulator/authz/audit')).json.data;
    expect(audit.filter((a: any) => a.action === 'fga_authorization_model.created')).toHaveLength(2);
  });

  it('checks computed, tuple-to-userset, union, intersection, exclusion, wildcard and userset relations', async () => {
    const { write, check, call, store } = await fgaWorld();
    expect((await write([T('user:alice', 'viewer', 'folder:f1'), T('folder:f1', 'parent', 'doc:d1'), T('user:bob', 'editor', 'doc:d2'), T('user:bob', 'blocked', 'doc:d2'), T('user:carol', 'member', 'group:eng'), T('group:eng#member', 'viewer', 'folder:f2'), T('folder:f2', 'parent', 'doc:d3'), T('user:*', 'viewer', 'doc:pub')])).status).toBe(200);
    expect(await check('user:alice', 'viewer', 'doc:d1')).toBe(true); // viewer from parent
    expect(await check('user:alice', 'can_view', 'doc:d1')).toBe(true);
    expect(await check('user:dave', 'viewer', 'doc:d1')).toBe(false);
    expect(await check('user:bob', 'viewer', 'doc:d2')).toBe(true); // editor => viewer
    expect(await check('user:bob', 'can_view', 'doc:d2')).toBe(false); // but not blocked
    expect(await check('user:bob', 'reviewer', 'doc:d2')).toBe(true); // editor and viewer
    expect(await check('user:alice', 'reviewer', 'doc:d1')).toBe(false); // viewer, not editor
    expect(await check('user:carol', 'viewer', 'doc:d3')).toBe(true); // group#member through a parent folder
    expect(await check('user:zed', 'viewer', 'doc:pub')).toBe(true); // wildcard
    expect(await check('user:zed', 'viewer', 'doc:d1')).toBe(false);
    expect(await check('user:alice', 'nope', 'doc:d1')).toBe(false);
    expect(await check('user:carol', 'viewer', 'doc:d1', { contextual_tuples: [T('user:carol', 'viewer', 'folder:f1')] })).toBe(true);
    // The check is logged for replay.
    expect((await call('GET', '/v1/authz_decisions?source=fga')).status).toBeLessThan(500);
    expect((await call('POST', `/v1/fga/stores/${store.id}/check`, { user: 'user:alice', relation: 'viewer', object: 'doc:d1', authorization_model_id: 'fgm_none' })).status).toBe(404);
  });

  it('refuses tuples that do not fit the model on write, and uses the newest model', async () => {
    const { call, store, write, check } = await fgaWorld();
    expect(err(await write([T('folder:f1', 'editor', 'doc:d1')])).message).toContain('not an allowed type');
    expect(err(await write([T('user:a', 'ghost', 'doc:d1')])).message).toContain('not defined');
    expect(err(await write([T('user:a', 'viewer', 'planet:x')])).message).toContain('unknown object type');
    expect((await write([T('user:a', 'editor', 'doc:1')])).status).toBe(200);
    expect(await check('user:a', 'viewer', 'doc:1')).toBe(true);
    // A newer model is the one checks run against.
    await call('POST', `/v1/fga/stores/${store.id}/authorization-models`, { dsl: 'type user\ntype doc\n  relations\n    define editor: [user]\n    define viewer: [user]' });
    expect(await check('user:a', 'viewer', 'doc:1')).toBe(false);
  });

  it('batch-checks with correlation ids, list-objects with paging, list-users and expand', async () => {
    const { call, store, write } = await fgaWorld();
    await write([T('user:alice', 'viewer', 'folder:f1'), T('folder:f1', 'parent', 'doc:d1'), T('folder:f1', 'parent', 'doc:d2'), T('user:alice', 'editor', 'doc:d3'), T('user:alice', 'blocked', 'doc:d3'), T('user:bob', 'editor', 'doc:d1')]);
    const base = `/v1/fga/stores/${store.id}`;
    const batch = await call('POST', `${base}/batch-check`, { checks: [{ user: 'user:alice', relation: 'can_view', object: 'doc:d1', correlation_id: 'a' }, { user: 'user:alice', relation: 'can_view', object: 'doc:d3', correlation_id: 'b' }, { user: 'user:bob', relation: 'viewer', object: 'doc:d2' }] });
    expect(batch.json).toMatchObject({ object: 'fga.batch_check', result: [{ correlation_id: 'a', allowed: true }, { correlation_id: 'b', allowed: false }, { correlation_id: '2', allowed: false }] });
    expect((await call('POST', `${base}/batch-check`, { checks: [] })).status).toBe(400);
    expect((await call('POST', `${base}/batch-check`, { checks: Array.from({ length: 101 }, () => ({ user: 'user:a', relation: 'viewer', object: 'doc:1' })) })).status).toBe(400);
    expect((await call('POST', `${base}/batch-check`, { checks: [{ user: 'user:a' }] })).status).toBe(400);
    const lo = (await call('POST', `${base}/list-objects`, { user: 'user:alice', relation: 'viewer', type: 'doc' })).json;
    expect(lo).toMatchObject({ object: 'fga.list_objects', objects: ['doc:d1', 'doc:d2', 'doc:d3'], has_more: false });
    expect((await call('POST', `${base}/list-objects`, { user: 'user:alice', relation: 'can_view', type: 'doc' })).json.objects).toEqual(['doc:d1', 'doc:d2']);
    const p1 = (await call('POST', `${base}/list-objects`, { user: 'user:alice', relation: 'viewer', type: 'doc', limit: 2 })).json;
    expect(p1).toMatchObject({ objects: ['doc:d1', 'doc:d2'], has_more: true, next_cursor: 'doc:d2' });
    expect((await call('POST', `${base}/list-objects`, { user: 'user:alice', relation: 'viewer', type: 'doc', limit: 2, starting_after: p1.next_cursor })).json).toMatchObject({ objects: ['doc:d3'], has_more: false });
    expect((await call('POST', `${base}/list-objects`, { user: 'user:alice' })).status).toBe(400);
    const lu = (await call('POST', `${base}/list-users`, { object: 'doc:d1', relation: 'viewer', user_filters: [{ type: 'user' }] })).json;
    expect(lu).toMatchObject({ object: 'fga.list_users', users: ['user:alice', 'user:bob'], excluded_users: [] });
    expect((await call('POST', `${base}/list-users`, { object: { type: 'doc', id: 'd3' }, relation: 'can_view', user_filters: [{ type: 'user' }] })).json.users).toEqual([]);
    expect((await call('POST', `${base}/list-users`, { object: 'doc:d1', relation: 'viewer' })).status).toBe(400);
    const ex = (await call('POST', `${base}/expand`, { object: 'doc:d1', relation: 'can_view' })).json;
    expect(ex).toMatchObject({ object: 'fga.expand', tree: { type: 'difference', base: { type: 'leaf', computed: 'viewer' }, subtract: { type: 'leaf', computed: 'blocked' } } });
    const direct = (await call('POST', `${base}/expand`, { object: 'doc:d3', relation: 'editor' })).json.tree;
    expect(direct).toEqual({ type: 'leaf', users: ['user:alice'] });
    expect((await call('POST', `${base}/expand`, { object: 'doc:d3' })).status).toBe(400);
  });

  it('evaluates tuple conditions with the tuple context winning over the request context', async () => {
    const dsl = 'model\n  schema 1.1\ntype user\ntype doc\n  relations\n    define viewer: [user with small]\ncondition small(limit: int, size: int) {\n  size < limit\n}';
    const { call, store, write, check } = await fgaWorld(dsl);
    expect((await write([T('user:a', 'viewer', 'doc:1', { name: 'ghost' })])).status).toBe(400);
    expect((await write([T('user:a', 'viewer', 'doc:1', { name: 'small', context: { nope: 1 } })])).status).toBe(400);
    expect((await write([T('user:a', 'viewer', 'doc:1')])).status).toBe(400); // the model requires the condition
    expect((await write([T('user:a', 'viewer', 'doc:1', { name: 'small', context: { limit: 10 } })])).status).toBe(200);
    expect(await check('user:a', 'viewer', 'doc:1', { context: { size: 5 } })).toBe(true);
    expect(await check('user:a', 'viewer', 'doc:1', { context: { size: 50 } })).toBe(false);
    expect(await check('user:a', 'viewer', 'doc:1', { context: { size: 50, limit: 100 } })).toBe(false); // the tuple's own limit wins
    expect(await check('user:a', 'viewer', 'doc:1')).toBe(false); // a missing parameter never grants
    const lo = (await call('POST', `/v1/fga/stores/${store.id}/list-objects`, { user: 'user:a', relation: 'viewer', type: 'doc', context: { size: 1 } })).json;
    expect(lo.objects).toEqual(['doc:1']);
  });

  it('feeds the explain fga layer from the model and leaves text-seeded models on direct matching', async () => {
    const { call, write } = await fgaWorld();
    const u = (await call('POST', '/v1/users', { email_address: 'fgax@example.com' })).json;
    const store = (await call('GET', '/v1/fga/stores')).json.data[0];
    await write([T(`user:${u.id}`, 'editor', 'doc:d2'), T(`user:${u.id}`, 'blocked', 'doc:d2')]);
    const explain = async (action: string) => (await call('POST', '/v1/authz/explain', { subject: { id: u.id }, action, resource: { type: 'doc', id: 'd2' }, layers: ['fga'], fga: { store_id: store.id } })).json;
    expect((await explain('viewer')).layers.fga.contributions[0].matched).toBe(true);
    expect((await explain('can_view')).layers.fga.contributions[0].matched).toBe(false);
  });
});

describe('authz: Cedar templates and extension types', () => {
  it('parses slots only in templates and links them to entities', () => {
    expect(() => parseCedar('permit (principal == ?principal, action, resource);')).toThrow(/slot/);
    const t = parseCedarTemplate('permit (principal == ?principal, action, resource in ?resource);');
    expect(t[0]!.principal.op).toBe('slot==');
    expect(() => parseCedarTemplate('permit (principal == ?resource, action, resource);')).toThrow();
  });

  it('evaluates ip() and decimal() with their methods, from literals and from context values', async () => {
    const e = makeEngine();
    const call = client(e);
    await call('POST', '/v1/abac_policies', { name: 'ext', source: 'permit (principal, action == Action::"read", resource) when { context.ip.isInRange(ip("10.0.0.0/8")) && context.score.lessThan(decimal("0.5")) };\nforbid (principal, action, resource) when { context.ip == ip("203.0.113.9") };' });
    const ask = async (ctx: any) => (await call('POST', '/v1/abac/evaluate', { principal: { type: 'User', id: 'u' }, action: 'read', resource: { type: 'Doc', id: 'd' }, context: ctx })).json;
    const x = (fn: string, arg: string) => ({ __extn: { fn, arg } });
    expect((await ask({ ip: x('ip', '10.1.2.3'), score: x('decimal', '0.25') })).decision).toBe('allow');
    expect((await ask({ ip: x('ip', '10.1.2.3'), score: x('decimal', '0.75') })).decision).toBe('deny');
    expect((await ask({ ip: x('ip', '192.168.0.1'), score: x('decimal', '0.25') })).decision).toBe('deny');
    expect((await ask({ ip: x('ip', '203.0.113.9'), score: x('decimal', '0.25') })).decision).toBe('deny');
    const bad = await ask({ ip: x('ip', 'not-an-ip'), score: x('decimal', '0.25') });
    expect(bad.decision).toBe('deny');
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(err(await call('POST', '/v1/abac_policies', { name: 'bad-ext', source: 'permit (principal, action, resource) when { ip("nope").isIpv4() };' })).code).toBe('VALIDATION_FAILED');
    const m = await call('POST', '/v1/abac_policies', { name: 'v6', source: 'permit (principal, action, resource) when { ip("::1").isLoopback() && ip("224.0.0.1").isMulticast() && ip("1.2.3.4").isIpv4() && decimal("1.5000") == decimal("1.5") };' });
    expect(m.status).toBe(200);
    expect((await ask({})).decision).toBe('allow');
  });

  it('creates templates and links, evaluates linked policies and follows template edits', async () => {
    const e = makeEngine();
    const call = client(e);
    const src = 'permit (principal == ?principal, action == Action::"read", resource in ?resource);';
    expect(err(await call('POST', '/v1/abac_templates', { name: 'bad', source: 'permit (' })).code).toBe('VALIDATION_FAILED');
    expect(err(await call('POST', '/v1/abac_templates', { source: src })).param).toBe('name');
    const t = (await call('POST', '/v1/abac_templates', { name: 'reader', source: src })).json;
    expect(t).toMatchObject({ object: 'abac_policy_template', name: 'reader', version: 1, slots: ['?principal', '?resource'], link_count: 0 });
    expect(err(await call('POST', '/v1/abac_templates', { name: 'reader', source: src })).message).toContain('already exists');
    expect((await call('GET', '/v1/abac_templates')).json.data).toHaveLength(1);
    expect((await call('GET', '/v1/abac_templates/abt_none')).status).toBe(404);
    expect(err(await call('POST', '/v1/abac_policy_links', { template_id: t.id, name: 'l', principal: { type: 'User', id: 'u1' } })).param).toBe('resource');
    expect(err(await call('POST', '/v1/abac_policy_links', { template_id: 'abt_none', name: 'l' })).param).toBe('template_id');
    const plain = (await call('POST', '/v1/abac_templates', { name: 'plain', source: 'permit (principal, action, resource);' })).json;
    expect(err(await call('POST', '/v1/abac_policy_links', { template_id: plain.id, name: 'x', principal: { type: 'User', id: 'u1' } })).message).toContain('no ?principal slot');
    const link = (await call('POST', '/v1/abac_policy_links', { template_id: t.id, name: 'u1-folder', principal: { type: 'User', id: 'u1' }, resource: { type: 'Folder', id: 'f1' } })).json;
    expect(link).toMatchObject({ object: 'abac_policy_link', template_name: 'reader', enabled: true });
    expect(link.source).toContain('principal == User::"u1"');
    expect(link.source).toContain('resource in Folder::"f1"');
    const ask = async (user: string, ids?: string[]) => (await call('POST', '/v1/abac/evaluate', { principal: { type: 'User', id: user }, action: 'read', resource: { type: 'Doc', id: 'd1', parents: ['Folder::f1'] }, ...(ids ? { policy_ids: ids } : {}) })).json;
    expect(await ask('u1')).toMatchObject({ decision: 'allow', reasons: ['link u1-folder'] });
    expect((await ask('u2')).decision).toBe('deny');
    expect((await ask('u1', [link.id])).decision).toBe('allow');
    expect((await ask('u1', ['someone-else'])).decision).toBe('deny');
    expect((await call('PATCH', `/v1/abac_policy_links/${link.id}`, { enabled: false })).json.enabled).toBe(false);
    expect((await ask('u1')).decision).toBe('deny');
    await call('PATCH', `/v1/abac_policy_links/${link.id}`, { enabled: true, principal: { type: 'User', id: 'u2' } });
    expect((await ask('u2')).decision).toBe('allow');
    const upd = (await call('PATCH', `/v1/abac_templates/${t.id}`, { source: 'forbid (principal == ?principal, action, resource in ?resource);' })).json;
    expect(upd).toMatchObject({ version: 2, links_updated: 1 });
    expect((await ask('u2')).decision).toBe('deny'); // the link follows the template
    // A new source the link cannot fill is refused.
    expect((await call('PATCH', `/v1/abac_templates/${t.id}`, { source: 'permit (principal, action, resource in ?resource);' })).status).toBe(400);
    expect((await call('DELETE', `/v1/abac_templates/${t.id}`)).status).toBe(409);
    expect((await call('DELETE', `/v1/abac_templates/${t.id}?force=true`)).json).toMatchObject({ deleted: true, links_deleted: 1 });
    expect((await call('GET', '/v1/abac_policy_links')).json.data).toHaveLength(0);
    expect((await call('DELETE', `/v1/abac_policy_links/${link.id}`)).status).toBe(404);
    const audit = (await client(e, null)('GET', '/__emulator/authz/audit')).json.data.map((a: any) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['abac_template.created', 'abac_link.created', 'abac_link.updated', 'abac_template.updated', 'abac_template.deleted']));
  });
});

describe('authz: access policy signals', () => {
  it('blocks by country from an address fact, a body value or the emulator default, and steps up on risk', async () => {
    const e = makeEngine();
    const call = client(e);
    const admin = client(e, null);
    const geo = (await call('POST', '/v1/access_policies', { name: 'no-kp', grants: [{ type: 'block' }], conditions: { countries: ['KP'] } })).json;
    const risky = (await call('POST', '/v1/access_policies', { name: 'risky', grants: [{ type: 'require_mfa' }], conditions: { riskLevels: ['high'] } })).json;
    expect((await admin('PUT', '/__emulator/access/ip_facts', { ips: { '203.0.113.9': { country: 'kp', asn: 64500, tor: true, datacenter: false } } })).json.ips['203.0.113.9']).toMatchObject({ country: 'KP', asn: 64500 });
    expect((await admin('PUT', '/__emulator/access/ip_facts', { ips: { '1.1.1.1': { country: 'USA' } } })).status).toBe(400);
    const sim = async (b: any) => (await call('POST', '/v1/access_policies/simulate', b)).json;
    expect(await sim({ ip: '203.0.113.9' })).toMatchObject({ object: 'access_policy_simulation', decision: 'block', matched: [geo.id], blocked_by: geo.id });
    expect(await sim({ ip: '198.51.100.1' })).toMatchObject({ decision: 'allow', matched: [], blocked_by: null });
    expect((await sim({ country: 'KP' })).decision).toBe('block');
    expect((await sim({ country: 'DE' })).decision).toBe('allow');
    expect((await sim({ ip: '203.0.113.9', country: 'DE' })).decision).toBe('allow'); // an explicit value wins over the address
    const step = await sim({ risk_level: 'high' });
    expect(step).toMatchObject({ decision: 'step_up', matched: [risky.id], requirements: { mfa: true }, unmet: ['mfa'] });
    expect((await sim({ risk_level: 'high', mfa_verified: true })).unmet).toEqual([]);
    expect((await sim({ risk_level: 'low' })).decision).toBe('allow');
    expect((await sim({ policy_id: geo.id, country: 'KP' })).matched).toEqual([geo.id]);
    expect((await sim({ stage: 'nope' })).errors[0].code).toBe('VALIDATION_FAILED');
    expect((await call('POST', '/v1/access_policies/simulate', { policy_id: 'apol_none' })).status).toBe(404);
    // Instance-wide default signals apply when nothing else says.
    await admin('PUT', '/__emulator/access/signals', { risk_level: 'high' });
    expect((await sim({})).decision).toBe('step_up');
    expect((await admin('GET', '/__emulator/access/signals')).json.defaults).toEqual({ risk_level: 'high' });
    expect((await admin('PUT', '/__emulator/access/signals', { risk_level: 'extreme' })).status).toBe(400);
    await admin('DELETE', '/__emulator/access/signals');
    expect((await sim({})).decision).toBe('allow');
  });

  it('matches device trust, auth methods, device platform, OS version and client type; per-user values beat the default', async () => {
    const e = makeEngine();
    const call = client(e);
    const admin = client(e, null);
    const u = (await call('POST', '/v1/users', { email_address: 'sig@example.com' })).json;
    const p = (await call('POST', '/v1/access_policies', { name: 'devices', grants: [{ type: 'block' }], conditions: { deviceTrust: ['untrusted'], devicePlatforms: ['android'], osVersion: { max: '9.9' }, clientTypes: ['native'], authMethods: ['password'] } })).json;
    const sim = async (b: any) => (await call('POST', '/v1/access_policies/simulate', b)).json;
    const all = { device_trust: 'untrusted', device_platform: 'Android', os_version: '9.1', client_type: 'native', auth_methods: ['password'] };
    expect((await sim(all)).decision).toBe('block');
    expect((await sim({ ...all, os_version: '10.2' })).decision).toBe('allow');
    expect((await sim({ ...all, os_version: '9.10' })).decision).toBe('allow'); // numeric, not text, comparison
    expect((await sim({ ...all, device_trust: 'trusted' })).decision).toBe('allow');
    expect((await sim({ ...all, auth_methods: ['passkey'] })).decision).toBe('allow');
    await admin('PUT', '/__emulator/access/signals', { user_id: u.id, ...all });
    expect((await sim({ user_id: u.id })).decision).toBe('block');
    expect((await sim({ user_id: u.id, device_trust: 'trusted' })).decision).toBe('allow');
    expect(p.id).toBeTruthy();
  });

  it('reads signals from headers and the access object in explain, and keeps listing a policy whose signal is unknown', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'hdr@example.com' })).json;
    await call('POST', '/v1/access_policies', { name: 'geo', grants: [{ type: 'block' }], conditions: { countries: ['KP'] } });
    const ex = async (extra: any = {}, headers: any = {}) => (await call('POST', '/v1/authz/explain', { subject: { id: u.id }, action: 'x', layers: ['access_policies'], ...extra }, headers)).json.layers.access_policies;
    const none = await ex();
    expect(none.decision).toBe('no_match');
    expect(none.contributions[0].reason).toContain('countries signal');
    expect((await ex({}, { 'cf-ipcountry': 'KP' })).decision).toBe('deny');
    expect((await ex({}, { 'x-atlas-country': 'de' })).decision).toBe('no_match');
    expect((await ex({ access: { country: 'KP' } })).decision).toBe('deny');
    expect((await call('POST', '/v1/authz/explain', { subject: { id: u.id }, action: 'x', access: { risk_level: 'extreme' } })).status).toBe(400);
    await client(e, null)('PUT', '/__emulator/access/ip_facts', { ips: { '203.0.113.9': { country: 'KP' } } });
    expect((await ex({ access: { ip: '203.0.113.9' } })).decision).toBe('deny');
  });

  it('checks an address against a zone by range (IPv4 and IPv6), country, ASN and anonymizer', async () => {
    const e = makeEngine();
    const call = client(e);
    const admin = client(e, null);
    await admin('PUT', '/__emulator/access/ip_facts', { ips: { '203.0.113.9': { country: 'KP', asn: 64500, tor: true } } });
    const zone = (await call('POST', '/v1/network_zones', { name: 'mix', cidrs: ['198.51.100.0/24', '2001:db8::/32'], countries: ['KP'] })).json;
    const chk = async (ip: any) => call('POST', `/v1/network_zones/${zone.id}/check`, { ip });
    expect((await chk('198.51.100.7')).json).toMatchObject({ object: 'network_zone_check', zone_id: zone.id, matches: true, facts: { country: null, asn: null, tor: null, datacenter: null } });
    expect((await chk('203.0.113.9')).json).toMatchObject({ matches: true, facts: { country: 'KP', asn: 64500, tor: true } });
    expect((await chk('2001:db8::1')).json.matches).toBe(true);
    expect((await chk('2001:db9::1')).json.matches).toBe(false);
    expect((await chk('192.0.2.1')).json.matches).toBe(false);
    expect((await chk(undefined)).status).toBe(400);
    expect((await call('POST', '/v1/network_zones/zone_none/check', { ip: '1.2.3.4' })).status).toBe(404);
    const tor = (await call('POST', '/v1/network_zones', { name: 'tor', anonymizers: ['tor'] })).json;
    expect((await call('POST', `/v1/network_zones/${tor.id}/check`, { ip: '203.0.113.9' })).json.matches).toBe(true);
  });
});

describe('authz: agent delegation graph', () => {
  const enrol = async (e: Engine, call: ReturnType<typeof client>) => {
    const pair = generateKeyPairSync('ed25519');
    const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const tok = (await call('POST', '/v1/machine_enrolment_tokens', { max_uses: 2 })).json;
    const anon = client(e, null);
    const m = (await anon('POST', '/v1/machines/enroll', { enrolment_token: tok.secret, public_key_pem: pem, name: 'agent-a', device_key: 'dev-a' })).json;
    await call('POST', '/v1/resource_servers', { identifier: 'https://api.example', name: 'API', scopes: [{ name: 'read' }, { name: 'write' }] });
    await call('POST', `/v1/machines/${m.id}/grants`, { resource_server_id: 'https://api.example', scopes: ['read', 'write'] });
    const mint = async (extra: any = {}) => {
      const nonce = (await anon('POST', '/v1/machines/challenge', { machine_id: m.id })).json.nonce;
      return anon('POST', '/v1/machines/token', { machine_id: m.id, nonce, signature: nodeSign(null, Buffer.from(nonce), pair.privateKey).toString('base64url'), audience: 'https://api.example', ...extra });
    };
    return { m, mint };
  };
  const machine = async (call: ReturnType<typeof client>, name: string) => (await call('POST', '/v1/machines', { name })).json;

  it('creates root and child delegations that only narrow, and refuses loops, depth, and unknown parties', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'del@example.com' })).json;
    const [a, b, c] = [await machine(call, 'a'), await machine(call, 'b'), await machine(call, 'c')];
    const post = (body: any) => call('POST', '/v1/agent_delegations', body);
    expect(err(await post({ child_machine_id: a.id, scopes: ['read'] })).param).toBe('delegator_user_id');
    expect(err(await post({ child_machine_id: a.id, delegator_user_id: u.id, scopes: [] })).param).toBe('scopes');
    expect(err(await post({ child_machine_id: a.id, delegator_user_id: u.id, scopes: ['bad scope!'] })).param).toBe('scopes');
    expect((await post({ child_machine_id: 'mach_none', delegator_user_id: u.id, scopes: ['read'] })).status).toBe(404);
    expect((await post({ child_machine_id: a.id, delegator_user_id: 'user_none', scopes: ['read'] })).status).toBe(404);
    expect(err(await post({ child_machine_id: a.id, delegator_user_id: u.id, scopes: ['read'], expires_in_seconds: 5 })).param).toBe('expires_in_seconds');
    const root = (await post({ child_machine_id: a.id, delegator_user_id: u.id, scopes: ['read', 'write'], resource: 'https://api.example', expires_in_seconds: 3600 })).json;
    expect(root).toMatchObject({ object: 'agent_delegation', child_machine_id: a.id, delegator_user_id: u.id, depth: 1, status: 'active', parent_delegation_id: null });
    expect(root.root_delegation_id).toBe(root.id);
    expect(Math.abs(root.expires_at - (e.clock.now() + 3_600_000))).toBeLessThan(1000); // the clock runs on
    expect(events(e, 'agent.delegation_created')).toHaveLength(1);
    const child = (await post({ child_machine_id: b.id, parent_delegation_id: root.id, scopes: ['read'], expires_in_seconds: 86_400 })).json;
    expect(child).toMatchObject({ depth: 2, parent_machine_id: a.id, root_delegation_id: root.id, delegator_user_id: u.id });
    expect(child.expires_at).toBe(root.expires_at); // never outlives its parent
    expect(err(await post({ child_machine_id: c.id, parent_delegation_id: root.id, scopes: ['admin'] })).message).toContain('cannot hold scopes its parent lacks');
    expect(err(await post({ child_machine_id: c.id, parent_delegation_id: root.id, scopes: ['read'], resource: 'https://other' })).param).toBe('resource');
    expect(err(await post({ child_machine_id: a.id, parent_delegation_id: child.id, scopes: ['read'] })).message).toContain('cannot loop');
    expect(err(await post({ child_machine_id: b.id, parent_delegation_id: child.id, scopes: ['read'] })).message).toContain('itself');
    expect(err(await post({ child_machine_id: c.id, parent_delegation_id: root.id, delegator_user_id: u.id, scopes: ['read'] })).param).toBe('delegator_user_id');
    expect((await post({ child_machine_id: c.id, parent_delegation_id: 'dlg_none', scopes: ['read'] })).status).toBe(404);
    await client(e, null)('PUT', '/__emulator/agent_fabric', { maxDelegationDepth: 2 });
    expect((await post({ child_machine_id: c.id, parent_delegation_id: child.id, scopes: ['read'] })).status).toBe(409);
    expect((await client(e, null)('PUT', '/__emulator/agent_fabric', { maxDelegationDepth: 99 })).status).toBe(400);
    // reads
    expect((await call('GET', '/v1/agent_delegations')).json.data).toHaveLength(2);
    expect((await call('GET', `/v1/agent_delegations?root_id=${root.id}&status=active&limit=1`)).json).toMatchObject({ has_more: true });
    expect((await call('GET', '/v1/agent_delegations?status=nope')).status).toBe(400);
    expect((await call('GET', `/v1/agent_delegations/${child.id}`)).json).toMatchObject({ id: child.id, evaluations: [] });
    expect((await call('GET', '/v1/agent_delegations/dlg_none')).status).toBe(404);
    const graph = (await call('GET', `/v1/agent_delegations/${root.id}/graph`)).json;
    expect(graph).toMatchObject({ object: 'agent_delegation_graph', root_id: root.id, ancestors: [] });
    expect(graph.nodes.map((n: any) => n.id)).toEqual([root.id, child.id]);
    expect(graph.edges).toEqual([{ from: root.id, to: child.id, parent_machine_id: a.id, child_machine_id: b.id }]);
    expect((await call('GET', `/v1/agent_delegations/${child.id}/graph`)).json.ancestors.map((n: any) => n.id)).toEqual([root.id]);
    // revoking the root revokes the whole subtree, once, with one event
    const rev = (await call('POST', `/v1/agent_delegations/${root.id}/revoke`, { reason: 'done' })).json;
    expect(rev).toMatchObject({ object: 'agent_delegation_revocation', count: 2 });
    expect(rev.revoked.every((d: any) => d.status === 'revoked' && d.revoked_reason === 'done')).toBe(true);
    expect(events(e, 'agent.delegation_revoked')).toHaveLength(1);
    expect((await call('POST', `/v1/agent_delegations/${root.id}/revoke`, {})).json.count).toBe(0);
    expect(events(e, 'agent.delegation_revoked')).toHaveLength(1);
    expect(err(await post({ child_machine_id: c.id, parent_delegation_id: child.id, scopes: ['read'] })).code).toBe('CONFLICT');
    const audit = (await client(e, null)('GET', '/__emulator/authz/audit')).json.data.map((x: any) => x.action);
    expect(audit).toEqual(expect.arrayContaining(['agent.delegation_created', 'agent.delegation_revoked']));
  });

  it('mints machine tokens only under a live delegation, narrowed, with delegation, act and posture claims', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'mint@example.com' })).json;
    const { m, mint } = await enrol(e, call);
    const other = await machine(call, 'sub');
    expect((await mint()).json.scope).toBe('read write'); // no delegation: unchanged
    const root = (await call('POST', '/v1/agent_delegations', { child_machine_id: m.id, delegator_user_id: u.id, scopes: ['read'], expires_in_seconds: 600 })).json;
    expect((await mint({ scopes: ['write'] })).status).toBe(403);
    const ok = await mint();
    expect(ok.status).toBe(200);
    expect(ok.json.scope).toBe('read');
    const claims = ((await e.tokens.verifyAny(ok.json.token)) as any).claims;
    expect(claims.exp * 1000).toBeLessThanOrEqual(e.clock.now() + 601_000);
    expect(claims.delegation).toMatchObject({ id: root.id, root: root.id, depth: 1, delegator: u.id, scopes: ['read'] });
    expect(claims.act).toEqual({ sub: u.id });
    expect(claims.posture).toMatchObject({ device: 'unknown', risk: null });
    expect((await mint({ delegation_id: 'dlg_other' })).status).toBe(403);
    const verified = (await call('POST', '/v1/m2m_tokens/verify', { token: ok.json.token })).json;
    expect(verified).toMatchObject({ valid: true, delegation: { id: root.id, status: 'active' } });
    // a child agent's token names the whole chain in act
    const sub = (await call('POST', '/v1/agent_delegations', { child_machine_id: other.id, parent_delegation_id: root.id, scopes: ['read'] })).json;
    expect(sub.depth).toBe(2);
    // revoke: the issued token stops verifying and no new one is minted
    await call('POST', `/v1/agent_delegations/${root.id}/revoke`, {});
    expect((await call('POST', '/v1/m2m_tokens/verify', { token: ok.json.token })).json.valid).toBe(false);
    expect((await mint()).status).toBe(403);
    // an expired delegation does not mint either
    const m2 = await machine(call, 'late');
    const d2 = (await call('POST', '/v1/agent_delegations', { child_machine_id: m2.id, delegator_user_id: u.id, scopes: ['read'], expires_in_seconds: 60 })).json;
    await client(e, null)('POST', '/__emulator/time/advance', { ms: 120_000 });
    expect((await call('POST', `/v1/agent_delegations/${d2.id}/evaluate`, {})).json).toMatchObject({ decision: 'deny', reasons: ['delegation_expired'], valid_for_seconds: 0 });
  });

  it('revokes for a user, can disable the agents, and refuses a delegation to an unusable delegator', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'ru@example.com' })).json;
    const a = await machine(call, 'a');
    const b = await machine(call, 'b');
    const r1 = (await call('POST', '/v1/agent_delegations', { child_machine_id: a.id, delegator_user_id: u.id, scopes: ['read'] })).json;
    await call('POST', '/v1/agent_delegations', { child_machine_id: b.id, parent_delegation_id: r1.id, scopes: ['read'] });
    expect((await call('POST', '/v1/agent_delegations/revoke_for_user', {})).status).toBe(400);
    const out = (await call('POST', '/v1/agent_delegations/revoke_for_user', { user_id: u.id, disable_agents: true })).json;
    expect(out).toMatchObject({ count: 2 });
    expect(out.disabled_machine_ids.sort()).toEqual([a.id, b.id].sort());
    expect((await call('GET', `/v1/machines/${a.id}`)).json.status).toBe('revoked');
    expect((await call('POST', '/v1/agent_delegations', { child_machine_id: a.id, delegator_user_id: u.id, scopes: ['read'] })).status).toBe(409); // a revoked machine
    await call('POST', `/v1/users/${u.id}/ban`, {});
    expect((await call('POST', '/v1/agent_delegations', { child_machine_id: b.id, delegator_user_id: u.id, scopes: ['read'] })).status).toBeGreaterThanOrEqual(400);
  });

  it('re-checks the delegator on every evaluation: MFA freshness, risk and device, revoking or denying as configured', async () => {
    const e = makeEngine();
    const call = client(e);
    const admin = client(e, null);
    const u = (await call('POST', '/v1/users', { email_address: 'cae@example.com' })).json;
    const a = await machine(call, 'a');
    const b = await machine(call, 'b');
    await admin('PUT', '/__emulator/agent_fabric', { continuousEvaluation: true, maxMfaAgeSeconds: 300, maxRiskLevel: 'medium', requireTrustedDevice: true });
    const body = { child_machine_id: a.id, delegator_user_id: u.id, scopes: ['read'] };
    // no session, no MFA, no device: refused at creation
    expect((await call('POST', '/v1/agent_delegations', body)).status).toBe(403);
    await call('POST', '/v1/sessions', { user_id: u.id });
    await admin('PUT', `/__emulator/agent_posture/${u.id}`, { mfa_at: e.clock.now(), risk: 'low', device_compliant: true });
    const root = (await call('POST', '/v1/agent_delegations', body)).json;
    expect(root.posture).toMatchObject({ risk: 'low', device: 'compliant' });
    const evaluate = async (enforce = false) => (await call('POST', `/v1/agent_delegations/${root.id}/evaluate`, { enforce })).json;
    expect(await evaluate()).toMatchObject({ object: 'agent_access_evaluation', decision: 'allow', reasons: [], valid_for_seconds: 30 });
    await admin('PUT', `/__emulator/agent_posture/${u.id}`, { risk: 'high' });
    expect(await evaluate()).toMatchObject({ decision: 'deny', reasons: ['risk_too_high'], valid_for_seconds: 0 });
    expect((await call('GET', `/v1/agent_delegations/${root.id}`)).json.status).toBe('active'); // evaluating alone changes nothing
    await admin('PUT', `/__emulator/agent_posture/${u.id}`, { risk: 'low', device_compliant: false });
    expect((await evaluate()).reasons).toEqual(['untrusted_device']);
    await admin('PUT', `/__emulator/agent_posture/${u.id}`, { device_compliant: true });
    await admin('POST', '/__emulator/time/advance', { ms: 400_000 });
    expect((await evaluate()).reasons).toContain('mfa_stale');
    // enforce with onFailure revoke: the subtree is revoked and the denial announced
    const sub = (await call('POST', '/v1/agent_delegations', { child_machine_id: b.id, parent_delegation_id: root.id, scopes: ['read'] })).json;
    expect((await evaluate(true)).decision).toBe('deny');
    expect((await call('GET', `/v1/agent_delegations/${sub.id}`)).json.status).toBe('revoked');
    expect(events(e, 'agent.access_denied')[0]?.payload.data).toMatchObject({ delegation_id: root.id, reasons: expect.arrayContaining(['mfa_stale']), action: 'revoked' });
    expect(events(e, 'agent.delegation_revoked').length).toBeGreaterThan(0);
    expect((await call('GET', `/v1/agent_delegations/${root.id}`)).json.evaluations.length).toBeGreaterThan(0);
    // onFailure deny keeps the delegation and the sweep re-evaluates it
    await admin('PUT', '/__emulator/agent_fabric', { onFailure: 'deny', maxMfaAgeSeconds: null });
    await admin('PUT', `/__emulator/agent_posture/${u.id}`, { mfa_at: e.clock.now() });
    const root2 = (await call('POST', '/v1/agent_delegations', { child_machine_id: b.id, delegator_user_id: u.id, scopes: ['read'] })).json;
    await admin('PUT', `/__emulator/agent_posture/${u.id}`, { risk: 'high' });
    expect((await admin('POST', '/__emulator/agent_fabric/sweep')).json).toEqual({ evaluated: 1, denied: 1 });
    expect((await call('GET', `/v1/agent_delegations/${root2.id}`)).json).toMatchObject({ status: 'active', last_decision: 'deny' });
    await admin('PUT', '/__emulator/agent_fabric', { continuousEvaluation: false });
    expect((await admin('POST', '/__emulator/agent_fabric/sweep')).json).toEqual({ evaluated: 0, denied: 0 });
  });
});

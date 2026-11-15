/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { client, makeEngine } from './test-support';
import type { Engine } from './engine';

const b64 = (v: string | Buffer): string => Buffer.from(v).toString('base64url');
const ec = () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { ...pair, jwk: pair.publicKey.export({ format: 'jwk' }) as Record<string, string> };
};
const es256 = (key: KeyObject, header: Record<string, unknown>, payload: Record<string, unknown>): string => {
  const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  return `${input}.${b64(nodeSign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }))}`;
};
const nowS = () => Math.floor(Date.now() / 1000);
const claimsOf = async (e: Engine, jwt: string): Promise<any> => ((await e.tokens.verifyAny(jwt)) as any).claims;

// ── machine tokens: pre_token Actions and the rl claim ──
describe('machine tokens', () => {
  const setup = async () => {
    const e = makeEngine();
    const call = client(e);
    const anon = client(e, null);
    const issuer = ec();
    const m = (await call('POST', '/v1/machines', { name: 'ci' })).json;
    await call('POST', '/v1/machine_trust_policies', { machine_id: m.id, name: 'gha', kind: 'github_actions', audience: 'https://atlas.example', subject_pattern: 'repo:acme/app:*', jwks: { keys: [{ ...issuer.jwk, kid: 'k1', alg: 'ES256' }] } });
    await call('POST', `/v1/machines/${m.id}/grants`, { resource_server_id: 'https://api.example', scopes: ['read'] });
    const mint = (extra: Record<string, unknown> = {}) =>
      anon('POST', '/v1/machines/federate', { machine_id: m.id, audience: 'https://api.example', token: es256(issuer.privateKey, { alg: 'ES256', kid: 'k1' }, { iss: 'https://token.actions.githubusercontent.com', aud: 'https://atlas.example', sub: 'repo:acme/app:ref:refs/heads/main', iat: nowS(), exp: nowS() + 300, ...extra }) });
    const action = async (code: string, over: Record<string, unknown> = {}) => (await call('POST', '/v1/actions', { name: `a-${Math.random().toString(36).slice(2)}`, trigger: 'pre_token', code, enabled: true, ...over })).json;
    const bind = (ids: string[], trigger = 'pre_token') => call('PUT', `/v1/actions/bindings/${trigger}`, { action_ids: ids });
    return { e, call, anon, m, mint, action, bind };
  };

  it('applies a bound pre_token Action to the machine token, and never lets it forge an owned claim', async () => {
    const { e, mint, action, bind } = await setup();
    expect((await claimsOf(e, (await mint()).json.token)).minted_for).toBeUndefined();
    const a = await action(`api.accessToken.setCustomClaim('minted_for', event.context.tokenType);\napi.accessToken.setCustomClaim('tier', 'gold');\napi.accessToken.setCustomClaim('limits', {"a": 1});\napi.accessToken.setCustomClaim('sub', 'forged');\napi.accessToken.setCustomClaim('scope', 'admin');`);
    expect((await bind([a.id])).json).toMatchObject({ object: 'action_binding_list', trigger: 'pre_token', action_ids: [a.id] });
    const res = await mint();
    expect(res.status).toBe(200);
    const claims = await claimsOf(e, res.json.token);
    expect(claims).toMatchObject({ minted_for: 'machine', tier: 'gold', limits: { a: 1 }, scope: 'read' });
    expect(claims.sub).not.toBe('forged');
  });

  it('refuses issuance when an Action denies, and ignores disabled Actions and statements in conditionals', async () => {
    const { e, mint, action, bind } = await setup();
    const conditional = await action(`if (event.context.audience === 'https://nowhere') { api.access.deny('never'); }`);
    const off = await action(`api.access.deny('off');`, { enabled: false });
    await bind([conditional.id, off.id]);
    expect((await mint()).status).toBe(200);
    const deny = await action(`api.access.deny('No machine tokens today.');`);
    await bind([deny.id]);
    const refused = await mint();
    expect(refused.status).toBe(403);
    expect(refused.json.errors[0]).toMatchObject({ code: 'ACTION_BLOCKED', message: 'No machine tokens today.', meta: { trigger: 'pre_token' } });
    // a statement the emulator cannot read fails the run closed, like a crashing Action
    const crash = await action(`api.accessToken.setCustomClaim('x', compute());`);
    await bind([crash.id]);
    expect((await mint()).json.errors[0]).toMatchObject({ code: 'ACTION_BLOCKED' });
    await bind([]);
    expect((await claimsOf(e, (await mint()).json.token)).x).toBeUndefined();
  });

  it('validates bindings like the real route', async () => {
    const { call, action, bind } = await setup();
    const a = await action(`api.accessToken.setCustomClaim('a', 1);`);
    const login = await action(`api.accessToken.setCustomClaim('a', 1);`, { trigger: 'post_login' });
    expect((await call('GET', '/v1/actions/bindings/pre_token')).json.action_ids).toEqual([]);
    expect((await call('GET', '/v1/actions/bindings/on_tuesday')).status).toBe(400);
    expect((await bind([a.id], 'on_tuesday')).status).toBe(400);
    expect((await bind([a.id, a.id])).json.errors[0].param).toBe('action_ids');
    expect((await bind(['act_missing'])).status).toBe(400);
    expect((await bind([login.id])).status).toBe(409);
    expect((await call('PUT', '/v1/actions/bindings/pre_token', { action_ids: 'x' })).status).toBe(400);
    await bind([a.id]);
    await call('DELETE', `/v1/actions/${a.id}`);
    expect((await call('GET', '/v1/actions/bindings/pre_token')).json.action_ids).toEqual([]);
  });

  it('carries the rate-limit claim from the default machine policy, and lets an override win', async () => {
    const { e, call, m, mint } = await setup();
    expect((await claimsOf(e, (await mint()).json.token)).rl).toBeUndefined();
    const policy = (await call('POST', '/v1/rate_limit_policies', { name: 'machines', subject: 'machine', limit: 120, window_seconds: 60, burst: 20, is_default: true })).json;
    const first = (await claimsOf(e, (await mint()).json.token)).rl;
    expect(first).toMatchObject({ limit: 120, window: 60, burst: 20 });
    expect(first.v).toMatch(/^[0-9a-f]{16}$/);
    await call('PATCH', `/v1/rate_limit_policies/${policy.id}`, { limit: 200 });
    const next = (await claimsOf(e, (await mint()).json.token)).rl;
    expect(next).toMatchObject({ limit: 200, window: 60 });
    expect(next.v).not.toBe(first.v);
    void m;
  });

  it('validates policies and overrides, and resolves override before default', async () => {
    const { call, m } = await setup();
    const base = { name: 'm', subject: 'machine', limit: 10, window_seconds: 60 };
    for (const bad of [{ name: 'Bad Name' }, { subject: 'nobody' }, { limit: 0 }, { window_seconds: 100_000 }, { burst: -1 }, { plan_overrides: { pro: { limit: 5, speed: 1 } } }, { is_default: 'yes' }]) {
      expect((await call('POST', '/v1/rate_limit_policies', { ...base, ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
    const p = (await call('POST', '/v1/rate_limit_policies', { ...base, is_default: true })).json;
    expect(p).toMatchObject({ object: 'api_rate_limit_policy', version: 1, enabled: true, burst: null, plan_overrides: {} });
    expect((await call('POST', '/v1/rate_limit_policies', { ...base })).status).toBe(409); // name taken
    expect((await call('POST', '/v1/rate_limit_policies', { ...base, name: 'other', is_default: true })).status).toBe(409); // default slot taken
    const resolve = async (qs: string) => (await call('GET', `/v1/rate_limit_policies/resolve?${qs}`)).json;
    expect((await resolve(`machine_id=${m.id}`)).rate_limit).toMatchObject({ limit: 10, source: 'default', policy_name: 'm' });
    expect((await call('GET', '/v1/rate_limit_policies/resolve')).status).toBe(400);
    expect((await call('PUT', `/v1/rate_limit_overrides/machine/${m.id}`, { limit: 5 })).status).toBe(400); // needs window_seconds
    expect((await call('PUT', `/v1/rate_limit_overrides/machine/${m.id}`, { limit: 5, window_seconds: 10, policy_id: p.id })).status).toBe(400); // both
    expect((await call('PUT', '/v1/rate_limit_overrides/machine/mch_missing', { limit: 5, window_seconds: 10 })).status).toBe(404);
    expect((await call('PUT', `/v1/rate_limit_overrides/user/${m.id}`, { limit: 5, window_seconds: 10 })).status).toBe(404);
    const put = await call('PUT', `/v1/rate_limit_overrides/machine/${m.id}`, { limit: 5, window_seconds: 10, reason: 'noisy' });
    expect(put.json).toMatchObject({ object: 'api_rate_limit_override', subject_type: 'machine', limit: 5, window_seconds: 10, reason: 'noisy' });
    expect((await call('PUT', `/v1/rate_limit_overrides/machine/${m.id}`, { limit: 5, window_seconds: 10, reason: 'noisy' })).json.updated_at).toBe(put.json.updated_at);
    expect((await resolve(`machine_id=${m.id}`)).rate_limit).toMatchObject({ limit: 5, source: 'override' });
    expect((await call('DELETE', `/v1/rate_limit_policies/${p.id}`)).status).toBe(200);
    expect((await call('GET', `/v1/rate_limit_overrides?subject_type=machine`)).json.data).toHaveLength(1);
    expect((await call('DELETE', `/v1/rate_limit_overrides/machine/${m.id}`)).json.deleted).toBe(true);
    expect((await call('GET', `/v1/rate_limit_overrides/machine/${m.id}`)).status).toBe(404);
    expect((await resolve(`machine_id=${m.id}`)).rate_limit).toBeNull();
  });
});

// ── connection import ──
describe('connection import', () => {
  const owner = async (e: Engine) => (await client(e)('POST', '/v1/users', { email_address: `imp-${Math.random().toString(36).slice(2)}@example.com` })).json;
  const row = (u: any, over: Record<string, unknown> = {}) => ({ provider: 'github', owner: { type: 'user', id: u.id }, external_id: 'gh-1', access_token: 'gho_x', refresh_token: 'ghr_x', scopes: ['repo'], ...over });

  it('creates, updates on re-import, and reports per-row failures without changing anything', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = await owner(e);
    const res = await call('POST', '/v1/connections/import', { connections: [row(u), row(u, { external_id: 'gh-1' }), row(u, { external_id: undefined }), row({ id: 'user_missing' }, { external_id: 'gh-2' }), { provider: 'github', owner: { type: 'user', id: u.id }, external_id: 'gh-3' }] });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ object: 'connection_import', total: 5, created: 1, failed: 4, dry_run: false });
    expect(res.json.data.map((r: any) => r.error?.code ?? r.status)).toEqual(['created', 'duplicate_in_batch', 'external_id_required', 'owner_not_found', 'invalid']);
    const id = res.json.data[0].connection_id;
    const got = (await call('GET', `/v1/connections/${id}`)).json;
    expect(got).toMatchObject({ provider: 'github', external_id: 'gh-1', status: 'connected', scopes: ['repo'] });
    expect(JSON.stringify(got)).not.toContain('gho_x');
    const again = await call('POST', '/v1/connections/import', { connections: [row(u)] });
    expect(again.json).toMatchObject({ created: 0, updated: 1 });
    expect(again.json.data[0].connection_id).toBe(id);
  });

  it('a dry run stores nothing, and the shape checks answer 400', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = await owner(e);
    const dry = await call('POST', '/v1/connections/import?dry_run=true', { connections: [row(u)] });
    expect(dry.json).toMatchObject({ dry_run: true, would_create: 1, created: 0 });
    expect(dry.json.data[0].check).toBe('ok_unverified');
    expect((await call('GET', '/v1/connections')).json.data).toHaveLength(0);
    expect((await call('POST', '/v1/connections/import', { connections: [] })).status).toBe(400);
    expect((await call('POST', '/v1/connections/import', { connections: [row(u)], exchange_expiring: 'yes' })).status).toBe(400);
    expect((await call('POST', '/v1/connections/import?verify=maybe', { connections: [row(u)] })).status).toBe(400);
  });

  it('exchange_expiring swaps a non-expiring Shopify token for an expiring one through the fetch option, and keeps the token on a refusal', async () => {
    const seen: string[] = [];
    let refuse = false;
    const fetchStub = (async (url: string) => {
      seen.push(String(url));
      return refuse ? new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 }) : new Response(JSON.stringify({ access_token: 'shpat_new', refresh_token: 'shprt_new', expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const e = makeEngine({ fetch: fetchStub });
    const call = client(e);
    const u = await owner(e);
    const shop = (id: string, over: Record<string, unknown> = {}) => ({ provider: 'shopify', owner: { type: 'user', id: u.id }, external_id: id, access_token: 'shpat_old', host_params: { shop: 'acme' }, ...over });
    const ok = await call('POST', '/v1/connections/import', { exchange_expiring: true, connections: [shop('s1')] });
    expect(ok.json.data[0]).toMatchObject({ status: 'created', exchanged: true });
    expect(seen).toEqual(['https://acme.myshopify.com/admin/oauth/access_token']);
    expect((e.generic.get('connections')?.get(ok.json.data[0].connection_id) as any)).toMatchObject({ expiring: true, has_refresh_token: true });
    // not requested: no exchange; has a refresh token: no exchange; dry run: no exchange
    const plain = await call('POST', '/v1/connections/import', { connections: [shop('s2')] });
    expect(plain.json.data[0].exchanged).toBeUndefined();
    const refreshed = await call('POST', '/v1/connections/import', { exchange_expiring: true, connections: [shop('s3', { refresh_token: 'r' })] });
    expect(refreshed.json.data[0].exchanged).toBeUndefined();
    expect(seen).toHaveLength(1);
    refuse = true;
    const refused = await call('POST', '/v1/connections/import', { exchange_expiring: true, connections: [shop('s4')] });
    expect(refused.json.data[0]).toMatchObject({ status: 'created', exchanged: false, exchange_error: 'invalid_request' });
    expect((e.generic.get('connections')?.get(refused.json.data[0].connection_id) as any).expiring).toBe(false);
    const noShop = await call('POST', '/v1/connections/import', { exchange_expiring: true, connections: [shop('s5', { host_params: {} })] });
    expect(noShop.json.data[0]).toMatchObject({ exchanged: false, exchange_error: 'exchange_unavailable' });
  });

  it('refuses an account already connected under another owner', async () => {
    const e = makeEngine();
    const call = client(e);
    const [a, b] = [await owner(e), await owner(e)];
    await call('POST', '/v1/connections/import', { connections: [row(a)] });
    const res = await call('POST', '/v1/connections/import', { connections: [row(b)] });
    expect(res.json.data[0].error.code).toBe('external_id_taken');
  });
});

// ── data-subject requests and exports ──
describe('data-subject requests', () => {
  const setup = async () => {
    const e = makeEngine();
    const call = client(e);
    const user = (await call('POST', '/v1/users', { email_address: `dsr-${Math.random().toString(36).slice(2)}@example.com`, first_name: 'Dee', private_metadata: { risk: 'secret-note' } })).json;
    return { e, call, user };
  };

  it('creates by user id or email, reuses an open request, and refuses a bad type or subject', async () => {
    const { call, user } = await setup();
    const r = await call('POST', '/v1/data_subject_requests', { user_id: user.id, type: 'access' });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ object: 'data_subject_request', type: 'export', canonical_type: 'access', status: 'pending', user_id: user.id, overdue: false });
    expect(r.json.due_at - r.json.requested_at).toBe(30 * 86_400_000);
    const same = await call('POST', '/v1/data_subject_requests', { subject_email: user.email_addresses[0].email_address, type: 'export' });
    expect(same.json.id).toBe(r.json.id);
    expect((await call('POST', '/v1/data_subject_requests', { user_id: user.id, type: 'bogus' })).status).toBe(400);
    expect((await call('POST', '/v1/data_subject_requests', { type: 'access' })).status).toBe(400);
    expect((await call('POST', '/v1/data_subject_requests', { user_id: 'user_missing', type: 'access' })).status).toBe(404);
    const erasure = await call('POST', '/v1/data_subject_requests', { user_id: user.id, type: 'deletion' });
    expect(erasure.json).toMatchObject({ type: 'erasure', canonical_type: 'deletion', status: 'scheduled' });
    expect(erasure.json.scheduled_for - erasure.json.requested_at).toBe(7 * 86_400_000);
    const closure = await call('POST', '/v1/data_subject_requests', { user_id: (await call('POST', '/v1/users', { email_address: `c-${Math.random().toString(36).slice(2)}@example.com` })).json.id, type: 'closure' });
    expect(closure.json).toMatchObject({ canonical_type: 'closure', due_at: null });
  });

  it('fulfils an export into a bundle that never carries private metadata, then refuses a second action', async () => {
    const { call, user } = await setup();
    const r = (await call('POST', '/v1/data_subject_requests', { user_id: user.id, type: 'access' })).json;
    const done = await call('POST', `/v1/data_subject_requests/${r.id}/fulfill`);
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ status: 'completed' });
    expect(done.json.result).toMatchObject({ object: 'data_export', format_version: 1, user: { id: user.id, first_name: 'Dee' } });
    expect(JSON.stringify(done.json.result)).not.toContain('secret-note');
    expect(JSON.stringify(done.json.result)).not.toContain('private_metadata');
    const again = await call('POST', `/v1/data_subject_requests/${r.id}/fulfill`);
    expect(again.status).toBe(409);
    expect(again.json.errors[0].code).toBe('FORBIDDEN');
    expect((await call('POST', `/v1/data_subject_requests/${r.id}/reject`)).status).toBe(409);
    expect((await call('POST', `/v1/data_subject_requests/${r.id}/cancel`)).status).toBe(409);
    expect((await call('GET', `/v1/data_subject_requests/${r.id}`)).json.result.object).toBe('data_export');
  });

  it('lists with filters, rejects and cancels with the real 409s', async () => {
    const { call, user } = await setup();
    const a = (await call('POST', '/v1/data_subject_requests', { user_id: user.id, type: 'restriction' })).json;
    expect((await call('POST', `/v1/data_subject_requests/${a.id}/cancel`)).json).toMatchObject({ status: 'cancelled' });
    const b = (await call('POST', '/v1/data_subject_requests', { user_id: user.id, type: 'access' })).json;
    expect((await call('POST', `/v1/data_subject_requests/${b.id}/cancel`)).status).toBe(409);
    expect((await call('POST', `/v1/data_subject_requests/${b.id}/reject`, { reason: 'No identity proof' })).json).toMatchObject({ status: 'rejected', reason: 'No identity proof' });
    const list = await call('GET', `/v1/data_subject_requests?user_id=${user.id}&status=rejected`);
    expect(list.json.data.map((r: any) => r.id)).toEqual([b.id]);
    expect((await call('GET', '/v1/data_subject_requests?type=access')).json.data.every((r: any) => r.type === 'export')).toBe(true);
    expect((await call('GET', '/v1/data_subject_requests/dsr_missing')).status).toBe(404);
  });

  it('extends the deadline with a reason, later than now, within three years, only while open', async () => {
    const { e, call, user } = await setup();
    const r = (await call('POST', '/v1/data_subject_requests', { user_id: user.id, type: 'restriction' })).json;
    const later = r.due_at + 10 * 86_400_000;
    expect((await call('POST', `/v1/data_subject_requests/${r.id}/extend`, { due_at: later })).status).toBe(400);
    expect((await call('POST', `/v1/data_subject_requests/${r.id}/extend`, { due_at: 'soon', reason: 'x' })).status).toBe(400);
    expect((await call('POST', `/v1/data_subject_requests/${r.id}/extend`, { due_at: r.due_at, reason: 'same' })).status).toBe(400);
    expect((await call('POST', `/v1/data_subject_requests/${r.id}/extend`, { due_at: r.requested_at + 4 * 365 * 86_400_000, reason: 'typo' })).status).toBe(400);
    const ok = await call('POST', `/v1/data_subject_requests/${r.id}/extend`, { due_at: new Date(later).toISOString(), reason: 'Complex request' });
    expect(ok.json).toMatchObject({ due_at: later, due_extended_reason: 'Complex request' });
    // overdue only once the (extended) deadline has passed
    e.clock.advance(40 * 86_400_000);
    await call('POST', `/v1/data_subject_requests/${r.id}/fulfill`);
    expect((await call('POST', `/v1/data_subject_requests/${r.id}/extend`, { due_at: later + 1, reason: 'late' })).status).toBe(409);
    expect((await call('POST', '/v1/data_subject_requests/dsr_missing/extend', { due_at: later, reason: 'x' })).status).toBe(404);
  });

  it('runs an erasure on fulfil, honours a legal hold, and issues one stable signed receipt', async () => {
    const { e, call, user } = await setup();
    const r = (await call('POST', '/v1/data_subject_requests', { user_id: user.id, type: 'erasure' })).json;
    expect((await call('GET', `/v1/data_subject_requests/${r.id}/receipt`)).status).toBe(409);
    await call('POST', `/v1/users/${user.id}/legal_hold`, { reason: 'case 7' });
    const held = await call('POST', `/v1/data_subject_requests/${r.id}/fulfill`);
    expect(held.json.errors[0].code).toBe('LEGAL_HOLD');
    await call('POST', `/v1/users/${user.id}/legal_hold/release`);
    const done = await call('POST', `/v1/data_subject_requests/${r.id}/fulfill`);
    expect(done.json).toMatchObject({ status: 'completed' });
    expect(done.json.result.erased_at).toBeTruthy();
    expect((await call('GET', `/v1/users/${user.id}`)).status).toBe(404);
    const receipt = await call('GET', `/v1/data_subject_requests/${r.id}/receipt`);
    expect(receipt.json).toMatchObject({ object: 'deletion_receipt', request_id: r.id, subject_id: user.id });
    expect(receipt.json.claims).toMatchObject({ type: 'deletion_receipt', version: 1, request_type: 'deletion' });
    expect(JSON.stringify(receipt.json.claims)).not.toContain('dsr-');
    const verified = (await e.tokens.verifyAny(receipt.json.receipt)) as any;
    expect(verified.ok).toBe(true);
    expect(verified.claims).toMatchObject({ request_id: r.id, subject_id: user.id });
    expect((await call('GET', `/v1/data_subject_requests/${r.id}/receipt`)).json).toEqual(receipt.json);
  });

  it('a user exports their own data: one at a time, an hour apart, and never anyone else\'s request', async () => {
    const { e, call, user } = await setup();
    const other = (await call('POST', '/v1/users', { email_address: `o-${Math.random().toString(36).slice(2)}@example.com` })).json;
    const org = (await call('POST', '/v1/organizations', { name: 'Acme' })).json;
    await call('POST', `/v1/organizations/${org.id}/memberships`, { user_id: user.id, role: 'org:member' });
    const session = (await call('POST', '/v1/sessions', { user_id: user.id })).json;
    const mine = client(e, session.jwt);
    const theirs = client(e, (await call('POST', '/v1/sessions', { user_id: other.id })).json.jwt);
    const created = await mine('POST', '/v1/client/me/data_export');
    expect(created.status).toBe(202);
    expect(created.json).toMatchObject({ object: 'data_subject_request', type: 'export', status: 'pending', requested_at: expect.any(Number) });
    expect((await mine('POST', '/v1/client/me/data_export')).status).toBe(429);
    const polled = await mine('GET', `/v1/client/me/data_export/${created.json.id}`);
    expect(polled.json.status).toBe('completed');
    const bundle = polled.json.result;
    expect(bundle).toMatchObject({ object: 'data_export', user: { id: user.id }, organization_memberships: [{ role: 'org:member', organization: { id: org.id } }] });
    expect(bundle.sessions[0]).toMatchObject({ id: session.id });
    expect(JSON.stringify(bundle)).not.toMatch(/secret-note|private_metadata|refresh_token|password_hash/);
    expect(bundle.audit_log.map((a: any) => a.action)).toContain('data_subject_request.export.requested');
    // another user's request id is a 404; no session is a 401
    expect((await theirs('GET', `/v1/client/me/data_export/${created.json.id}`)).status).toBe(404);
    expect((await client(e, null)('GET', '/v1/client/me/data_export')).status).toBe(401);
    // inside the hour: refused; after it: allowed again (a fresh session token, the first one has expired by then)
    expect((await mine('POST', '/v1/client/me/data_export')).json.errors[0].code).toBe('RATE_LIMITED');
    e.clock.advance(61 * 60_000);
    const later = client(e, (await call('POST', '/v1/sessions', { user_id: user.id })).json.jwt);
    expect(((await later('GET', '/v1/client/me/data_export')).json.data as any[]).length).toBe(1);
    const second = await later('POST', '/v1/client/me/data_export');
    expect(second.status).toBe(202);
    expect(second.json.id).not.toBe(created.json.id);
  });
});

// ── per-organization maxSessions ──
describe('organization policy and maxSessions', () => {
  it('reads and writes the policy with validation, null clearing a value', async () => {
    const e = makeEngine();
    const call = client(e);
    const org = (await call('POST', '/v1/organizations', { name: 'Cap' })).json;
    expect((await call('GET', `/v1/organizations/${org.id}/policy`)).json).toEqual({ object: 'organization_policy', organization_id: org.id, policy: {} });
    expect((await call('PATCH', `/v1/organizations/${org.id}/policy`, { maxSessions: 2, ssoMultiConnection: true })).json.policy).toEqual({ maxSessions: 2, ssoMultiConnection: true });
    for (const bad of [{ maxSessions: 0 }, { maxSessions: 101 }, { maxSessions: 1.5 }, { maxSessionAgeSeconds: 10 }, { ssoMultiConnection: 'yes' }, { entitlementPlan: 'pro' }]) {
      const r = await call('PATCH', `/v1/organizations/${org.id}/policy`, bad);
      expect(r.status, JSON.stringify(bad)).toBe(422);
      expect(r.json.errors[0].code).toBe('VALIDATION_FAILED');
    }
    expect((await call('PATCH', `/v1/organizations/${org.id}/policy`, { maxSessions: null })).json.policy).toEqual({ ssoMultiConnection: true });
    expect((await call('GET', '/v1/organizations/org_missing/policy')).status).toBe(404);
  });

  it('ends the least recently active session past the cap, keeps the new one, and takes the smallest cap across orgs', async () => {
    const e = makeEngine();
    const call = client(e);
    const revoked: any[] = [];
    e.webhooks.emit = ((orig) => (type: string, data: any) => {
      if (type === 'session.revoked') revoked.push(data);
      return orig.call(e.webhooks, type, data);
    })(e.webhooks.emit) as any;
    const user = (await call('POST', '/v1/users', { email_address: `cap-${Math.random().toString(36).slice(2)}@example.com` })).json;
    const [a, b] = [(await call('POST', '/v1/organizations', { name: 'A' })).json, (await call('POST', '/v1/organizations', { name: 'B' })).json];
    for (const o of [a, b]) await call('POST', `/v1/organizations/${o.id}/memberships`, { user_id: user.id, role: 'org:member' });
    const open = async () => (await call('POST', '/v1/sessions', { user_id: user.id })).json;
    const s1 = await open();
    const s2 = await open();
    const s3 = await open();
    expect((await call('GET', `/v1/sessions?user_id=${user.id}&active=true`)).json.data).toHaveLength(3);
    await call('PATCH', `/v1/organizations/${a.id}/policy`, { maxSessions: 5 });
    await call('PATCH', `/v1/organizations/${b.id}/policy`, { maxSessions: 2 });
    e.clock.advance(1000);
    const s4 = await open();
    const active = (await call('GET', `/v1/sessions?user_id=${user.id}&active=true`)).json.data.map((s: any) => s.id);
    expect(active).toHaveLength(2);
    expect(active).toContain(s4.id);
    expect(active).not.toContain(s1.id);
    expect(revoked.map((r) => r.reason)).toEqual(['org_max_sessions_exceeded', 'org_max_sessions_exceeded']);
    expect(revoked.map((r) => r.id).sort()).toEqual([s1.id, s2.id].sort());
    expect((await call('GET', `/v1/sessions/${s3.id}`)).json.status).toBe('active');
    // a user in no capped org is never limited
    const free = (await call('POST', '/v1/users', { email_address: `free-${Math.random().toString(36).slice(2)}@example.com` })).json;
    for (let i = 0; i < 4; i++) await call('POST', '/v1/sessions', { user_id: free.id });
    expect((await call('GET', `/v1/sessions?user_id=${free.id}&active=true`)).json.data).toHaveLength(4);
  });
});

// ── SCIM: Bulk, sort and ETag ──
describe('SCIM bulk, sort and ETag', () => {
  const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
  const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
  const BULK = 'urn:ietf:params:scim:api:messages:2.0:BulkRequest';
  const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
  const setup = async (scopes?: string[]) => {
    const e = makeEngine();
    const call = client(e);
    const org = (await call('POST', '/v1/organizations', { name: 'Scim' })).json;
    const token = (await call('POST', '/v1/scim_tokens', { organization_id: org.id, ...(scopes ? { scopes } : {}) })).json.token;
    const scim = client(e, token);
    return { e, call, scim, org, token };
  };

  it('states the limits it enforces in ServiceProviderConfig', async () => {
    const { scim } = await setup();
    expect((await scim('GET', '/scim/v2/ServiceProviderConfig')).json).toMatchObject({ bulk: { supported: true, maxOperations: 100, maxPayloadSize: 1048576 }, sort: { supported: true }, etag: { supported: true } });
  });

  it('runs bulk operations in order with bulkId references, reporting each result', async () => {
    const { scim } = await setup();
    const res = await scim('POST', '/scim/v2/Bulk', {
      schemas: [BULK],
      Operations: [
        { method: 'POST', bulkId: 'u1', path: '/Users', data: { schemas: [USER], userName: 'ann@example.com', name: { givenName: 'Ann' } } },
        { method: 'POST', bulkId: 'g1', path: '/Groups', data: { schemas: [GROUP], displayName: 'Admins', members: [{ value: 'bulkId:u1' }] } },
        { method: 'PATCH', path: '/Users/bulkId:u1', data: { schemas: [PATCH], Operations: [{ op: 'replace', path: 'name.givenName', value: 'Anne' }] } },
        { method: 'POST', bulkId: 'u1', path: '/Users', data: { schemas: [USER], userName: 'dup@example.com' } },
        { method: 'DELETE', path: '/Users/user_missing' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.json.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:BulkResponse']);
    const ops = res.json.Operations;
    expect(ops.map((o: any) => o.status)).toEqual(['201', '201', '200', '400', '404']);
    expect(ops[0]).toMatchObject({ method: 'POST', bulkId: 'u1', location: expect.stringContaining('/scim/v2/Users/'), version: expect.stringMatching(/^W\//) });
    const userId = ops[0].location.split('/').pop();
    expect(ops[1].location).toContain('/Groups/');
    expect((await scim('GET', `/scim/v2/Users/${userId}`)).json.name.givenName).toBe('Anne');
    expect((await scim('GET', new URL(ops[1].location).pathname)).json.members[0].value).toBe(userId);
    expect(ops[3].response).toMatchObject({ scimType: 'invalidValue' });
  });

  it('stops after failOnErrors, and enforces the shape and limits', async () => {
    const { scim } = await setup();
    const del = { method: 'DELETE', path: '/Users/user_missing' };
    const stopped = await scim('POST', '/scim/v2/Bulk', { schemas: [BULK], failOnErrors: 2, Operations: [del, del, del, del] });
    expect(stopped.json.Operations).toHaveLength(2);
    expect((await scim('POST', '/scim/v2/Bulk', { Operations: [del] })).json.scimType).toBe('invalidSyntax');
    expect((await scim('POST', '/scim/v2/Bulk', { schemas: [BULK], Operations: [] })).status).toBe(400);
    const tooMany = await scim('POST', '/scim/v2/Bulk', { schemas: [BULK], Operations: Array.from({ length: 101 }, () => del) });
    expect(tooMany.status).toBe(413);
    expect(tooMany.json.scimType).toBe('tooMany');
    const big = await scim('POST', '/scim/v2/Bulk', { schemas: [BULK], Operations: [{ method: 'POST', bulkId: 'b', path: '/Users', data: { userName: 'x'.repeat(1_100_000) } }] });
    expect(big.status).toBe(413);
    const bad = await scim('POST', '/scim/v2/Bulk', { schemas: [BULK], Operations: [{ method: 'GET', path: '/Users' }, { method: 'POST', path: '/Users', data: {} }, { method: 'DELETE', path: '/Bulk' }, { method: 'POST', bulkId: 'z', path: '/Users/bulkId:nope', data: {} }] });
    expect(bad.json.Operations.map((o: any) => o.status)).toEqual(['400', '400', '400', '409']);
    expect(bad.json.Operations.map((o: any) => o.response.scimType)).toEqual(['invalidValue', 'invalidValue', 'invalidPath', 'invalidValue']);
  });

  it('refuses bulk without a token, and for a read-only token', async () => {
    const { e, token } = await setup(['read']);
    expect((await client(e, null)('POST', '/scim/v2/Bulk', { schemas: [BULK], Operations: [] })).status).toBe(401);
    expect((await client(e, token)('POST', '/scim/v2/Bulk', { schemas: [BULK], Operations: [{ method: 'POST', bulkId: 'a', path: '/Users', data: { userName: 'a@example.com' } }] })).status).toBe(403);
  });

  it('sorts Users and Groups by attribute, both ways, nulls last ascending, and refuses what it cannot sort', async () => {
    const { scim } = await setup();
    for (const [mail, first] of [['carl@example.com', 'Carl'], ['Abe@example.com', 'abe'], ['bea@example.com', null]] as const) await scim('POST', '/scim/v2/Users', { schemas: [USER], userName: mail, ...(first ? { name: { givenName: first } } : {}) });
    const names = async (qs: string) => ((await scim('GET', `/scim/v2/Users?${qs}`)).json.Resources as any[]).map((u) => u.userName);
    expect(await names('sortBy=userName')).toEqual(['Abe@example.com', 'bea@example.com', 'carl@example.com']);
    expect(await names('sortBy=userName&sortOrder=descending')).toEqual(['carl@example.com', 'bea@example.com', 'Abe@example.com']);
    expect(await names('sortBy=name.givenName')).toEqual(['Abe@example.com', 'carl@example.com', 'bea@example.com']);
    expect(await names('sortBy=name.givenName&sortOrder=descending')).toEqual(['bea@example.com', 'carl@example.com', 'Abe@example.com']);
    expect(await names('sortBy=emails.value&sortOrder=ASCENDING&count=2')).toEqual(['Abe@example.com', 'bea@example.com']);
    for (const bad of ['sortBy=name', 'sortBy=password', 'sortBy=user%20Name', 'sortBy=userName&sortOrder=sideways', 'sortOrder=sideways']) {
      const r = await scim('GET', `/scim/v2/Users?${bad}`);
      expect(r.status, bad).toBe(400);
      expect(r.json.scimType).toBe('invalidValue');
    }
    expect((await scim('GET', '/scim/v2/Users?sortOrder=descending')).status).toBe(200);
    for (const n of ['Zed', 'alpha', 'Mid']) await scim('POST', '/scim/v2/Groups', { schemas: [GROUP], displayName: n });
    expect(((await scim('GET', '/scim/v2/Groups?sortBy=displayName')).json.Resources as any[]).map((g) => g.displayName)).toEqual(['alpha', 'Mid', 'Zed']);
    expect((await scim('GET', '/scim/v2/Groups?sortBy=members')).status).toBe(400);
  });

  it('serves weak ETags, 304 on a matching If-None-Match, and 412 on a stale If-Match', async () => {
    const { scim } = await setup();
    const created = await scim('POST', '/scim/v2/Users', { schemas: [USER], userName: 'etag@example.com', name: { givenName: 'E' } });
    const tag = created.headers.get('etag')!;
    expect(tag).toMatch(/^W\/"[A-Za-z0-9_-]{27}"$/);
    expect(created.json.meta.version).toBe(tag);
    const url = `/scim/v2/Users/${created.json.id}`;
    const got = await scim('GET', url);
    expect(got.headers.get('etag')).toBe(tag);
    expect((await scim('GET', url, undefined, { 'if-none-match': tag })).status).toBe(304);
    expect((await scim('GET', url, undefined, { 'if-none-match': '*' })).status).toBe(304);
    expect((await scim('GET', url, undefined, { 'if-none-match': 'W/"other"' })).status).toBe(200);
    const patch = (version: string | undefined) => scim('PATCH', url, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'name.givenName', value: 'F' }] }, version ? { 'if-match': version } : {});
    const stale = await patch('W/"stale"');
    expect(stale.status).toBe(412);
    expect(stale.json).toMatchObject({ scimType: 'invalidVers', status: '412' });
    expect((await scim('GET', url)).json.name.givenName).toBe('E');
    const ok = await patch(tag);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('etag')).not.toBe(tag);
    expect((await scim('PUT', url, { schemas: [USER], userName: 'etag@example.com' }, { 'if-match': tag })).status).toBe(412);
    expect((await scim('DELETE', url, undefined, { 'if-match': tag })).status).toBe(412);
    expect((await scim('DELETE', url, undefined, { 'if-match': ok.headers.get('etag')! })).status).toBe(204);
    // Groups carry the same preconditions; a list has no single tag
    const g = await scim('POST', '/scim/v2/Groups', { schemas: [GROUP], displayName: 'Tagged' });
    expect(g.headers.get('etag')).toMatch(/^W\//);
    expect((await scim('DELETE', `/scim/v2/Groups/${g.json.id}`, undefined, { 'if-match': 'W/"stale"' })).status).toBe(412);
    expect((await scim('GET', '/scim/v2/Users')).headers.get('etag')).toBeNull();
    // a bulk operation honours the version it names
    const res = await scim('POST', '/scim/v2/Bulk', { schemas: [BULK], Operations: [{ method: 'DELETE', path: `/Groups/${g.json.id}`, version: 'W/"stale"' }, { method: 'DELETE', path: `/Groups/${g.json.id}`, version: g.headers.get('etag') }] });
    expect(res.json.Operations.map((o: any) => o.status)).toEqual(['412', '204']);
  });
});

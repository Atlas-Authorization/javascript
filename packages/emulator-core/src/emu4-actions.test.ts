/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { client, makeEngine } from './test-support';
import { runActionTrigger } from './handlers/emu3-misc';

const setup = () => {
  const e = makeEngine();
  const call = client(e);
  const action = async (code: string, over: Record<string, unknown> = {}) => (await call('POST', '/v1/actions', { name: `a-${Math.random().toString(36).slice(2)}`, trigger: 'pre_token', code, enabled: true, ...over })).json;
  const test = async (code: string, event: Record<string, unknown> = {}) => {
    const a = await action(code);
    return (await call('POST', `/v1/actions/${a.id}/test`, { event })).json;
  };
  const bind = (ids: string[], trigger = 'pre_token') => call('PUT', `/v1/actions/bindings/${trigger}`, { action_ids: ids });
  return { e, call, action, test, bind };
};

// ── the sandbox ──
describe('action code in the sandbox', () => {
  it('runs conditionals, loops, helpers and async code, and collects what the api calls asked for', async () => {
    const { test } = setup();
    const r = await test(
      `const tiers = { free: 1, pro: 2 };
       function pick(plan) { return tiers[plan] ?? 0; }
       let total = 0;
       for (const p of ['free', 'pro', 'nope']) total += pick(p);
       await Promise.resolve();
       if (event.context.tokenType === 'machine') api.accessToken.setCustomClaim('total', total);
       api.idToken.setCustomClaim('hello', event.user.email);
       api.accessToken.suppressClaim('email');
       api.user.setAppMetadata('plan', 'pro');
       api.session.setCustomData('k', 'v');
       api.user.setBanned(true, 'abuse');
       api.console.log('ran', { total });`,
      { context: { tokenType: 'machine' } },
    );
    expect(r).toMatchObject({ object: 'action_test_result', error: null, denied: false, access_token_claims: { total: 3 }, id_token_claims: { hello: 'sample@example.com' }, suppressed_access_claims: ['email'], app_metadata: { plan: 'pro' }, user_edits: { banned: { value: true, reason: 'abuse' } }, logs: ['ran {"total":3}'] });
  });

  it('records deny, lock and pause intent, truncating like the real runtime', async () => {
    const { test } = setup();
    expect(await test(`api.access.deny('x'.repeat(600));`)).toMatchObject({ denied: true, error: null });
    expect((await test(`api.access.deny('x'.repeat(600));`)).deny_reason).toHaveLength(512);
    expect(await test(`api.access.lock();`)).toMatchObject({ lock_reason: 'Account locked.' });
    expect(await test(`api.access.pause('confirm');`)).toMatchObject({ pause_reason: 'confirm' });
  });

  it('queues api.http requests without sending them, masks the dry-run view, and refuses a non-https URL', async () => {
    const { test } = setup();
    const r = await test(`api.http.post('https://hooks.example/notify?token=abc', { a: 1 }, { headers: { 'x-key': 'secret' } });`);
    expect(r.error).toBeNull();
    expect(r.http_requests).toEqual([{ method: 'POST', url: `https://hooks.example/notify?token=${encodeURIComponent('\u2026')}`, header_names: ['x-key', 'content-type'], has_body: true, save_response_as: null }]);
    expect((await test(`api.http.get('http://insecure.example/');`)).error).toMatch(/https/);
    expect((await test(`api.http.get('https://x.example/', { headers: { host: 'evil' } });`)).error).toMatch(/set by Atlas/);
  });

  it('has no host globals and a frozen event', async () => {
    const { test } = setup();
    const r = await test(`api.accessToken.setCustomClaim('p', typeof process); api.accessToken.setCustomClaim('r', typeof require); api.accessToken.setCustomClaim('f', typeof fetch); api.accessToken.setCustomClaim('t', typeof setTimeout); api.accessToken.setCustomClaim('b', typeof Buffer); `);
    expect(r.access_token_claims).toEqual({ p: 'undefined', r: 'undefined', f: 'undefined', t: 'undefined', b: 'undefined' });
    expect((await test(`event.user.email = 'x';`)).error).toMatch(/read only|frozen|Cannot assign/i);
    expect((await test(`api.accessToken = null;`)).error).toMatch(/read only|frozen|Cannot assign/i);
  });

  it('cannot reach the host through the constructor chain or string evaluation', async () => {
    const { test } = setup();
    for (const code of [`this.constructor.constructor('return process')();`, `(async () => {}).constructor('return process')();`, `eval('process');`, `new Function('return process')();`, `[].constructor.constructor('return globalThis.process')();`]) {
      const r = await test(code);
      expect(r.error, code).toBeTruthy();
      expect(r.access_token_claims).toEqual({});
    }
  });

  it('turns a thrown error, a syntax error, a runaway loop and a promise that never settles into errors', async () => {
    const { test } = setup();
    expect((await test(`throw new Error('boom');`)).error).toBe('boom');
    expect((await test(`const = ;`)).error).toMatch(/Unexpected|token/i);
    expect((await test(`while (true) {}`)).error).toMatch(/timed out/i);
    expect((await test(`await Promise.resolve(); while (true) {}`)).error).toMatch(/timed out/i);
    expect((await test(`await new Promise(() => {});`)).error).toBe('Action timed out.');
    expect((await test(`compute();`)).error).toMatch(/compute/);
  });

  it('does not run code written as a handler module, and says so; an http Action is not called', async () => {
    const { call, action } = setup();
    const module = await action(`exports.onExecutePostLogin = async (event, api) => { api.access.deny('no'); };`);
    expect((await call('POST', `/v1/actions/${module.id}/test`, {})).json.error).toMatch(/runtime form/);
    const http = await action('', { runtime: 'http' });
    expect((await call('POST', `/v1/actions/${http.id}/test`, {})).json.error).toMatch(/http Action/);
    expect((await call('POST', '/v1/actions/act_missing/test', {})).status).toBe(404);
  });
});

// ── triggers: fail-closed and fail-open, merge order, run log ──
describe('bound Actions on a trigger', () => {
  it('fails closed on a gate trigger: a deny, an error and a timeout refuse with ACTION_BLOCKED and stop the rest', async () => {
    const { e, action, bind, call } = setup();
    const claim = await action(`api.accessToken.setCustomClaim('a', 1);`);
    const deny = await action(`if (event.context.tokenType === 'machine') { api.access.deny('closed'); }`);
    const later = await action(`api.accessToken.setCustomClaim('later', 1);`);
    await bind([claim.id, deny.id, later.id]);
    expect(() => runActionTrigger(e, 'pre_token', { tokenType: 'user' }).claims).not.toThrow();
    expect(() => runActionTrigger(e, 'pre_token', { tokenType: 'machine' })).toThrow('closed');
    const runs = (await call('GET', '/__emulator/actions/runs')).json.data;
    expect(runs.map((r: any) => r.outcome)).toContain('denied');
    expect(runs.some((r: any) => r.action_id === later.id && r.ran_at && r.outcome === 'ok' && r.trigger === 'pre_token')).toBe(true); // the first, user-typed pass ran it
    await call('DELETE', '/__emulator/actions/runs');
    const loop = await action(`while (true) {}`);
    await bind([loop.id]);
    expect(() => runActionTrigger(e, 'pre_token')).toThrow(/blocked for safety/);
    expect((await call('GET', `/__emulator/actions/runs?action_id=${loop.id}`)).json.data[0]).toMatchObject({ outcome: 'error', error: expect.stringMatching(/timed out/i) });
  });

  it('fails open on a side-effect trigger: an error is logged and the next Action runs; a deny means nothing', async () => {
    const { e, action, bind } = setup();
    const crash = await action(`throw new Error('x');`, { trigger: 'post_user_update' });
    const deny = await action(`api.access.deny('ignored'); api.user.setAppMetadata('seen', true);`, { trigger: 'post_user_update' });
    const set = await action(`api.user.setAppMetadata('after', 1);`, { trigger: 'post_user_update' });
    await bind([crash.id, deny.id, set.id], 'post_user_update');
    expect(runActionTrigger(e, 'post_user_update').appMetadata).toEqual({ seen: true, after: 1 });
  });

  it('merges later-wins per key, drops reserved claims and keeps the size cap', async () => {
    const { e, action, bind } = setup();
    const one = await action(`api.accessToken.setCustomClaim('tier', 'a'); api.accessToken.setCustomClaim('sub', 'forged'); api.accessToken.setCustomClaim('org_x', 1); api.accessToken.setCustomClaim('big', 'y'.repeat(3000));`);
    const two = await action(`api.accessToken.setCustomClaim('tier', 'b'); api.accessToken.setCustomClaim('small', 1);`);
    await bind([one.id, two.id]);
    expect(runActionTrigger(e, 'pre_token').claims).toEqual({ tier: 'b', small: 1 });
  });

  it('keeps the declarative reader for handler-module code', async () => {
    const { e, action, bind } = setup();
    const a = await action(`api.accessToken.setCustomClaim('legacy', 1);\nexports.onExecutePreToken = () => {};`);
    await bind([a.id]);
    expect(runActionTrigger(e, 'pre_token').claims).toEqual({ legacy: 1 });
  });
});

// ── typed connection actions ──
const github = async (e: any) => {
  const call = client(e);
  const user = (await call('POST', '/v1/users', { email_address: `u-${Math.random().toString(36).slice(2)}@example.com` })).json;
  const conn = (await call('POST', '/v1/connections', { owner: { type: 'user', id: user.id }, kind: 'oauth', provider: 'github', name: 'gh', allowed_hosts: ['api.github.com'], allowed_methods: ['GET'] })).json;
  return { call, user, conn };
};
const stub = (call: any, body: Record<string, unknown>) => call('POST', '/__emulator/connections/provider_stubs', body);
const ISSUES = 'https://api.github.com/repos/octo/hello/issues';
const run = (call: any, id: string, name = 'list_issues', body: Record<string, unknown> = {}) => call('POST', `/v1/connections/${id}/actions/${name}`, { input: { owner: 'octo', repo: 'hello' }, ...body });

describe('the typed action catalog', () => {
  it('lists first-party actions with declared outputs, and generates TypeScript declarations', async () => {
    const { call } = setup();
    const list = (await call('GET', '/v1/connection_actions?provider=github')).json;
    expect(list.data.length).toBeGreaterThan(2);
    expect(list.data.find((a: any) => a.name === 'list_issues')).toMatchObject({ object: 'connection_action', provider: 'github', source: 'first_party', method: 'GET', mutating: false, output_schema: { type: 'array' } });
    const all = (await call('GET', '/v1/connection_actions')).json.data;
    expect(new Set(all.map((a: any) => a.provider)).size).toBeGreaterThan(10);
    const types = (await call('GET', '/v1/connection_actions/types?provider=github')).json;
    expect(types).toMatchObject({ object: 'connection_action_types', provider: 'github' });
    expect(types.source).toContain('export interface ConnectionActionCatalog');
    expect(types.source).toContain('list_issues');
    expect((await call('GET', '/v1/connection_actions/types?provider=Bad Name')).status).toBe(400);
    expect((await call('GET', '/v1/connection_actions/github/list_issues')).json.name).toBe('list_issues');
    expect((await call('GET', '/v1/connection_actions/github/nope')).status).toBe(404);
  });

  it('defines, replaces, lists and removes a custom action, validating the definition', async () => {
    const { call } = setup();
    const def = { description: 'Ping.', input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, request: { method: 'GET', base_url: 'https://api.example.com', path: '/things/{id}' }, output: { type: 'object', properties: { ok: { type: 'boolean' } } } };
    const put = await call('PUT', '/v1/connection_actions/acme/ping', def);
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ object: 'connection_action', source: 'custom', provider: 'acme', name: 'ping', method: 'GET' });
    expect((await call('GET', '/v1/connection_actions?provider=acme')).json.data).toHaveLength(1);
    // a custom definition replaces a first-party one of the same name
    expect((await call('PUT', '/v1/connection_actions/github/list_issues', { ...def, description: 'Mine.' })).json.source).toBe('custom');
    expect((await call('GET', '/v1/connection_actions/github/list_issues')).json.description).toBe('Mine.');
    for (const bad of [{ ...def, description: '' }, { ...def, request: { ...def.request, base_url: 'http://api.example.com' } }, { ...def, request: { ...def.request, path: '/things/{missing}' } }, { ...def, request: { ...def.request, path: '/a/../b' } }, { ...def, request: { ...def.request, headers: { authorization: 'x' } } }]) {
      expect((await call('PUT', '/v1/connection_actions/acme/bad', bad)).status, JSON.stringify(bad.request)).toBe(400);
    }
    expect((await call('PUT', '/v1/connection_actions/acme/Bad-Name', def)).status).toBe(400);
    expect((await call('DELETE', '/v1/connection_actions/acme/ping')).status).toBe(204);
    expect((await call('DELETE', '/v1/connection_actions/acme/ping')).status).toBe(404);
    const audit = (await call('GET', '/__emulator/connections/audit')).json.data.map((a: any) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['connection.action_defined', 'connection.action_removed']));
  });
});

describe('running an action', () => {
  it('validates input, supports a dry run, and runs through the relay with an output check', async () => {
    const e = makeEngine();
    const { call, conn } = await github(e);
    expect((await run(call, conn.id, 'list_issues', { input: { owner: 'octo' } })).status).toBe(400);
    expect((await run(call, conn.id, 'nope')).status).toBe(404);
    expect((await run(call, 'conn_missing')).status).toBe(404);
    expect((await run(call, conn.id, 'list_issues', { dry_run: 'yes' })).status).toBe(400);
    const dry = (await run(call, conn.id, 'list_issues', { dry_run: true })).json;
    expect(dry).toMatchObject({ object: 'connection_action_result', ok: true, status: null, attempts: 0, dry_run: { method: 'GET', url: ISSUES } });
    // no fetch and no stub: the relay says so
    expect((await run(call, conn.id)).status).toBeGreaterThanOrEqual(400);
    await stub(call, { url: ISSUES, body: [{ number: 1, title: 'a', state: 'open' }] });
    const ok = await run(call, conn.id);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-atlas-attempts')).toBe('1');
    expect(ok.json).toMatchObject({ ok: true, status: 200, data: [{ number: 1, title: 'a', state: 'open' }], output_valid: true, error: null, truncated: false });
    const activity = (await call('GET', `/v1/connections/${conn.id}/activity?kind=relay`)).json.data;
    expect(activity[0]).toMatchObject({ kind: 'relay', outcome: 'ok', host: 'api.github.com', status: 200 });
    const audit = (await call('GET', '/__emulator/connections/audit')).json.data.find((a: any) => a.action === 'connection.action_ran');
    expect(audit.metadata).toEqual({ action: 'list_issues', provider: 'github', ok: true, status: 200, dry_run: false });
  });

  it('reports a provider error, a 200 { ok: false } answer, and a revoked connection', async () => {
    const e = makeEngine();
    const { call, conn } = await github(e);
    await stub(call, { url: ISSUES, status: 404, body: { message: 'Not Found' } });
    expect((await run(call, conn.id)).json).toMatchObject({ ok: false, status: 404, error: 'The provider answered 404.', output_valid: null });
    await call('DELETE', '/__emulator/connections/provider_stubs');
    await stub(call, { url: 'https://slack.com/api/chat.postMessage', body: { ok: false, error: 'channel_not_found' } });
    const slack = (await call('POST', '/v1/connections', { owner: { type: 'external', id: 'ws1' }, kind: 'oauth', provider: 'slack_api', name: 's', allowed_hosts: ['slack.com'], allowed_methods: ['POST'] })).json;
    const posted = await call('POST', `/v1/connections/${slack.id}/actions/post_message`, { input: { channel: 'C1', text: 'hi' } });
    expect(posted.json).toMatchObject({ ok: false, error: 'channel_not_found' });
  });

  it('pages through cursor pagination when asked for all pages', async () => {
    const e = makeEngine();
    const { call } = await github(e);
    const hub = (await call('POST', '/v1/connections', { owner: { type: 'external', id: 'h' }, kind: 'oauth', provider: 'hubspot', name: 'h', allowed_hosts: ['api.hubapi.com'], allowed_methods: ['GET'] })).json;
    const url = 'https://api.hubapi.com/crm/v3/objects/contacts';
    await stub(call, { url, method: 'GET', times: 1, body: { results: [{ id: '1' }, { id: '2' }], paging: { next: { after: 'c2' } } } });
    await stub(call, { url, method: 'GET', times: 1, body: { results: [{ id: '3' }] } });
    const r = (await call('POST', `/v1/connections/${hub.id}/actions/list_contacts`, { input: {}, all_pages: true })).json;
    expect(r).toMatchObject({ ok: true, data: [{ id: '1' }, { id: '2' }, { id: '3' }] });
  });
});

describe('the provider change radar', () => {
  it('records output drift, deprecation and 410 once each, counts repeats, and announces the first sight', async () => {
    const e = makeEngine();
    const { call, conn } = await github(e);
    await call('POST', '/v1/webhook_endpoints', { url: 'https://hooks.example/atlas', enabled_events: ['connection.provider_change'] });
    await stub(call, { url: ISSUES, headers: { deprecation: 'true', sunset: 'Sat, 01 Jan 2028 00:00:00 GMT' }, body: [{ number: 'one', title: 'a' }] });
    const first = (await run(call, conn.id)).json;
    expect(first.output_valid).toBe(false);
    await run(call, conn.id);
    const list = (await call('GET', '/v1/connection_provider_changes')).json;
    expect(list.data.map((c: any) => c.kind).sort()).toEqual(['deprecation', 'output_drift']);
    const drift = list.data.find((c: any) => c.kind === 'output_drift');
    expect(drift).toMatchObject({ object: 'connection_provider_change', provider: 'github', action: 'list_issues', status: 'open', occurrences: 2 });
    expect(drift.detail.problem).toMatch(/output\[0\]\.number/);
    expect(JSON.stringify(drift)).not.toContain('"one"'); // path and rule only, never the value
    const sent = (e.webhooks as any).events.filter((x: any) => x.type === 'connection.provider_change');
    expect(sent).toHaveLength(2);
    await call('DELETE', '/__emulator/connections/provider_stubs');
    await stub(call, { url: ISSUES, status: 410, body: {} });
    await run(call, conn.id);
    expect((await call('GET', '/v1/connection_provider_changes?kind=endpoint_gone')).json.data).toHaveLength(1);
  });

  it('acknowledges, resolves, reopens on recurrence, filters and pages', async () => {
    const { call } = setup();
    const seed = (extra: Record<string, unknown> = {}) => call('POST', '/__emulator/connections/radar_observation', { provider: 'acme', action: 'ping', drift: 'output.ok must be a boolean.', ...extra });
    await seed();
    await seed({ action: 'pong', status: 410, drift: null });
    const all = (await call('GET', '/v1/connection_provider_changes?limit=1')).json;
    expect(all).toMatchObject({ has_more: true });
    expect((await call('GET', `/v1/connection_provider_changes?limit=1&starting_after=${all.next_cursor}`)).json.has_more).toBe(false);
    // The change that recurs below (410 on pong), whatever order the list returns.
    const id = (await call('GET', '/v1/connection_provider_changes')).json.data.find((c: { action: string }) => c.action === 'pong').id;
    expect((await call('POST', `/v1/connection_provider_changes/${id}/acknowledge`)).json).toMatchObject({ status: 'acknowledged', handled_by: 'emulator' });
    expect((await call('GET', '/v1/connection_provider_changes')).json.data).toHaveLength(1); // open only by default
    expect((await call('GET', '/v1/connection_provider_changes?status=acknowledged')).json.data).toHaveLength(1);
    expect((await call('POST', `/v1/connection_provider_changes/${id}/resolve`)).json.status).toBe('resolved');
    await seed({ action: 'pong', status: 410, drift: null });
    expect((await call('GET', `/v1/connection_provider_changes/${id}`)).json).toMatchObject({ status: 'open', occurrences: 2 });
    expect((await call('GET', '/v1/connection_provider_changes?status=weird')).status).toBe(400);
    expect((await call('GET', '/v1/connection_provider_changes?kind=weird')).status).toBe(400);
    expect((await call('GET', '/v1/connection_provider_changes?starting_after=cpc_nope')).status).toBe(400);
    expect((await call('GET', '/v1/connection_provider_changes/cpc_nope')).status).toBe(404);
    expect((await call('POST', '/v1/connection_provider_changes/cpc_nope/resolve')).status).toBe(404);
  });
});

describe('connection access rules', () => {
  it('is open until a rule exists, then limits actions and the relay to the named key and permission', async () => {
    const e = makeEngine({ secretKeys: [{ key: 'sk_test_emulator' }, { key: 'sk_test_other' }] });
    const { call, conn } = await github(e);
    const other = client(e, 'sk_test_other');
    await stub(call, { url: ISSUES, body: [] });
    expect((await call('GET', `/v1/connections/${conn.id}/access_rules`)).json).toMatchObject({ object: 'connection_access_rules', restricted: false, rules: [] });
    expect((await run(other, conn.id)).status).toBe(200);
    const put = await call('PUT', `/v1/connections/${conn.id}/access_rules`, { rules: [{ principal_type: 'api_key', principal_id: 'sk_test_emulator', permissions: ['run_actions'] }, { principal_type: 'user', principal_id: 'user_x', permissions: ['relay'] }] });
    expect(put.json).toMatchObject({ restricted: true, rules: [{ object: 'connection_access_rule', principal_type: 'api_key', permissions: ['run_actions'] }, { principal_type: 'user' }] });
    expect((await run(call, conn.id)).status).toBe(200);
    const refused = await run(other, conn.id);
    expect(refused.status).toBe(403);
    expect(refused.json.errors[0]).toMatchObject({ code: 'FORBIDDEN', meta: { reason: 'connection_access_denied', permission: 'run_actions', connection_id: conn.id } });
    // run_actions does not carry relay
    expect((await call('POST', `/v1/connections/${conn.id}/relay`, { method: 'GET', url: ISSUES })).status).toBe(403);
    await call('PUT', `/v1/connections/${conn.id}/access_rules`, { rules: [{ principal_type: 'api_key', principal_id: 'sk_test_emulator', permissions: ['relay'] }] });
    expect((await call('POST', `/v1/connections/${conn.id}/relay`, { method: 'GET', url: ISSUES })).status).toBe(200);
    expect((await run(call, conn.id)).status).toBe(403);
    expect((await call('DELETE', `/v1/connections/${conn.id}/access_rules`)).status).toBe(204);
    expect((await run(other, conn.id)).status).toBe(200);
    expect((await call('GET', '/__emulator/connections/audit')).json.data.map((a: any) => a.action)).toEqual(expect.arrayContaining(['connection.access_rules_set', 'connection.access_rules_cleared']));
  });

  it('validates the rules like the real route', async () => {
    const e = makeEngine();
    const { call, conn } = await github(e);
    const put = (rules: unknown) => call('PUT', `/v1/connections/${conn.id}/access_rules`, { rules });
    const ok = { principal_type: 'api_key', principal_id: 'k', permissions: ['relay'] };
    for (const bad of ['x', Array(101).fill(ok), [{ ...ok, principal_type: 'team' }], [{ ...ok, principal_id: '' }], [{ ...ok, permissions: [] }], [{ ...ok, permissions: ['admin'] }], [{ ...ok, extra: 1 }], [ok, ok]]) {
      expect((await put(bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    expect((await put([{ ...ok, permissions: ['relay', 'relay', 'sign'] }])).json.rules[0].permissions).toEqual(['relay', 'sign']);
    expect((await call('GET', '/v1/connections/conn_missing/access_rules')).status).toBe(404);
  });
});

describe('dynamic client registration', () => {
  const REG = 'https://registrar.example/register';
  const body = (extra: Record<string, unknown> = {}) => ({ provider: 'acme', registration_endpoint: REG, ...extra });

  it('registers a secret-based client at the provider, never returning or storing the secret', async () => {
    const e = makeEngine();
    const call = client(e);
    await stub(call, { url: REG, status: 201, body: { client_id: 'cid-1', client_secret: 'shh-secret', registration_access_token: 'rat', registration_client_uri: 'https://registrar.example/register/cid-1', client_secret_expires_at: 2_000_000_000 } });
    const res = await call('POST', '/v1/connections/oauth_clients/register', body({ scopes: ['read'], client_name: 'My app', initial_access_token: 'iat-1' }));
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ object: 'connection_oauth_client', provider: 'acme', owner: { type: 'instance' }, client_id: 'cid-1', has_secret: true, auth_method: 'client_secret', registered_via: 'dcr', registration_client_uri: 'https://registrar.example/register/cid-1', scopes: ['read'], secret_expires_at: 2_000_000_000_000 });
    expect(JSON.stringify(res.json)).not.toMatch(/shh-secret|iat-1|"rat"/);
    expect(JSON.stringify((await call('GET', '/__emulator/connections/audit')).json)).not.toMatch(/shh-secret|iat-1|"rat"/);
    expect((await call('POST', '/v1/connections/oauth_clients/register', body())).status).toBe(409);
    expect((await call('POST', '/v1/connections/oauth_clients/register', body({ environment: 'sandbox' }))).status).toBe(201); // another environment
  });

  it('registers a private_key_jwt client with a generated key and publishes the public half', async () => {
    const e = makeEngine();
    const call = client(e);
    await stub(call, { url: REG, status: 201, body: { client_id: 'cid-2' } });
    const res = await call('POST', '/v1/connections/oauth_clients/register', body({ token_endpoint_auth_method: 'private_key_jwt' }));
    expect(res.json).toMatchObject({ auth_method: 'private_key_jwt', key_alg: 'ES256', public_jwk: { kty: 'EC', crv: 'P-256', alg: 'ES256' } });
    expect(res.json.public_jwk.d).toBeUndefined();
    const jwks = await client(e, null)('GET', `/v1/connection_client_jwks/${e.instanceId}/${res.json.id}`);
    expect(jwks.status).toBe(200);
    expect(jwks.json.keys).toEqual([res.json.public_jwk]);
    expect((await client(e, null)('GET', `/v1/connection_client_jwks/${e.instanceId}/oac_missing`)).status).toBe(404);
    expect((await client(e, null)('GET', `/v1/connection_client_jwks/ins_other/${res.json.id}`)).status).toBe(404);
  });

  it('sends the registration metadata and the initial access token, and refuses bad answers and bad input', async () => {
    const seen: Array<{ url: string; auth: string | null; body: any }> = [];
    const e = makeEngine({
      fetch: (async (url: string, init: any) => {
        seen.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(init.body) });
        return Response.json(url.includes('nosecret') ? { client_id: 'x' } : url.includes('refuse') ? { error: 'invalid_redirect_uri', error_description: 'bad uri' } : { client_id: 'c', client_secret: 's' }, { status: url.includes('refuse') ? 400 : 201 });
      }) as unknown as typeof fetch,
    });
    const call = client(e);
    await call('POST', '/v1/connections/oauth_clients/register', body({ initial_access_token: 'iat', scopes: ['a', 'b'], token_endpoint_auth_method: 'client_secret_post' }));
    expect(seen[0]).toMatchObject({ url: REG, auth: 'Bearer iat', body: { client_name: 'Atlas (acme)', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], application_type: 'web', token_endpoint_auth_method: 'client_secret_post', scope: 'a b' } });
    expect(seen[0]!.body.redirect_uris[0]).toMatch(/\/v1\/oauth\/callback\/acme$/);
    const refused = await call('POST', '/v1/connections/oauth_clients/register', body({ provider: 'other', registration_endpoint: 'https://refuse.example/r' }));
    expect(refused.status).toBe(400);
    expect(refused.json.errors[0].message).toContain('bad uri');
    expect((await call('POST', '/v1/connections/oauth_clients/register', body({ provider: 'o2', registration_endpoint: 'https://nosecret.example/r' }))).status).toBe(400);
    for (const bad of [{ provider: 'Bad Provider' }, { registration_endpoint: 'http://registrar.example/r' }, { registration_endpoint: 'https://u:p@registrar.example/r' }, { registration_endpoint: undefined }, { token_endpoint_auth_method: 'none' }, { environment: 'staging' }, { owner: { type: 'team', id: 'x' } }, { owner: { type: 'organization', id: 'org_missing' } }, { client_name: '' }, { scopes: ['has space'] }, { initial_access_token: '' }]) {
      expect((await call('POST', '/v1/connections/oauth_clients/register', { ...body(), ...bad })).status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('provider stubs', () => {
  it('match by exact path or prefix and method, are used up after `times`, and validate', async () => {
    const e = makeEngine();
    const { call, conn } = await github(e);
    await stub(call, { url: 'https://api.github.com/repos/*', method: 'POST', body: {} });
    expect((await run(call, conn.id)).status).toBeGreaterThanOrEqual(400); // GET does not match a POST stub
    await stub(call, { url: 'https://api.github.com/repos/octo/*', times: 1, body: [] });
    expect((await run(call, conn.id)).status).toBe(200);
    expect((await run(call, conn.id)).status).toBeGreaterThanOrEqual(400); // used up
    const list = (await call('GET', '/__emulator/connections/provider_stubs')).json.data;
    expect(list.find((s: any) => s.times === undefined && s.hits === 1)).toBeTruthy();
    for (const bad of [{ url: 'http://x.example/' }, { url: ISSUES, status: 99 }, { url: ISSUES, times: 0 }, { url: ISSUES, headers: { a: 1 } }]) expect((await stub(call, bad)).status, JSON.stringify(bad)).toBe(400);
    await call('DELETE', '/__emulator/connections/provider_stubs');
    expect((await call('GET', '/__emulator/connections/provider_stubs')).json.data).toEqual([]);
  });
});

describe('connection OAuth clients (PUT/GET/DELETE)', () => {
  const put = (call: ReturnType<typeof client>, extra: Record<string, unknown> = {}) => call('PUT', '/v1/connections/oauth_clients', { provider: 'tiktok_shop', client_id: 'app-key', client_secret: 'app-secret', ...extra });

  it('requires the provider extra, refuses unknown keys and bad values, and never returns the secret', async () => {
    const call = client(makeEngine());
    const missing = await put(call);
    expect(missing.status).toBe(400);
    expect(JSON.stringify(missing.json)).toContain('host_params.service_id');
    expect((await put(call, { host_params: { service_id: '777', shop: 'x' } })).status).toBe(400);
    expect((await put(call, { host_params: { service_id: 'a/b' } })).status).toBe(400);
    const redirect = 'https://app.example.com/api/auth/oauth/tiktok_shop/callback';
    const ok = await put(call, { host_params: { service_id: '777' }, redirect_uri: redirect });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ object: 'connection_oauth_client', host_params: { service_id: '777' }, redirect_uri: redirect, callback_url: redirect, has_secret: true });
    expect(JSON.stringify(ok.json)).not.toContain('app-secret');
    // A second PUT replaces the same client and keeps the stored extra when host_params is left out.
    const again = await call('PUT', '/v1/connections/oauth_clients', { provider: 'tiktok_shop', client_id: 'app-key-2' });
    expect(again.json).toMatchObject({ id: ok.json.id, client_id: 'app-key-2', host_params: { service_id: '777' } });
    expect(((await call('GET', '/v1/connections/oauth_clients?provider=tiktok_shop')).json as any).data).toHaveLength(1);
    expect((await call('DELETE', `/v1/connections/oauth_clients/${ok.json.id}`)).status).toBe(204);
    expect(((await call('GET', '/v1/connections/oauth_clients')).json as any).data).toHaveLength(0);
  });
});

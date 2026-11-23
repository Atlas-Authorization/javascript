import { describe, expect, it } from 'vitest';
import { client, makeEngine } from './test-support';

const call = () => client(makeEngine());

describe('native apps', () => {
  it('registers, validates, extends and deletes a development app and restricts the publishable key', async () => {
    const c = call();
    const soon = Date.now() + 86_400_000;
    expect((await c('POST', '/v1/native_apps', { platform: 'development', callback_urls: ['exp://127.0.0.1:8081/--/cb'], allowed_users: ['ada@example.com'], expires_at: Date.now() + 100 * 86_400_000 })).status).toBe(400);
    expect((await c('POST', '/v1/native_apps', { platform: 'ios', bundle_id: 'com.example.app', team_id: 'ABCDE12345', callback_urls: ['exp://x/--/cb'] })).json.errors[0].code).toBe('DEV_SCHEME_ON_PRODUCTION');
    const dev = await c('POST', '/v1/native_apps', { platform: 'development', callback_urls: ['exp://127.0.0.1:8081/--/cb'], allowed_users: ['ada@example.com'], expires_at: soon });
    expect(dev.status).toBe(201);
    expect(dev.json).toMatchObject({ object: 'native_app', platform: 'development', allowed_users: ['ada@example.com'], expired: false });
    const patched = await c('PATCH', `/v1/native_apps/${dev.json.id}`, { expires_at: soon + 86_400_000, allowed_users: ['ada@example.com', 'bob@example.com'] });
    expect(patched.json.allowed_users).toHaveLength(2);
    expect((await c('PATCH', `/v1/native_apps/${dev.json.id}`, { platform: 'ios' })).status).toBe(400);
    const ios = (await c('POST', '/v1/native_apps', { platform: 'ios', bundle_id: 'com.example.app', team_id: 'ABCDE12345', callback_urls: ['exampleapp://oauth-callback'] })).json;
    expect((await c('POST', '/v1/native_apps', { platform: 'ios', bundle_id: 'com.example.app', team_id: 'ABCDE12345', callback_urls: ['exampleapp://oauth-callback'] })).status).toBe(409);
    expect((await c('GET', '/v1/native_apps')).json.data).toHaveLength(2);
    expect((await c('PUT', '/v1/native_apps/publishable_key', { app_ids: ['napp_missing'] })).json.errors[0].code).toBe('NATIVE_APP_NOT_REGISTERED');
    expect((await c('PUT', '/v1/native_apps/publishable_key', { app_ids: [ios.id] })).json.app_ids).toEqual([ios.id]);
    expect((await c('DELETE', `/v1/native_apps/${ios.id}`)).json).toMatchObject({ deleted: true });
    expect((await c('GET', '/v1/native_apps/publishable_key')).json.app_ids).toEqual([]);
    expect((await c('GET', `/v1/native_apps/${ios.id}`)).status).toBe(404);
  });
});

describe('hooks, forwarding and instance reads', () => {
  it('configures the before_first_session hook and reports it unconfigured to the test call', async () => {
    const c = call();
    expect((await c('PATCH', '/v1/instance/hooks/before_first_session', { enabled: true })).status).toBe(400);
    const on = await c('PATCH', '/v1/instance/hooks/before_first_session', { url: 'https://example.com/hook', signing_secret: 'x'.repeat(20), enabled: true });
    expect(on.json).toMatchObject({ enabled: true, signing_secret_set: true, timeout_ms: 3000 });
    expect(JSON.stringify(on.json)).not.toContain('xxxx');
    expect((await c('DELETE', '/v1/instance/hooks/before_first_session')).json).toMatchObject({ enabled: false, url: null, signing_secret_set: false });
    expect((await c('POST', '/v1/instance/hooks/before_first_session/test')).json).toMatchObject({ ok: false, error: { code: 'not_configured' } });
  });

  it('forwards sign-ups, lists health and answers the issuers', async () => {
    const c = call();
    expect((await c('PUT', '/v1/instance/integrations/forwarding/lucida', {})).status).toBe(400);
    expect((await c('GET', '/v1/instance/integrations/forwarding/lucida')).status).toBe(404);
    const put = await c('PUT', '/v1/instance/integrations/forwarding/lucida', { server_key: 'sk_lucida_1' });
    expect(put.json).toMatchObject({ forwarding: 'lucida', event: 'user.created', created: true });
    expect(JSON.stringify((await c('GET', '/v1/instance/integrations/forwarding/lucida')).json)).not.toContain('sk_lucida_1');
    const hook = await c('PUT', '/v1/instance/integrations/forwarding/webhook', { url: 'https://example.com/signups' });
    expect(hook.json.secret).toMatch(/\S+/);
    const health = (await c('GET', '/v1/instance/integrations/health')).json;
    expect(health.data.map((r: any) => r.destination)).toEqual(expect.arrayContaining(['https', 'lucida']));
    expect((await c('DELETE', '/v1/instance/integrations/forwarding/webhook')).status).toBe(204);
    const issuers = (await c('GET', '/v1/instance/issuers')).json;
    expect(issuers).toMatchObject({ planned: null, previous: [] });
    expect(issuers.jwks_uri).toBe(`${issuers.active}/.well-known/jwks.json`);
  });

  it('merges a cookie-consent patch over the stored setting', async () => {
    const c = call();
    expect((await c('PATCH', '/v1/instance/cookie_consent', { enabled: false })).status).toBe(400);
    await c('PATCH', '/v1/instance/cookie_consent', { script_url: 'https://cmp.example.com/a.js', site_id: 's1' });
    const next = (await c('PATCH', '/v1/instance/cookie_consent', { site_id: null, blocking_mode: 'auto' })).json;
    expect(next).toMatchObject({ script_url: 'https://cmp.example.com/a.js', blocking_mode: 'auto', warnings: [] });
    expect(next.site_id).toBeUndefined();
  });

  it('mints message links and reads the analytics windows', async () => {
    const c = call();
    expect((await c('POST', '/v1/message_links', { email: 'ada@example.com', type: 'unsubscribe' })).status).toBe(400);
    const link = (await c('POST', '/v1/message_links', { email: 'ada@example.com', type: 'unsubscribe', category: 'news' })).json;
    expect(link).toMatchObject({ object: 'message_link', type: 'unsubscribe' });
    expect(link.url).toContain('/m/unsubscribe?t=');
    expect((await c('GET', '/v1/analytics/captcha?days=7')).json).toMatchObject({ object: 'analytics_captcha', data: [] });
    expect((await c('GET', '/v1/analytics/sms?rate_per_message=2000')).status).toBe(400);
    expect((await c('GET', '/v1/analytics/sms?rate_per_message=0.01')).json).toMatchObject({ object: 'analytics_sms', total: 0 });
  });
});

describe('users', () => {
  it('upserts by external id, tracks risk signals, deleted users, deletion dates and the security summary', async () => {
    const c = call();
    expect((await c('PUT', '/v1/users/by_external_id/ext-1', {})).status).toBe(400);
    const made = await c('PUT', '/v1/users/by_external_id/ext-1', { email_address: 'ada@example.com', first_name: 'Ada' });
    expect(made.status).toBe(201);
    const again = await c('PUT', '/v1/users/by_external_id/ext-1', { first_name: 'Ada L', public_metadata: { plan: 'pro' } });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ id: made.json.id, first_name: 'Ada L' });
    const id = made.json.id;

    expect((await c('POST', `/v1/users/${id}/risk_signals`, { signal_type: 'Bad Type', severity: 'high' })).status).toBe(400);
    const sig = await c('POST', `/v1/users/${id}/risk_signals`, { signal_type: 'credential_stuffing', severity: 'high' });
    expect(sig.status).toBe(201);
    expect(sig.json).toMatchObject({ status: 'active', subject: { type: 'user', value: id } });
    expect((await c('GET', `/v1/users/${id}/risk_signals?status=active`)).json.data).toHaveLength(1);
    expect((await c('DELETE', `/v1/users/${id}/risk_signals`)).json).toMatchObject({ object: 'risk_signals_cleared', cleared: 1 });
    expect((await c('DELETE', `/v1/users/${id}/risk_signals`)).json.cleared).toBe(0);
    expect((await c('GET', `/v1/users/${id}/risk_signals?status=active`)).json.data).toHaveLength(0);

    expect((await c('GET', `/v1/users/${id}/security_summary`)).json).toMatchObject({ object: 'security_summary', user_id: id, mfa_enabled: false, has_passkey: false, active_sessions: { count: 0, latest: null } });

    expect((await c('GET', '/v1/users/deleted')).status).toBe(400);
    await c('DELETE', `/v1/users/${id}`);
    const gone = (await c('GET', '/v1/users/deleted?since=0')).json;
    expect(gone.data).toEqual([expect.objectContaining({ object: 'deleted_user', id, external_id: 'ext-1' })]);
    expect((await c('GET', `/v1/users/deleted?since=${Date.now() + 60_000}`)).json.data).toHaveLength(0);
  });

  it('moves a scheduled deletion and refuses when none is scheduled', async () => {
    const c = call();
    const id = (await c('POST', '/v1/users', { email_address: 'bob@example.com' })).json.id;
    expect((await c('PATCH', `/v1/users/${id}/deletion`, { grace_seconds: 3600 })).status).toBe(409);
    await c('POST', '/v1/data_subject_requests', { type: 'erasure', user_id: id });
    expect((await c('PATCH', `/v1/users/${id}/deletion`, { grace_seconds: 3600, effective_at: new Date(Date.now() + 1e7).toISOString() })).status).toBe(400);
    const moved = await c('PATCH', `/v1/users/${id}/deletion`, { grace_seconds: 3600 });
    expect(moved.status).toBe(200);
    expect(moved.json.deletion_effective_at).toBeGreaterThan(Date.now());
    expect(moved.json.deletion_effective_at).toBeLessThan(Date.now() + 3_700_000);
  });

  it('mints a delegation token only for a configured audience and scope', async () => {
    const eng = makeEngine();
    const c = client(eng);
    const id = (await c('POST', '/v1/users', { email_address: 'ada@example.com' })).json.id;
    const body = { audience: 'billing', scopes: ['invoices:read'], actor: { sub: 'support-bot', type: 'service' } };
    expect((await c('POST', `/v1/users/${id}/delegation_tokens`, body)).json.errors[0].code).toBe('FORBIDDEN');
    await c('PUT', '/__emulator/delegation_tokens', { audiences: [{ audience: 'billing', scopes: ['invoices:read'] }] }, {});
    expect((await c('POST', `/v1/users/${id}/delegation_tokens`, { ...body, scopes: ['invoices:write'] })).status).toBe(400);
    const ok = await c('POST', `/v1/users/${id}/delegation_tokens`, body);
    expect(ok.json).toMatchObject({ object: 'delegation_token', token_type: 'Bearer', audience: 'billing', expires_in: 120, actor: { sub: 'support-bot', type: 'service' } });
    const claims = JSON.parse(Buffer.from(ok.json.token.split('.')[1], 'base64url').toString());
    expect(claims).toMatchObject({ sub: id, aud: 'billing', scope: 'invoices:read', act: { sub: 'support-bot' } });
  });
});

describe('connections, migrations and grants', () => {
  it('lists provider policies and templates', async () => {
    const c = call();
    expect((await c('GET', '/v1/connection_providers/policies')).json.data).toEqual([]);
    await c('PUT', '/v1/connection_providers/shopify/policy', { unique_external_id: true, webhook_secret: 's3cret' });
    const list = (await c('GET', '/v1/connection_providers/policies')).json.data;
    expect(list).toEqual([expect.objectContaining({ provider: 'shopify', unique_external_id: true, has_webhook_secret: true })]);
    expect(JSON.stringify(list)).not.toContain('s3cret');
    expect((await c('GET', '/v1/connection_templates')).json.data.map((t: any) => t.provider)).toContain('discogs');
  });

  it('rehomes connections between owner clients', async () => {
    const c = call();
    expect((await c('POST', '/v1/connections/rehome', { from_client: 'oac_a' })).status).toBe(400);
    expect((await c('POST', '/v1/connections/rehome', { from_client: 'oac_a', to_client: 'oac_a' })).status).toBe(400);
    expect((await c('POST', '/v1/connections/rehome', { from_client: 'oac_a', to_client: 'oac_b', verify: false })).status).toBe(400);
    const dry = (await c('POST', '/v1/connections/rehome', { from_client: 'oac_a', to_client: 'oac_b', dry_run: true })).json;
    expect(dry).toMatchObject({ object: 'connection_rehome', dry_run: true, moved: 0, would_move: 0, data: [] });
  });

  it('imports legacy sessions with per-row errors', async () => {
    const c = call();
    const user = (await c('POST', '/v1/users', { email_address: 'ada@example.com', external_id: 'u-1' })).json;
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const res = (await c('POST', '/v1/migrations/legacy/sessions', { sessions: [{ token: 't1', user_id: user.id, expires_at: future }, { token: 't2', external_id: 'nobody', expires_at: future }, { token: 't3', user_id: user.id, expires_at: '2001-01-01T00:00:00Z' }, { token: 't4', user_id: user.id, expires_at: future, nope: 1 }] })).json;
    expect(res).toMatchObject({ object: 'migration_session_import', received: 4, imported: 1, failed: 3 });
    expect(res.errors.map((e: any) => e.code)).toEqual(['user_not_found', 'session_expired', 'unknown_field']);
    const dry = (await c('POST', '/v1/migrations/legacy/sessions', { dry_run: true, sessions: [{ token: 't9', user_id: user.id, expires_at: future }] })).json;
    expect(dry).toMatchObject({ dry_run: true, imported: 1 });
  });

  it('lists grants of both kinds and merges metadata', async () => {
    const c = call();
    expect((await c('GET', '/v1/grants')).json).toMatchObject({ object: 'list', data: [] });
    expect((await c('GET', '/v1/grants?type=bogus')).status).toBe(400);
    expect((await c('GET', '/v1/grants/consent_nobody_nothing')).status).toBe(404);
    expect((await c('PATCH', '/v1/grants/consent_nobody_nothing', { metadata: { a: 1 } })).status).toBe(404);
  });

  it('answers the dead-letter queue and OAuth consent switch', async () => {
    const c = call();
    expect((await c('GET', '/v1/webhook_dlq')).json).toMatchObject({ object: 'list', data: [], max_attempts: 1 });
    expect((await c('GET', '/v1/oauth_device_requests?device_challenge=NOPE')).status).toBe(404);
    expect((await c('PUT', '/v1/oauth_device_requests/reject?device_challenge=NOPE')).status).toBe(404);
    expect((await c('PUT', '/v1/oauth_consent_requests/switch_account?consent_challenge=nope')).status).toBe(404);
  });
});

describe('staging copies', () => {
  it('creates, refreshes with synthetic users, lists and deletes a copy', async () => {
    const c = call();
    const made = await c('POST', '/v1/instance/staging_copies', { mode: 'clone', name: 'staging-a', include: ['config', 'users'] });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ object: 'instance_clone', name: 'staging-a', status: 'completed' });
    expect(made.json.secret).toMatch(/^sk_test_/);
    expect((await c('POST', '/v1/instance/staging_copies', { mode: 'clone', name: 'staging-b', secret_key_preset: 'full' })).status).toBe(400);
    const id = made.json.id;
    const first = await c('POST', `/v1/instance/staging_copies/${id}/refresh`, { include: ['users'], synthetic_users: { count: 3, seed: 'qa' } });
    expect(first.json.counts.users).toBe(3);
    const second = await c('POST', `/v1/instance/staging_copies/${id}/refresh`, { include: ['users'], synthetic_users: { count: 3, seed: 'qa' } });
    expect(second.json.counts.users).toBe(3);
    expect((await c('POST', `/v1/instance/staging_copies/${id}/refresh`, { include: ['organizations'] })).status).toBe(400);
    expect((await c('GET', '/v1/instance/staging_copies')).json.data).toHaveLength(1);
    expect((await c('GET', `/v1/instance/staging_copies/${id}`)).json.id).toBe(id);
    expect((await c('DELETE', `/v1/instance/staging_copies/${id}`)).json.status).toBe('deleted');
  });
});

describe('proof-carrying authority', () => {
  const grant = (id: string) => ({ grant: { id, iss: 'pk_principal', sub: 'pk_agent' }, holder_pop: 'AAAA' });

  it('enrols principals, manages a grant authority, and gates widening on a spent step-up', async () => {
    const c = call();
    const user = (await c('POST', '/v1/users', { email_address: 'ada@example.com' })).json;
    expect((await c('POST', '/v1/pca/principals', { principal_pub: 'pk_principal', subject_type: 'user', subject_id: 'user_missing' })).status).toBe(400);
    expect((await c('POST', '/v1/pca/principals', { principal_pub: 'pk_principal', subject_type: 'user', subject_id: user.id })).status).toBe(201);
    expect((await c('GET', '/v1/pca/principals')).json.data).toHaveLength(1);

    expect((await c('POST', '/v1/pca/grants', grant('g1'))).json.tier).toBe('verified');
    await c('POST', '/v1/pca/grants', grant('g2'));
    const auth = { verbs: ['read'], resources: ['doc:*'], limits: { usd: 10 } };
    expect((await c('PUT', '/v1/pca/grants/g1/authority', { authority: auth, sig: 'AAAA' })).status).toBe(201);
    expect((await c('PUT', '/v1/pca/grants/g1/authority', { authority: auth, sig: 'AAAA' })).status).toBe(409);

    const narrow = await c('POST', '/v1/pca/grants/g1/amend', { action: 'narrow', authority: { verbs: ['read'], resources: ['doc:1'], limits: { usd: 5 } }, sig: 'AAAA', signed_by: 'holder' });
    expect(narrow.json).toMatchObject({ rev: 1, created: false });
    const wide = { action: 'replace', authority: { verbs: ['read', 'write'], resources: ['doc:*'], limits: { usd: 5 } }, sig: 'AAAA', signed_by: 'principal', new_grant_ref: 'g2' };
    expect((await c('POST', '/v1/pca/grants/g1/amend', { ...wide, action: 'narrow' })).status).toBe(400);
    expect((await c('POST', '/v1/pca/grants/g1/amend', wide)).status).toBe(403);
    const step = (await c('POST', '/v1/pca/grants/g1/step-up', {})).json;
    expect((await c('POST', '/v1/pca/grants/g1/amend', { ...wide, step_up_ref: step.step_up_ref })).status).toBe(403);
    await c('POST', `/v1/pca/grants/g1/step-up/${step.step_up_ref}/approve`, { sig: 'AAAA' });
    const widened = await c('POST', '/v1/pca/grants/g1/amend', { ...wide, step_up_ref: step.step_up_ref });
    expect(widened.json).toMatchObject({ grant_ref: 'g2', created: true, supersedes: 'g1' });
    expect((await c('POST', '/v1/pca/grants/g1/amend', { ...wide, step_up_ref: step.step_up_ref })).status).toBe(403); // spent

    expect((await c('GET', '/v1/pca/grants?status=active')).json.data.map((g: any) => g.grant_ref)).toContain('g2');
    expect((await c('DELETE', '/v1/pca/grants/g2')).json.revoked).toEqual(['g2']);
    expect((await c('DELETE', '/v1/pca/principals/pk_principal')).json.status).toBe('disabled');
  });

  it('files needs and approves them into a successor grant', async () => {
    const c = call();
    await c('POST', '/v1/pca/grants', grant('n1'));
    await c('POST', '/v1/pca/grants', grant('n2'));
    await c('PUT', '/v1/pca/grants/n1/authority', { authority: { verbs: ['read'], resources: ['a'] }, sig: 'AAAA' });
    const filed = await c('POST', '/v1/pca/grants/n1/needs', { needs: [{ verb: 'write', resource: 'a' }] });
    expect(filed.status).toBe(201);
    expect((await c('GET', '/v1/pca/grants/n1/needs?status=pending')).json.data).toHaveLength(1);
    const step = (await c('POST', '/v1/pca/grants/n1/step-up', {})).json;
    await c('POST', `/v1/pca/grants/n1/step-up/${step.step_up_ref}/approve`, { sig: 'AAAA' });
    expect((await c('POST', `/v1/pca/needs/${filed.json.id}/approve`, { approved: [{ verb: 'delete', resource: 'a' }], sig: 'AAAA', step_up_ref: step.step_up_ref, new_grant_ref: 'n2' })).status).toBe(400);
    const ok = await c('POST', `/v1/pca/needs/${filed.json.id}/approve`, { approved: [{ verb: 'write', resource: 'a' }], sig: 'AAAA', step_up_ref: step.step_up_ref, new_grant_ref: 'n2' });
    expect(ok.status).toBe(201);
    expect(ok.json.authority.verbs).toEqual(['read', 'write']);
    expect((await c('POST', `/v1/pca/needs/${filed.json.id}/deny`, {})).status).toBe(409);
  });

  it('rotates the guardian key, keeps pins, bonds and undo records', async () => {
    const c = call();
    const rotated = (await c('POST', '/v1/pca/guardian/rotate', {})).json;
    expect(rotated).toMatchObject({ epoch: 2, previous: { epoch: 1 } });
    expect((await c('GET', '/v1/pca/guardian/keys')).json.keys).toHaveLength(2);
    expect((await c('POST', '/v1/pca/bond-accounts', { account: 'pk_a', amount: 5 })).json.balance).toBe(5);
    expect((await c('POST', '/v1/pca/bond-accounts', { account: 'pk_a', amount: 2.5 })).json.balance).toBe(7.5);
    expect((await c('GET', '/v1/pca/bond-accounts?account=pk_a')).json).toMatchObject({ balance: 7.5 });
    expect((await c('POST', '/v1/pca/bond-accounts', { account: 'pk_a', amount: -1 })).status).toBe(400);

    await c('POST', '/v1/pca/grants', { grant: { id: 'u1', iss: 'p', sub: 'a' }, holder_pop: 'AAAA' });
    const record = { id: 'rec1', grant_ref: 'u1', principal: 'p', holder: 'a', audience: 'rs', window_end: Date.now() + 60_000, ver: 1, state: 'pending', receipts: [{ n: 1 }] };
    expect((await c('POST', '/v1/pca/undo/records', { record })).status).toBe(201);
    expect((await c('POST', '/v1/pca/undo/records', { record: { ...record, ver: 2 } })).status).toBe(409);
    expect((await c('POST', '/v1/pca/undo/rec1/veto', { token: 'tok' }, {})).status).toBe(202);
    expect((await c('GET', '/v1/pca/undo/vetoes')).json.data).toEqual([expect.objectContaining({ record_id: 'rec1' })]);
    expect((await c('PUT', '/v1/pca/undo/records/rec1', { record: { ...record, ver: 1 } })).status).toBe(409);
    const put = await c('PUT', '/v1/pca/undo/records/rec1', { record: { ...record, ver: 2, state: 'vetoed', receipts: [{ n: 1 }, { n: 2 }] } });
    expect(put.json.pending_veto).toBeNull();
    expect((await c('GET', '/v1/pca/undo/vetoes')).json.data).toEqual([]);
  });
});

describe('approvers and the action registry', () => {
  it('enrols an approver, changes quorum, members and credentials, and the settings', async () => {
    const eng = makeEngine();
    const c = client(eng);
    const user = (await c('POST', '/v1/users', { email_address: 'ada@example.com' })).json;
    const enrol = (await c('POST', '/v1/pca/approvers/enrolments', { subject_type: 'user', subject_id: user.id, email: 'ada@example.com' })).json;
    expect(enrol.enrolment_url).toContain('/pca/approvals/enrol');
    const approver = (await c('POST', `/__emulator/pca/approver_enrolments/${enrol.id}/complete`, {})).json;
    expect(approver).toMatchObject({ object: 'pca_approver', quorum: 1, status: 'active' });
    expect((await c('PATCH', `/v1/pca/approvers/${approver.id}`, { quorum: 2 })).status).toBe(400);
    const member = approver.members[0];
    expect((await c('PATCH', `/v1/pca/approvers/${approver.id}/members/${member.id}`, { channels: ['sms'] })).json.members[0].channels).toEqual(['sms']);
    expect((await c('PATCH', `/v1/pca/approvers/${approver.id}/members/${member.id}`, { channels: ['pager'] })).status).toBe(400);
    const gone = (await c('DELETE', `/v1/pca/approvers/${approver.id}/credentials/${approver.credentials[0].id}`)).json;
    expect(gone.credentials[0].status).toBe('revoked');
    expect((await c('GET', '/v1/pca/approvers')).json.data).toHaveLength(1);
    expect((await c('PATCH', `/v1/pca/approvers/${approver.id}`, { status: 'disabled' })).json.status).toBe('disabled');

    expect((await c('GET', '/v1/pca/approvals/settings')).json).toMatchObject({ object: 'pca_approval_settings', slack_webhook_set: false });
    expect((await c('PUT', '/v1/pca/approvals/settings', { channels: { slack: true } })).status).toBe(400);
    const set = (await c('PUT', '/v1/pca/approvals/settings', { channels: { slack: true }, slack_webhook_url: 'https://hooks.slack.com/services/T/B/X' })).json;
    expect(set).toMatchObject({ slack_webhook_set: true, channels: { slack: true } });
    expect(JSON.stringify(set)).not.toContain('hooks.slack.com');
  });

  it('imports, reviews, confirms and publishes actions, then diffs and pins versions', async () => {
    const c = call();
    const doc = JSON.stringify({ paths: { '/orders': { get: { operationId: 'listOrders', summary: 'List orders' }, post: { operationId: 'createOrder', summary: 'Create an order' } } } });
    expect((await c('POST', '/v1/pca/action-registry/imports', { ns: 'Bad', from: 'openapi', source: doc })).status).toBe(400);
    const imp = (await c('POST', '/v1/pca/action-registry/imports', { ns: 'shop', from: 'openapi', source: doc })).json;
    expect(imp).toMatchObject({ imported: 2, verbs: ['shop.listorders', 'shop.createorder'] });
    const drafts = (await c('GET', '/v1/pca/action-registry/drafts?ns=shop')).json.data;
    expect(drafts.every((d: any) => d.state === 'unreviewed')).toBe(true);

    const patched = await c('PATCH', '/v1/pca/action-registry/drafts/shop.createorder', { effects: ['write', 'money'] });
    expect(patched.json.state).toBe('authored');
    expect((await c('PATCH', '/v1/pca/action-registry/drafts/shop.createorder', { color: 'red' })).status).toBe(400);

    // confirm needs an active reviewer with a passkey
    const enrol = (await c('POST', '/v1/pca/action-registry/reviewers/enrolments', { display_name: 'Rae' })).json;
    expect(enrol.object).toBe('pca_action_reviewer_enrolment');
    const rv = (await c('POST', `/__emulator/pca/reviewers/${enrol.reviewer_id}/activate`, {})).json;
    expect(rv).toMatchObject({ status: 'active', kid: `rv_${enrol.reviewer_id}` });
    const confirm = (draft: any) => c('POST', `/v1/pca/action-registry/drafts/${draft.verb}/confirm`, { attestation: { def_digest: draft.def_digest, traits_digest: 'a', facts_digest: 'b', final_traits: ['money'], dismissed: [], reviewer_kid: rv.kid, ts: Math.floor(Date.now() / 1000), sig: 'AAAA' }, assertion: { credential_id: rv.credentials[0].id, authenticatorData: 'AA', clientDataJSON: 'AA', signature: 'AA' } });
    expect((await confirm({ ...patched.json, def_digest: 'stale' })).status).toBe(409);
    expect((await confirm(patched.json)).json.state).toBe('confirmed');

    const pub = (await c('POST', '/v1/pca/action-registry/publish', { ns: 'shop' })).json;
    expect(pub).toMatchObject({ object: 'pca_action_version', ns: 'shop', version: '1.0.0', published_drafts: 2 });
    expect((await c('GET', '/v1/pca/action-registry/drafts')).json.data).toEqual([]);
    expect((await c('GET', '/v1/pca/action-registry')).json).toMatchObject({ registry_mode: true });
    const actions = (await c('GET', '/v1/pca/action-registry/actions?ns=shop')).json.data;
    expect(actions.find((a: any) => a.verb === 'shop.createorder').state).toBe('confirmed');
    expect(actions.find((a: any) => a.verb === 'shop.listorders').state).toBe('unconfirmed');
    expect((await c('GET', '/v1/pca/action-registry/actions?state=confirmed')).json.data).toHaveLength(1);
    expect((await c('GET', '/v1/pca/action-registry/actions/shop.listorders')).json).toMatchObject({ object: 'pca_action', state: 'unconfirmed' });
    expect((await c('POST', '/v1/pca/action-registry/actions/shop.listorders/review', {})).json.verb).toBe('shop.listorders');
    expect((await c('POST', '/v1/pca/action-registry/actions/shop.listorders/review', {})).status).toBe(409);

    // widening an unconfirmed action is refused until a reviewer is named
    await c('PATCH', '/v1/pca/action-registry/drafts/shop.listorders', { effects: ['read', 'write'] });
    const refused = await c('POST', '/v1/pca/action-registry/publish', { ns: 'shop' });
    expect(refused.status).toBe(409);
    expect(refused.json.errors[0].meta.reason_code).toBe('widen_unreviewed');

    const versions = (await c('GET', '/v1/pca/action-registry/namespaces/shop/versions')).json.data;
    expect(versions.map((v: any) => v.version)).toEqual(['1.0.0']);
    expect((await c('GET', '/v1/pca/action-registry/namespaces/shop/versions/1.0.0')).json.pack.actions).toHaveLength(2);
    expect((await c('GET', '/v1/pca/action-registry/namespaces/shop/diff?from=1.0.0&to=1.0.0')).json).toMatchObject({ ok: true, changes: [] });
    expect((await c('PUT', '/v1/pca/action-registry/namespaces/shop/pin', { version: '1.0.0' })).json).toMatchObject({ pinned: true, active_version: '1.0.0' });
    expect((await c('DELETE', '/v1/pca/action-registry/namespaces/shop/pin')).json.pinned).toBe(false);
    expect((await c('DELETE', '/v1/pca/action-registry/drafts/shop.listorders')).json.deleted).toBe(true);
    expect((await c('DELETE', '/v1/pca/action-registry/reviewers/' + rv.id)).json.status).toBe('disabled');
  });

  it('pins publisher keys, tracks and syncs a source, and applies a template', async () => {
    const eng = makeEngine({ fetch: (async () => new Response(JSON.stringify({ paths: { '/a': { get: { operationId: 'a' } } } }), { status: 200 })) as typeof fetch });
    const c = client(eng);
    expect((await c('POST', '/v1/pca/action-registry/publisher-keys', { kid: 'rv_x', pk: 'AAAA' })).status).toBe(400);
    expect((await c('POST', '/v1/pca/action-registry/publisher-keys', { kid: 'pub1', pk: 'AAAA' })).status).toBe(201);
    expect((await c('POST', '/v1/pca/action-registry/publisher-keys', { kid: 'pub2', pk: 'AAAA' })).status).toBe(409);
    expect((await c('DELETE', '/v1/pca/action-registry/publisher-keys/pub1')).status).toBe(204);

    const src = (await c('POST', '/v1/pca/action-registry/sources', { ns: 'svc', from: 'openapi', url: 'https://example.com/openapi.json', schedule: 'daily' })).json;
    expect(src).toMatchObject({ object: 'pca_action_source', schedule: 'daily', last_synced_at: null });
    const sync = (await c('POST', `/v1/pca/action-registry/sources/${src.id}/sync`, {})).json;
    expect(sync).toMatchObject({ needs_review: true, drafted: ['svc.a'], entries: [{ verb: 'svc.a', change: 'added' }] });
    expect((await c('POST', `/v1/pca/action-registry/sources/${src.id}/sync`, {})).json).toMatchObject({ needs_review: false, entries: [{ change: 'unchanged' }] });
    expect((await c('PATCH', `/v1/pca/action-registry/sources/${src.id}`, { schedule: 'weekly' })).status).toBe(400);
    expect((await c('PATCH', `/v1/pca/action-registry/sources/${src.id}`, { schedule: 'off' })).json.schedule).toBe('off');
    expect((await c('GET', '/v1/pca/action-registry/sources')).json.data).toHaveLength(1);
    expect((await c('DELETE', `/v1/pca/action-registry/sources/${src.id}`)).json.deleted).toBe(true);

    expect((await c('GET', '/v1/pca/action-registry/templates')).json.data.length).toBeGreaterThan(3);
    const applied = await c('POST', '/v1/pca/action-registry/templates/ecommerce/apply', { ns: 'store' });
    expect(applied.status).toBe(201);
    expect(applied.json.data.map((d: any) => d.verb)).toEqual(['store.refund_order', 'store.get_order']);
    expect(applied.json.data.every((d: any) => d.state === 'unreviewed')).toBe(true);
  });
});

describe('shared signals', () => {
  it('manages a poll stream, queues a verification event and acknowledges it', async () => {
    const c = call();
    const meta = (await c('GET', '/v1/ssf/metadata')).json;
    expect(meta.configuration_endpoint).toMatch(/\/v1\/ssf\/configuration$/);
    expect((await c('POST', '/v1/ssf/configuration', { delivery: { method: 'https://schemas.openid.net/secevent/risc/delivery-method/push' } })).status).toBe(400);
    const made = await c('POST', '/v1/ssf/configuration', { description: 'main' });
    expect(made.status).toBe(201);
    const id = made.json.stream_id;
    expect(made.json.delivery.endpoint_url).toContain(`/v1/ssf/streams/${id}/poll`);
    expect((await c('POST', '/v1/ssf/configuration', {})).status).toBe(409);
    expect((await c('GET', `/v1/ssf/configuration?stream_id=${id}`)).json.stream_id).toBe(id);
    expect((await c('GET', '/v1/ssf/configuration')).json).toHaveLength(1);
    expect((await c('GET', '/v1/ssf/configuration?stream_id=nope')).status).toBe(404);
    expect((await c('PATCH', '/v1/ssf/configuration', { stream_id: id, description: 'changed' })).json.description).toBe('changed');
    expect((await c('PUT', '/v1/ssf/configuration', { stream_id: id })).json.description).toBeUndefined(); // replace drops the member
    expect((await c('POST', '/v1/ssf/add_subject', { stream_id: id, subject: { format: 'email', email: 'ada@example.com' } })).status).toBe(200);
    expect((await c('POST', '/v1/ssf/remove_subject', { stream_id: id, subject: { format: 'email', email: 'nobody@example.com' } })).status).toBe(204);
    expect((await c('POST', '/v1/ssf/verification', { stream_id: id, state: 's1' })).status).toBe(204);
    const polled = (await c('POST', `/v1/ssf/streams/${id}/poll`, {})).json;
    const jtis = Object.keys(polled.sets);
    expect(jtis).toHaveLength(1);
    expect(polled.moreAvailable).toBe(false);
    expect(Object.keys((await c('POST', `/v1/ssf/streams/${id}/poll`, { ack: jtis })).json.sets)).toHaveLength(0);
    expect((await c('DELETE', `/v1/ssf/configuration?stream_id=${id}`)).status).toBe(204);
    expect((await c('GET', `/v1/ssf/configuration?stream_id=${id}`)).status).toBe(404);
  });
});

describe('organization depth (wave 2)', () => {
  const setup = async () => {
    const c = call();
    const ada = (await c('POST', '/v1/users', { email_address: 'ada@example.com' })).json;
    const bob = (await c('POST', '/v1/users', { email_address: 'bob@example.com' })).json;
    const org = (await c('POST', '/v1/organizations', { name: 'Acme', created_by: ada.id })).json;
    return { c, ada, bob, org };
  };

  it('runs an MFA campaign: create, validate, override a user, end', async () => {
    const { c, ada, org } = await setup();
    expect((await c('POST', '/v1/mfa_campaigns', { name: 'Roll out', target_type: 'org' })).status).toBe(400);
    expect((await c('POST', '/v1/mfa_campaigns', { name: 'Roll out', required_factors: ['fax'] })).status).toBe(400);
    const made = await c('POST', '/v1/mfa_campaigns', { name: 'Roll out', target_type: 'org', target_value: org.id, enforce: true, grace_until: Date.now() + 3 * 86_400_000 });
    expect(made.status).toBe(201);
    expect(made.json.metrics).toMatchObject({ targeted: 1, enrolled: 0, exempt: 0 });
    const id = made.json.id;
    expect((await c('GET', `/v1/mfa_campaigns/${id}/users/${ada.id}`)).json).toMatchObject({ targeted: true, effective: { phase: 'nag', satisfied: false } });
    expect((await c('PUT', `/v1/mfa_campaigns/${id}/users/${ada.id}`, { exempt_until: 1 })).status).toBe(400);
    const put = await c('PUT', `/v1/mfa_campaigns/${id}/users/${ada.id}`, { required_factors: ['totp'], exempt_until: Date.now() + 1e7 });
    expect(put.json.effective).toMatchObject({ phase: 'exempt', required_factors: ['totp'] });
    expect((await c('GET', `/v1/mfa_campaigns/${id}/users`)).json.data).toHaveLength(1);
    expect((await c('PATCH', `/v1/mfa_campaigns/${id}`, { grace_until: null, enforce: false })).json).toMatchObject({ grace_until: null, enforce: false });
    expect((await c('DELETE', `/v1/mfa_campaigns/${id}`)).json).toMatchObject({ status: 'ended' });
    expect((await c('PATCH', `/v1/mfa_campaigns/${id}`, { name: 'again' })).status).toBe(409);
    expect((await c('GET', '/v1/mfa_campaigns')).json.data).toHaveLength(1);
  });

  it('manages role sets, role policy, seats and templates', async () => {
    const { c, ada, bob, org } = await setup();
    await c('POST', '/v1/roles', { key: 'org:billing', name: 'Billing', permissions: [] });
    expect((await c('POST', '/v1/org_role_sets', { key: 'std', name: 'Standard', role_keys: ['org:ghost'] })).status).toBe(400);
    const set = (await c('POST', '/v1/org_role_sets', { key: 'std', name: 'Standard', role_keys: ['org:billing'], default_role_key: 'org:billing' })).json;
    expect((await c('POST', '/v1/org_role_sets', { key: 'std', name: 'Again' })).status).toBe(409);
    expect((await c('GET', '/v1/org_role_sets/std')).json.id).toBe(set.id);
    expect((await c('PATCH', `/v1/org_role_sets/${set.id}`, { default_role_key: 'org:nope' })).status).toBe(400);

    expect((await c('GET', `/v1/organizations/${org.id}/role_policy`)).json).toMatchObject({ role_set: null, allowed_roles: null, default_role: 'org:member', default_role_source: 'system' });
    const pol = (await c('PUT', `/v1/organizations/${org.id}/role_policy`, { role_set: 'std' })).json;
    expect(pol).toMatchObject({ role_set: { key: 'std' }, default_role: 'org:billing', default_role_source: 'role_set' });
    expect(pol.allowed_roles).toEqual(['org:admin', 'org:billing']);
    expect((await c('DELETE', `/v1/org_role_sets/${set.id}`)).status).toBe(409);
    await c('PUT', `/v1/organizations/${org.id}/role_policy`, { role_set: null });
    expect((await c('DELETE', `/v1/org_role_sets/${set.id}`)).json.deleted).toBe(true);

    expect((await c('GET', `/v1/organizations/${org.id}/seats`)).json).toMatchObject({ limit: null, used: 1, available: null, state: 'ok' });
    await c('POST', `/v1/organizations/${org.id}/invitations`, { email: 'x@example.com' });
    expect((await c('PUT', `/v1/organizations/${org.id}/seats`, { limit: 2, warn_percent: 50 })).json).toMatchObject({ limit: 2, used: 1, pending_invitations: 1, available: 0, state: 'low' });
    expect((await c('PUT', `/v1/organizations/${org.id}/seats`, { limit: 1 })).json.state).toBe('full');
    expect((await c('PUT', `/v1/organizations/${org.id}/seats`, { warn_percent: 0 })).status).toBe(400);

    const imp = await c('POST', `/v1/organizations/${org.id}/membership_imports`, { memberships: [{ email: 'bob@example.com' }, { email: 'nobody@example.com' }] });
    expect(imp.status).toBe(202);
    expect(imp.json).toMatchObject({ object: 'job', total: 2, failed: 2 }); // the org is full
    await c('PUT', `/v1/organizations/${org.id}/seats`, { limit: null });
    const imp2 = (await c('POST', `/v1/organizations/${org.id}/membership_imports`, { csv: 'email,role\nbob@example.com,org:member\nnobody@example.com,org:member', invite_missing: true })).json;
    expect(imp2.results).toMatchObject({ added: 1, invited: 1 });
    expect(bob.id).toBeTruthy();
    expect(ada.id).toBeTruthy();

    const tpl = await c('POST', '/v1/org_templates', { key: 'team', name: 'Team', roles: [{ key: 'org:auditor', name: 'Auditor', permissions: [] }], max_allowed_memberships: 5, seat_warn_percent: 80 });
    expect(tpl.status).toBe(201);
    expect((await c('POST', '/v1/org_templates', { key: 'team', name: 'x' })).status).toBe(409);
    const made = await c('POST', `/v1/org_templates/${tpl.json.id}/organizations`, { name: 'From template', public_metadata: { plan: 'team' } });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ name: 'From template', max_allowed_memberships: 5 });
    expect((await c('GET', '/v1/roles')).json.data.map((r: any) => r.key)).toContain('org:auditor');
    expect((await c('PATCH', `/v1/org_templates/team`, { name: 'Team 2' })).json.name).toBe('Team 2');
    expect((await c('DELETE', `/v1/org_templates/${tpl.json.id}`)).json.deleted).toBe(true);
  });

  it('imports invitations that keep their token hash', async () => {
    const { c, org } = await setup();
    const row = { email: 'carol@example.com', role: 'org:member', token_sha256: 'a'.repeat(64) };
    expect((await c('POST', `/v1/organizations/${org.id}/invitations/import`, { invitations: [{ ...row, token_sha256: 'short' }] })).json).toMatchObject({ invalid: 1 });
    expect((await c('POST', `/v1/organizations/${org.id}/invitations/import`, { dry_run: true, invitations: [row] })).json.data[0].status).toBe('would_create');
    expect((await c('POST', `/v1/organizations/${org.id}/invitations/import`, { invitations: [row] })).json).toMatchObject({ created: 1 });
    expect((await c('POST', `/v1/organizations/${org.id}/invitations/import`, { invitations: [row] })).json).toMatchObject({ created: 0, unchanged: 1 });
    expect((await c('POST', `/v1/organizations/${org.id}/invitations/import`, { invitations: [{ ...row, token_sha256: 'b'.repeat(64) }] })).json.data[0].code).toBe('invitation_exists');
  });

  it('reports IT health, the SCIM request log, sync runs and SSO tests', async () => {
    const { c, org } = await setup();
    expect((await c('GET', `/v1/organizations/${org.id}/it_health`)).json).toMatchObject({ status: 'not_configured', issues: [] });
    const sso = (await c('POST', '/v1/sso_connections', { organization_id: org.id, type: 'saml', status: 'active', saml_idp_entity_id: 'idp', saml_idp_sso_url: 'http://insecure.example.com/sso' })).json;
    const test = (await c('POST', `/v1/sso_connections/${sso.id}/test`, {})).json;
    expect(test).toMatchObject({ object: 'sso_connection_test', ok: false });
    expect(test.message).toMatch(/https|saml_idp_certificate/);
    expect((await c('POST', `/v1/sso_connections/${sso.id}/test_login`, {})).status).toBe(400);
    await c('POST', `/__emulator/sso_connections/${sso.id}/logins`, { outcome: 'failure', failure_code: 'bad_signature' }, {});
    const hist = (await c('GET', `/v1/sso_connections/${sso.id}/login_history?outcome=failure`)).json;
    expect(hist.data).toHaveLength(1);
    expect(hist.summary).toMatchObject({ failures_24h: 1, successes_24h: 0 });
    expect((await c('GET', `/v1/organizations/${org.id}/it_health`)).json).toMatchObject({ status: 'critical', issues: [expect.objectContaining({ code: 'sso_failing' })] });

    const tok = (await c('POST', '/v1/scim_tokens', { organization_id: org.id })).json;
    const scim = (path: string, token: string) => fetchLike(c, path, token);
    await scim('/scim/v2/Users', tok.token);
    await scim('/scim/v2/Users', 'scim_wrong');
    const log = (await c('GET', `/v1/organizations/${org.id}/scim/requests?status=ok`)).json.data;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ method: 'GET', resource: 'Users', status: 200, token_id: tok.id });
    const rotated = (await c('POST', `/v1/scim_tokens/${tok.id}/rotate`, {})).json;
    expect(rotated.token).not.toBe(tok.token);
    expect((await scim('/scim/v2/Users', tok.token)).status).toBe(401);

    const run = (await c('POST', `/__emulator/organizations/${org.id}/directory_sync_runs`, { status: 'failed' }, {})).json;
    expect((await c('GET', `/v1/organizations/${org.id}/directory_sync_runs?status=failed`)).json.data).toHaveLength(1);
    const retry = await c('POST', `/v1/organizations/${org.id}/directory_sync_runs/${run.id}/retry`, {});
    expect(retry.status).toBe(202);
    expect(retry.json).toMatchObject({ status: 'queued', retry_of: run.id });
    expect((await c('POST', `/v1/organizations/${org.id}/directory_sync_runs/${run.id}/retry`, {})).status).toBe(409);
  });

  it('serves organization webhook endpoint secrets, tests, redelivers and replays', async () => {
    const calls: string[] = [];
    const eng = makeEngine({ fetch: (async (u: string, init: any) => (calls.push(`${u}|${init.headers['webhook-id']}`), new Response('ok', { status: 200 }))) as unknown as typeof fetch });
    const c = client(eng);
    const org = (await c('POST', '/v1/organizations', { name: 'Acme' })).json;
    const ep = (await c('POST', `/v1/organizations/${org.id}/webhook_endpoints`, { url: 'https://example.com/hook' })).json;
    const base = `/v1/organizations/${org.id}/webhook_endpoints/${ep.id}`;
    const secret = (await c('POST', `${base}/reveal_secret`, {})).json;
    expect(secret.secret).toMatch(/^whsec_/);
    expect((await c('POST', `${base}/reveal_secret`, {})).json.secret).toBe(secret.secret);
    expect((await c('POST', `${base}/test`, {})).status).toBe(200); // the document lists only 200 for this operation, so the engine reports that for the queued case too
    const waited = (await c('POST', `${base}/test?wait=10s`, {})).json;
    expect(waited).toMatchObject({ object: 'webhook_test_result', ok: true, status: 'success', http_status: 200 });
    const redo = await c('POST', `${base}/deliveries/${waited.delivery_id}/redeliver`, {});
    expect(redo.status).toBe(201);
    expect(redo.json.event_id).toBe(waited.event_id);
    expect(calls.filter((x) => x.endsWith(waited.event_id))).toHaveLength(2);
    expect((await c('POST', `${base}/deliveries/nope/redeliver`, {})).status).toBe(404);
    expect((await c('POST', `${base}/replay`, {})).status).toBe(400);
    await c('POST', `/v1/organizations/${org.id}/invitations`, { email: 'x@example.com' });
    const replay = await c('POST', `${base}/replay?since=0`, {});
    expect(replay.status).toBe(202);
    expect(replay.json.queued).toBeGreaterThan(0);
    expect((await c('POST', `${base}/replay?since=0`, {})).json.queued).toBe(0); // running it again queues nothing new
  });
});

const fetchLike = async (c: ReturnType<typeof call>, path: string, token: string) => c('GET', path, undefined, { authorization: `Bearer ${token}` });

describe('signals, schema and the small reads (wave 2)', () => {
  it('reports, lists, ends and replays risk signals', async () => {
    const c = call();
    const user = (await c('POST', '/v1/users', { email_address: 'ada@example.com' })).json;
    expect((await c('POST', '/v1/risk_signals', { signal_type: 'x', severity: 'high' })).status).toBe(400);
    expect((await c('POST', '/v1/risk_signals', { ip: '203.0.113.9', user_id: user.id, signal_type: 'x', severity: 'high' })).status).toBe(400);
    const byIp = (await c('POST', '/v1/risk_signals', { ip: '203.0.113.9', signal_type: 'scanner', severity: 'low' })).json;
    expect(byIp.subject).toEqual({ type: 'ip', value: '203.0.113.9' });
    const byEmail = (await c('POST', '/v1/risk_signals', { email: 'ada@example.com', signal_type: 'stuffing', severity: 'high' })).json;
    expect(byEmail.subject).toEqual({ type: 'user', value: user.id });
    expect((await c('GET', `/v1/risk_signals?user_id=${user.id}`)).json.data).toHaveLength(1);
    expect((await c('GET', `/v1/risk_signals/${byIp.id}`)).json.id).toBe(byIp.id);
    expect((await c('DELETE', `/v1/risk_signals/${byIp.id}`)).json.status).toBe('revoked');
    expect((await c('GET', '/v1/risk_signals?status=active')).json.data).toHaveLength(1);
    await c('POST', '/v1/sessions', { user_id: user.id });
    const replay = (await c('POST', '/v1/risk_based_mfa/replay', { candidate: { step_up_threshold: 200 } })).json;
    expect(replay).toMatchObject({ object: 'risk_replay', sign_ins: 1, users: 1, changed: 1, removes_friction: 1, adds_friction: 0 });
    expect((await c('POST', '/v1/risk_based_mfa/replay', { days: 99 })).status).toBe(400);
  });

  it('stores the traits schema with a version guard and lists search fields', async () => {
    const c = call();
    expect((await c('GET', '/v1/instance/user_traits_schema')).json).toMatchObject({ version: 0, enforcement: 'off', updated_at: null });
    expect((await c('PUT', '/v1/instance/user_traits_schema', { schemas: { nope: {} } })).status).toBe(400);
    const put = await c('PUT', '/v1/instance/user_traits_schema', { enforcement: 'warn', schemas: { public_metadata: { type: 'object', required: ['plan'], properties: { plan: { type: 'string', enum: ['free', 'pro'] } } } } });
    expect(put.json).toMatchObject({ version: 1, enforcement: 'warn' });
    expect((await c('PUT', '/v1/instance/user_traits_schema', { enforcement: 'enforce', version: 0 })).status).toBe(409);
    const fields = (await c('GET', '/v1/users/search/fields')).json.data;
    expect(fields).toContainEqual(expect.objectContaining({ field: 'public_metadata.plan', source: 'schema', enum: ['free', 'pro'], required: true }));
    expect(fields).toContainEqual(expect.objectContaining({ field: 'email_address', source: 'builtin' }));
  });

  it('answers config limits, owned organizations, drills and the assignment and revoked-token feeds', async () => {
    const c = call();
    expect((await c('GET', '/v1/config/limits')).json.limits.permissions).toMatchObject({ key_max_length: 160, max_parts: 6 });
    const ada = (await c('POST', '/v1/users', { email_address: 'ada@example.com' })).json;
    const bob = (await c('POST', '/v1/users', { email_address: 'bob@example.com' })).json;
    const org = (await c('POST', '/v1/organizations', { name: 'Acme', created_by: ada.id })).json;
    expect((await c('GET', `/v1/users/${ada.id}/owned_organizations`)).json.data).toEqual([]);
    await c('POST', `/v1/organizations/${org.id}/memberships`, { user_id: bob.id, role: 'org:member' });
    expect((await c('GET', `/v1/users/${ada.id}/owned_organizations`)).json.data).toEqual([expect.objectContaining({ id: org.id, other_members: 1 })]);

    const drill = (await c('POST', '/v1/instance/data_key_provider/rotation_drill', {})).json;
    expect(drill).toMatchObject({ object: 'data_key_drill', ok: true, failed: 0 });
    expect((await c('GET', `/v1/instance/data_key_provider/rotation_drills/${drill.id}`)).json.id).toBe(drill.id);
    expect((await c('GET', '/v1/instance/data_key_provider/rotation_drills')).json.data).toHaveLength(1);

    const feed = (await c('GET', '/v1/resource_role_assignments/changes')).json;
    expect(feed).toMatchObject({ object: 'list', data: [], has_more: false, next_cursor: '0' });
    expect((await c('GET', '/v1/resource_role_assignments/changes?after=abc')).status).toBe(400);
    expect((await c('GET', '/v1/resource_servers/rs_missing/revoked_tokens')).status).toBe(404);
    const rs = (await c('POST', '/v1/resource_servers', { name: 'API', identifier: 'https://api.example.com' })).json;
    expect((await c('GET', `/v1/resource_servers/${rs.id}/revoked_tokens`)).json).toMatchObject({ data: [], has_more: false, retention_seconds: 2_592_000 });
  });

  it('handles identity checks, reconfirm and saved-search counts', async () => {
    const c = call();
    const user = (await c('POST', '/v1/users', { email_address: 'ada@example.com' })).json;
    expect((await c('POST', `/v1/users/${user.id}/identity_verifications/import`, { provider: 'nope', session_id: 'x' })).status).toBe(400);
    const imp = await c('POST', `/v1/users/${user.id}/identity_verifications/import`, { provider: 'stripe_identity', session_id: 'vs_1' });
    expect(imp.status).toBe(201);
    expect(imp.json).toMatchObject({ object: 'identity_verification', status: 'approved', imported: true });
    expect((await c('POST', `/v1/users/${user.id}/identity_verifications/import`, { provider: 'stripe_identity', session_id: 'vs_1' })).status).toBe(409);
    expect((await c('GET', `/v1/users/${user.id}/identity_verifications/${imp.json.id}`)).json.id).toBe(imp.json.id);
    expect((await c('GET', `/v1/users/${user.id}/identity_verifications/nope`)).status).toBe(404);
    expect((await c('POST', `/v1/users/${user.id}/deletion/reconfirm`, {})).status).toBe(409);

    const view = (await c('POST', '/v1/users/search/views', { name: 'Adas', filter: { field: 'email_address', op: 'contains', value: 'ada' } })).json;
    const counted = await c('POST', `/v1/users/search/views/${view.id}/count`, {});
    expect(counted.json).toMatchObject({ member_count: 1 });
    expect(counted.json.counted_at).toBeGreaterThan(0);
  });

  it('keeps the bot lists and verifies a signed request', async () => {
    const c = call();
    expect((await c('PUT', '/v1/web_bot_auth', { allow: ['https://bot.example.com'], block: ['bot.example.com'] })).status).toBe(400);
    const set = (await c('PUT', '/v1/web_bot_auth', { allow: ['https://bot.example.com', { directory: 'other.example.com', name: 'Other' }] })).json;
    expect(set.allow).toHaveLength(2);
    expect((await c('POST', '/v1/web_bot_auth/directories', { directory: 'bot.example.com', list: 'block' })).status).toBe(201);
    expect((await c('GET', '/v1/web_bot_auth')).json).toMatchObject({ allow: [expect.objectContaining({ directory: 'https://other.example.com' })], block: [expect.objectContaining({ directory: 'https://bot.example.com' })] });
    const dirs = (await c('GET', '/v1/web_bot_auth/directories')).json.data;
    expect(dirs.map((d: any) => d.list).sort()).toEqual(['allow', 'block']);
    expect((await c('DELETE', `/v1/web_bot_auth/directories/${dirs[0].id}`)).json.deleted).toBe(true);
    expect((await c('DELETE', '/v1/web_bot_auth/directories/wbd_gone')).status).toBe(404);
    const none = (await c('POST', '/v1/agents/verify_request', { method: 'GET', url: 'https://site.example.com/a', headers: {} })).json;
    expect(none).toMatchObject({ verified: false, reason: 'no_signature', decision: 'unknown' });
  });

  it('adopts and releases an Atlas ID app once per code', async () => {
    const c = call();
    expect((await c('POST', '/v1/atlas_id_apps/adopt', { code: 'adopt_unknown' })).status).toBe(404);
    const issued = (await c('POST', '/__emulator/atlas_id_apps/adoption_codes', { name: 'My app' }, {})).json;
    const adopted = (await c('POST', '/v1/atlas_id_apps/adopt', { code: issued.code })).json;
    expect(adopted).toMatchObject({ object: 'atlas_id_app', name: 'My app', managed_via: 'adopted', changed: true });
    expect((await c('POST', '/v1/atlas_id_apps/adopt', { code: issued.code })).status).toBe(404);
    expect((await c('POST', `/v1/atlas_id_apps/${issued.app_id}/release`, {})).json).toMatchObject({ released: true });
    expect((await c('POST', `/v1/atlas_id_apps/${issued.app_id}/release`, {})).status).toBe(404);
  });

  it('completes a provider connect from the forwarded code and state', async () => {
    const c = call();
    expect((await c('POST', '/v1/connections/oauth/complete', { code: 'c', state: 'nope' })).status).toBe(400);
    const started = (await c('POST', '/__emulator/connections/oauth_states', { provider: 'github', return_url: 'https://app.example.com/done' }, {})).json;
    expect((await c('POST', '/v1/connections/oauth/complete', { code: 'c', state: started.state, oauth_client_id: 'other' })).status).toBe(400);
    const done = (await c('POST', '/v1/connections/oauth/complete', { code: 'c', state: started.state })).json;
    expect(done).toMatchObject({ object: 'connection_oauth_completion', created: true, reconnected_existing: false, redirect_url: 'https://app.example.com/done' });
    expect(done.connection_ids).toEqual([done.connection.id]);
    expect((await c('POST', '/v1/connections/oauth/complete', { code: 'c', state: started.state })).status).toBe(400);
  });

  it('reports abuse signals and an impersonation request', async () => {
    const c = call();
    await c('POST', '/__emulator/abuse_signals', { kind: 'sign_up', outcome: 'blocked', ip: '203.0.113.1', risk_score: 90, reasons: ['asn'] }, {});
    await c('POST', '/__emulator/abuse_signals', { kind: 'recovery', outcome: 'allowed' }, {});
    expect((await c('GET', '/v1/abuse_signals?outcome=blocked')).json.data).toEqual([expect.objectContaining({ kind: 'sign_up', risk_score: 90 })]);
    expect((await c('GET', '/v1/abuse_signals?kind=nope')).status).toBe(400);
    expect((await c('GET', '/v1/abuse_signals/summary')).json).toMatchObject({ days: 7, counts: expect.arrayContaining([{ kind: 'sign_up', outcome: 'blocked', n: 1 }]) });
    expect((await c('GET', '/v1/impersonations/requests/imp_missing')).status).toBe(404);
  });
});

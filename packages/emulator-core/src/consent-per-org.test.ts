/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { client, makeEngine } from './test-support';
import type { Engine } from './engine';

const CB = 'https://app.example/callback';
const form = (e: Engine) => async (path: string, fields: Record<string, string | string[]>) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) body.append(k, x);
  const res = await e.handle(new Request(`http://emulator.test${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), redirect: 'manual' }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, location: res.headers.get('location') };
};
const authorize = async (e: Engine, q: Record<string, string>) => {
  const res = await e.handle(new Request(`http://emulator.test/oauth2/authorize?${new URLSearchParams(q)}`, { redirect: 'manual' }));
  return { status: res.status, location: res.headers.get('location') };
};
const qs = (loc: string | null) => new URL(loc!).searchParams;
const isConsent = (loc: string | null) => new URL(loc!).pathname === '/oauth2/authorize/consent';

const setup = async (extra: Record<string, unknown> = {}) => {
  const e = makeEngine();
  const call = client(e);
  const user = (await call('POST', '/v1/users', { email_address: 'ada@example.com' })).json;
  const org = (name: string, external?: string) => {
    const o = e.db.organizations.insert({ object: 'organization', name, slug: name.toLowerCase(), external_id: external ?? null } as any) as any;
    e.db.memberships.insert({ object: 'organization_membership', user_id: user.id, organization_id: o.id, role: 'org:member' } as any);
    return o;
  };
  const c = (await call('POST', '/v1/oauth_clients', { name: 'Third party', redirect_uris: [CB], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'client_secret_post', require_consent: true, ...extra })).json;
  const base = { client_id: c.client_id, redirect_uri: CB, response_type: 'code', login_hint: user.id };
  return { e, call, user, org, c, base, post: form(e) };
};

describe('emulator: consent per organization', () => {
  it('asks again for another organization, never again for the one approved, and announces grant.created with the org external id', async () => {
    const { e, org, base, post } = await setup();
    const a = org('Alpha', 'tenant-a');
    const b = org('Beta');
    const first = await authorize(e, { ...base, scope: 'openid', organization: a.id });
    expect(isConsent(first.location)).toBe(true);
    const done = await post('/oauth2/authorize/consent', { consent_token: qs(first.location).get('consent_token')!, decision: 'approve' });
    expect(qs(done.location).get('code')).toBeTruthy();
    const created = e.webhooks.events.filter((x) => x.type === 'grant.created');
    expect(created).toHaveLength(1);
    expect(created[0]!.payload.data).toMatchObject({ organization_id: a.id, org_external_id: 'tenant-a', scopes: ['openid'] });

    expect(qs((await authorize(e, { ...base, scope: 'openid', organization: a.id })).location).get('code')).toBeTruthy();
    expect(isConsent((await authorize(e, { ...base, scope: 'openid', organization: b.id })).location)).toBe(true);
    // a request that names no organization is covered by the union of what the user approved
    expect(qs((await authorize(e, { ...base, scope: 'openid' })).location).get('code')).toBeTruthy();
  });

  it('refuses an organization the user does not belong to, and consent_per_organization false keeps one consent for all', async () => {
    const { e, call, org, base, post, c } = await setup();
    const a = org('Gamma');
    const other = e.db.organizations.insert({ object: 'organization', name: 'Delta', slug: 'delta' } as any) as any;
    expect(qs((await authorize(e, { ...base, scope: 'openid', organization: other.id })).location).get('error')).toBe('access_denied');
    expect((await call('PATCH', `/v1/oauth_clients/${c.id}`, { consent_per_organization: false })).json.consent_per_organization).toBe(false);
    const b = org('Epsilon');
    const first = await authorize(e, { ...base, scope: 'openid', organization: a.id });
    await post('/oauth2/authorize/consent', { consent_token: qs(first.location).get('consent_token')!, decision: 'approve' });
    expect(qs((await authorize(e, { ...base, scope: 'openid', organization: b.id })).location).get('code')).toBeTruthy();
  });

  it('revoking one organization ends only its tokens; the last consent ends the rest', async () => {
    const { e, call, org, base, post, c } = await setup({ grant_types: ['authorization_code', 'refresh_token'] });
    const orgs = [org('Zeta'), org('Eta')];
    for (const o of orgs) {
      const first = await authorize(e, { ...base, scope: 'openid', organization: o.id });
      const done = await post('/oauth2/authorize/consent', { consent_token: qs(first.location).get('consent_token')!, decision: 'approve' });
      expect((await post('/oauth2/token', { client_id: c.client_id, client_secret: c.client_secret, grant_type: 'authorization_code', code: qs(done.location).get('code')!, redirect_uri: CB })).status).toBe(200);
    }
    const list = (await call('GET', '/v1/grants?type=consent')).json.data;
    expect(list.map((g: any) => g.organization_id).sort()).toEqual(orgs.map((o) => o.id).sort());
    const first = list.find((g: any) => g.organization_id === orgs[0]!.id);
    const res = await call('DELETE', `/v1/grants/${first.id}`);
    expect(res.json).toMatchObject({ deleted: true, tokens_revoked: 1 });
    const revoked = e.webhooks.events.filter((x) => x.type === 'grant.revoked');
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.payload.data).toMatchObject({ organization_id: orgs[0]!.id, oauth_client_id: c.id });
    const left = (await call('GET', '/v1/grants?type=consent')).json.data;
    expect(left.map((g: any) => g.organization_id)).toEqual([orgs[1]!.id]);
    expect((await call('DELETE', `/v1/grants/${left[0].id}`)).json.tokens_revoked).toBe(1);
  });
});

describe('emulator: optional scopes, remember false, grant.updated', () => {
  it('shows optional scopes, grants only the ticked ones, and enforces granted_scopes on the delegated page', async () => {
    const { e, call, base, post, c } = await setup({ allowed_scopes: ['openid', 'email', 'tools:x'] });
    await e.handle(new Request('http://emulator.test/__emulator/oauth/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ optional_scopes: ['tools:x'] }) }));
    const run = async (ticked: string[]) => {
      const start = await authorize(e, { ...base, scope: 'openid tools:x', prompt: 'consent' });
      const token = qs(start.location).get('consent_token')!;
      const screen = JSON.parse(await (await e.handle(new Request(`http://emulator.test/oauth2/authorize/consent?consent_token=${token}`))).text());
      expect(screen.optional_scopes).toEqual(['tools:x']);
      const done = await post('/oauth2/authorize/consent', { consent_token: token, decision: 'approve', granted_scope: ticked });
      return post('/oauth2/token', { client_id: c.client_id, client_secret: c.client_secret, grant_type: 'authorization_code', code: qs(done.location).get('code')!, redirect_uri: CB });
    };
    expect((await run([])).json.scope).toBe('openid');
    expect((await run(['tools:x'])).json.scope).toBe('openid tools:x');
    expect(e.webhooks.events.some((x) => x.type === 'grant.updated')).toBe(true);

    const challenge = qs((await authorize(e, { ...base, scope: 'openid email tools:x', prompt: 'consent' })).location).get('consent_token')!;
    const bad = await call('PUT', `/v1/oauth_consent_requests/accept?consent_challenge=${challenge}`, { granted_scopes: ['openid', 'tools:x'] });
    expect(bad.status).toBe(400); // email is not optional
    const ok = await call('PUT', `/v1/oauth_consent_requests/accept?consent_challenge=${challenge}`, { granted_scopes: ['openid', 'email'] });
    expect(ok.status).toBe(200);
  });

  it('remember false leaves a revocable consent that never skips the screen; prompt=none then fails with consent_required', async () => {
    const { e, call, base } = await setup();
    const start = await authorize(e, { ...base, scope: 'openid' });
    const ch = qs(start.location).get('consent_token')!;
    expect((await call('PUT', `/v1/oauth_consent_requests/accept?consent_challenge=${ch}`, { remember: false })).status).toBe(200);
    const rows = (await call('GET', '/v1/grants?type=consent')).json.data;
    expect(rows).toHaveLength(1);
    expect(rows[0].remembered).toBe(false);
    expect(isConsent((await authorize(e, { ...base, scope: 'openid' })).location)).toBe(true);
    expect(qs((await authorize(e, { ...base, scope: 'openid', prompt: 'none' })).location).get('error')).toBe('consent_required');
    expect((await call('DELETE', `/v1/grants/${rows[0].id}`)).json.deleted).toBe(true);
    expect((await call('GET', '/v1/grants?type=consent')).json.data).toHaveLength(0);
  });
});

describe('emulator: require_consent applies to first-party clients too', () => {
  it('stops at the screen until the user approves with remember, then skips it', async () => {
    const { e, base, post } = await setup({ first_party: true });
    const first = await authorize(e, { ...base, scope: 'openid' });
    expect(isConsent(first.location)).toBe(true);
    await post('/oauth2/authorize/consent', { consent_token: qs(first.location).get('consent_token')!, decision: 'approve' });
    expect(qs((await authorize(e, { ...base, scope: 'openid' })).location).get('code')).toBeTruthy();
  });

  it('a first-party client without require_consent is never stopped', async () => {
    const { e, base } = await setup({ first_party: true, require_consent: false });
    expect(qs((await authorize(e, { ...base, scope: 'openid' })).location).get('code')).toBeTruthy();
  });
});

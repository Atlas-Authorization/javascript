import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient, AtlasApiError, collect, paginate } from './index';

const SECRET = 'sk_test_placeholder_not_a_real_key';
const API_URL = 'https://api.example.test';

/** A fetch mock that records calls and replies with the queued responses. */
function mockFetch(
  responses: Array<{ status?: number; body?: unknown; text?: string }>,
) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> =
    [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v as string;
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body as string | undefined,
    });
    const status = spec?.status ?? 200;
    const nullBody = status === 204 || status === 205 || status === 304;
    const payload = nullBody
      ? null
      : (spec?.text ?? (spec?.body === undefined ? '' : JSON.stringify(spec.body)));
    return new Response(payload, { status });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function client(fetchImpl: typeof fetch) {
  return createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: fetchImpl });
}

const last = (calls: ReturnType<typeof mockFetch>['calls']) => calls[calls.length - 1]!;

describe('request core: auth, method, path, serialization', () => {
  it('sends Bearer auth, the right method and path, and never logs the key', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'user', id: 'user_1' } }]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await client(impl).users.get('user_1');

    const call = last(calls);
    expect(call.method).toBe('GET');
    expect(call.url).toBe(`${API_URL}/v1/users/user_1`);
    expect(call.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(call.headers.accept).toBe('application/json');

    // The secret must never reach a log sink.
    const logged = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join(' ');
    expect(logged).not.toContain(SECRET);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('JSON-encodes a body and sets content-type', async () => {
    const { impl, calls } = mockFetch([{ status: 201, body: { object: 'user', id: 'u' } }]);
    await client(impl).users.create({ email_address: 'a@b.com', first_name: 'A' });
    const call = last(calls);
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/json');
    expect(JSON.parse(call.body!)).toEqual({ email_address: 'a@b.com', first_name: 'A' });
  });

  it('serializes query params, dropping undefined and encoding values', async () => {
    const { impl, calls } = mockFetch([{ body: { data: [], has_more: false, next_cursor: null } }]);
    await client(impl).users.list({ limit: 50, starting_after: 'user_9' });
    expect(last(calls).url).toBe(`${API_URL}/v1/users?limit=50&starting_after=user_9`);

    await client(impl).users.list({ limit: 10 });
    expect(last(calls).url).toBe(`${API_URL}/v1/users?limit=10`);
  });

  it('forwards an Idempotency-Key when supplied', async () => {
    const { impl, calls } = mockFetch([{ status: 201, body: { object: 'user', id: 'u' } }]);
    await client(impl).users.create({ email_address: 'a@b.com' }, 'idem-123');
    expect(last(calls).headers['idempotency-key']).toBe('idem-123');
  });

  it('tolerates a trailing slash on apiUrl', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'user', id: 'u' } }]);
    const c = createAtlasClient({ secretKey: SECRET, apiUrl: `${API_URL}/`, fetch: impl });
    await c.users.get('u');
    expect(last(calls).url).toBe(`${API_URL}/v1/users/u`);
  });

  it('returns undefined on a 204 with no body', async () => {
    const { impl } = mockFetch([{ status: 204 }]);
    const out = await client(impl).sessions.revoke('sess_1');
    expect(out).toBeUndefined();
  });

  it('throws when constructed without a secretKey', () => {
    expect(() => createAtlasClient({ secretKey: '', fetch: mockFetch([]).impl })).toThrow();
  });
});

describe('error handling', () => {
  it('throws AtlasApiError carrying status and the stable code on a 4xx', async () => {
    const { impl } = mockFetch([
      { status: 404, body: { errors: [{ code: 'NOT_FOUND', message: 'Unknown user.' }] } },
    ]);
    const err = await client(impl)
      .users.get('nope')
      .catch((e) => e);
    expect(err).toBeInstanceOf(AtlasApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.hasCode('NOT_FOUND')).toBe(true);
    expect(err.message).toBe('Unknown user.');
  });

  it('branches on a conflict code like LAST_ADMIN', async () => {
    const { impl } = mockFetch([
      { status: 409, body: { errors: [{ code: 'LAST_ADMIN', message: 'Cannot demote.' }] } },
    ]);
    const err = await client(impl)
      .organizations.memberships.update('org_1', 'user_1', { role: 'member' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AtlasApiError);
    expect(err.status).toBe(409);
    expect(err.hasCode('LAST_ADMIN')).toBe(true);
  });

  it('falls back to a synthetic error for a non-JSON error body', async () => {
    const { impl } = mockFetch([{ status: 502, text: 'Bad Gateway' }]);
    const err = await client(impl)
      .users.list()
      .catch((e) => e);
    expect(err).toBeInstanceOf(AtlasApiError);
    expect(err.status).toBe(502);
    expect(err.errors[0].message).toContain('Bad Gateway');
  });
});

describe('pagination helper', () => {
  it('walks every cursor page and collects all items', async () => {
    const { impl, calls } = mockFetch([
      { body: { data: [{ id: 'a' }, { id: 'b' }], has_more: true, next_cursor: 'b' } },
      { body: { data: [{ id: 'c' }], has_more: false, next_cursor: null } },
    ]);
    const c = client(impl);
    const all = await collect(c.users.list);
    expect(all.map((u: { id: string }) => u.id)).toEqual(['a', 'b', 'c']);
    // Second page must carry the cursor from the first.
    expect(calls[1]!.url).toContain('starting_after=b');
  });

  it('paginate yields items lazily', async () => {
    const { impl } = mockFetch([
      { body: { data: [{ id: '1' }], has_more: true, next_cursor: '1' } },
      { body: { data: [{ id: '2' }], has_more: false, next_cursor: null } },
    ]);
    const seen: string[] = [];
    for await (const item of paginate(client(impl).auditLogs.list)) {
      seen.push((item as { id: string }).id);
    }
    expect(seen).toEqual(['1', '2']);
  });
});

describe('namespace routing (method + path + payload per namespace)', () => {
  it('users: ban, replaceMetadata, provider token', async () => {
    const { impl, calls } = mockFetch([{ body: {} }]);
    const c = client(impl);

    await c.users.ban('u1');
    expect(last(calls)).toMatchObject({ method: 'POST', url: `${API_URL}/v1/users/u1/ban` });

    await c.users.replaceMetadata('u1', { public_metadata: { tier: 'gold' } });
    expect(last(calls).method).toBe('PUT');
    expect(last(calls).url).toBe(`${API_URL}/v1/users/u1/metadata`);
    expect(JSON.parse(last(calls).body!)).toEqual({ public_metadata: { tier: 'gold' } });

    await c.users.getOAuthAccessToken('u1', 'google');
    expect(last(calls).url).toBe(`${API_URL}/v1/users/u1/oauth_access_tokens/google`);
  });

  it('sessions: list requires user_id in the query', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'list', data: [], has_more: false } }]);
    await client(impl).sessions.list({ user_id: 'u1' });
    expect(last(calls).url).toBe(`${API_URL}/v1/sessions?user_id=u1`);
  });

  it('sessions: create mints a session (POST /v1/sessions)', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'session', id: 's1', user_id: 'u1', jwt: 'j', refresh_token: 'r', expires_in: 60 } }]);
    const out = await client(impl).sessions.create({ user_id: 'u1' });
    expect(last(calls)).toMatchObject({ method: 'POST', url: `${API_URL}/v1/sessions` });
    expect(out).toMatchObject({ id: 's1', jwt: 'j', refresh_token: 'r' });
  });

  it('organizations: nested memberships/invitations/domains/groupRoles', async () => {
    const { impl, calls } = mockFetch([{ body: {} }]);
    const c = client(impl);

    await c.organizations.memberships.add('o1', { user_id: 'u1', role: 'admin' });
    expect(last(calls).url).toBe(`${API_URL}/v1/organizations/o1/memberships`);

    await c.organizations.invitations.revoke('o1', 'inv1');
    expect(last(calls).url).toBe(`${API_URL}/v1/organizations/o1/invitations/inv1/revoke`);

    await c.organizations.domains.verify('o1', 'd1');
    expect(last(calls).url).toBe(`${API_URL}/v1/organizations/o1/domains/d1/verify`);

    await c.organizations.groupRoles.grant('o1', 'g1', 'r1');
    expect(last(calls)).toMatchObject({
      method: 'PUT',
      url: `${API_URL}/v1/organizations/o1/groups/g1/roles/r1`,
    });
  });

  it('roles & permissions', async () => {
    const { impl, calls } = mockFetch([{ body: {} }]);
    const c = client(impl);
    await c.roles.setPermissions('r1', ['org:a:read']);
    expect(last(calls)).toMatchObject({ method: 'PUT', url: `${API_URL}/v1/roles/r1/permissions` });
    expect(JSON.parse(last(calls).body!)).toEqual({ permissions: ['org:a:read'] });

    await c.permissions.create({ key: 'org:x:manage' });
    expect(last(calls).url).toBe(`${API_URL}/v1/permissions`);
  });

  it('oauthClients + grants + resourceServers', async () => {
    const { impl, calls } = mockFetch([{ body: {} }]);
    const c = client(impl);
    await c.oauthClients.rotateSecret('c1');
    expect(last(calls).url).toBe(`${API_URL}/v1/oauth_clients/c1/rotate_secret`);
    await c.oauthClients.grants.delete('c1', 'g1');
    expect(last(calls)).toMatchObject({
      method: 'DELETE',
      url: `${API_URL}/v1/oauth_clients/c1/grants/g1`,
    });
    await c.resourceServers.create({ identifier: 'https://api', name: 'API' });
    expect(last(calls).url).toBe(`${API_URL}/v1/resource_servers`);
  });

  it('ssoConnections + scimTokens', async () => {
    const { impl, calls } = mockFetch([{ body: {} }]);
    const c = client(impl);
    await c.ssoConnections.samlMetadata('sso1');
    expect(last(calls).url).toBe(`${API_URL}/v1/sso_connections/sso1/saml_metadata`);
    await c.scimTokens.revoke('tok1');
    expect(last(calls).url).toBe(`${API_URL}/v1/scim_tokens/tok1/revoke`);
  });

  it('domains, waitlist, restrictions', async () => {
    const { impl, calls } = mockFetch([{ body: {} }]);
    const c = client(impl);
    await c.domains.verify('dom1');
    expect(last(calls).url).toBe(`${API_URL}/v1/domains/dom1/verify`);

    await c.waitlist.decide('w1', { status: 'approved' });
    expect(last(calls).url).toBe(`${API_URL}/v1/waitlist_entries/w1/decide`);

    await c.allowlist.add('a@b.com');
    expect(last(calls).url).toBe(`${API_URL}/v1/allowlist_identifiers`);
    expect(JSON.parse(last(calls).body!)).toEqual({ identifier: 'a@b.com' });

    await c.blocklist.remove('b1');
    expect(last(calls)).toMatchObject({
      method: 'DELETE',
      url: `${API_URL}/v1/blocklist_identifiers/b1`,
    });
  });

  it('attackProtection, actorTokens, invitations', async () => {
    const { impl, calls } = mockFetch([{ body: {} }]);
    const c = client(impl);
    await c.attackProtection.update({ brute_force: { enabled: false } });
    expect(last(calls)).toMatchObject({ method: 'PATCH', url: `${API_URL}/v1/attack_protection` });

    await c.actorTokens.create({ user_id: 'u1', actor: { sub: 'admin_1' } });
    expect(last(calls).url).toBe(`${API_URL}/v1/actor_tokens`);

    await c.invitations.revoke('i1');
    expect(last(calls).url).toBe(`${API_URL}/v1/invitations/i1/revoke`);
  });

  it('webhooks, signInTokens, auditLogs, jwtTemplates', async () => {
    const { impl, calls } = mockFetch([{ body: {} }]);
    const c = client(impl);
    await c.webhooks.endpoints.create({ url: 'https://hook' });
    expect(last(calls).url).toBe(`${API_URL}/v1/webhook_endpoints`);
    await c.webhooks.deliveries('we1');
    expect(last(calls).url).toBe(`${API_URL}/v1/webhook_endpoints/we1/deliveries`);

    await c.signInTokens.create({ user_id: 'u1' });
    expect(last(calls).url).toBe(`${API_URL}/v1/sign_in_tokens`);

    await c.auditLogs.list({ action: 'user.banned', actor_id: 'admin' });
    expect(last(calls).url).toBe(
      `${API_URL}/v1/audit_logs?action=user.banned&actor_id=admin`,
    );

    await c.jwtTemplates.update('supabase', { claims: { role: '{{user.id}}' } });
    expect(last(calls)).toMatchObject({
      method: 'PATCH',
      url: `${API_URL}/v1/jwt_templates/supabase`,
    });
  });
});

describe('parity wave: the full-breadth namespaces reach every BAPI resource', () => {
  it('users: identities & consent grants', async () => {
    const { impl, calls } = mockFetch([{ body: {} }]);
    const c = client(impl);
    await c.users.listIdentities('u1');
    expect(last(calls).url).toBe(`${API_URL}/v1/users/u1/identities`);
    await c.users.linkIdentity('u1', { secondary_user_id: 'u2' });
    expect(last(calls)).toMatchObject({ method: 'POST', url: `${API_URL}/v1/users/u1/identities` });
    await c.users.revokeGrant('grant1');
    expect(last(calls)).toMatchObject({ method: 'DELETE', url: `${API_URL}/v1/grants/grant1` });
    await c.users.revokeAllGrants('u1');
    expect(last(calls)).toMatchObject({ method: 'DELETE', url: `${API_URL}/v1/users/u1/grants` });
  });

  it('organizations: B2B2B hierarchy & entitlements', async () => {
    const { impl, calls } = mockFetch([{ body: {} }]);
    const c = client(impl);
    await c.organizations.setParent('o1', { parent_organization_id: 'o0' });
    expect(last(calls)).toMatchObject({ method: 'PUT', url: `${API_URL}/v1/organizations/o1/parent` });
    await c.organizations.hierarchy('o1');
    expect(last(calls).url).toBe(`${API_URL}/v1/organizations/o1/hierarchy`);
    await c.organizations.entitlements('o1');
    expect(last(calls).url).toBe(`${API_URL}/v1/organizations/o1/entitlements`);
  });

  it('keys & connections: apiKeys, oauthProviders, ssoOnboarding, scimProvisioning', async () => {
    const { impl, calls } = mockFetch([{ body: {} }]);
    const c = client(impl);
    await c.apiKeys.verify({ secret: 'ak_test' } as never);
    expect(last(calls)).toMatchObject({ method: 'POST', url: `${API_URL}/v1/api_keys/verify` });
    await c.oauthProviders.upsert('google', {} as never);
    expect(last(calls)).toMatchObject({ method: 'PUT', url: `${API_URL}/v1/oauth_providers/google` });
    await c.ssoOnboarding.createTicket('prof1', {} as never);
    expect(last(calls).url).toBe(`${API_URL}/v1/sso_onboarding_profiles/prof1/tickets`);
    await c.scimProvisioning.syncUser('tgt1', { user_id: 'u1' } as never);
    expect(last(calls).url).toBe(`${API_URL}/v1/scim_provisioning_targets/tgt1/sync_user`);
  });

  it('fga: stores, models, and relationship ops', async () => {
    const { impl, calls } = mockFetch([{ body: {} }]);
    const c = client(impl);
    await c.fga.stores.create({ name: 'store' });
    expect(last(calls).url).toBe(`${API_URL}/v1/fga/stores`);
    await c.fga.check('st1', {} as never);
    expect(last(calls)).toMatchObject({ method: 'POST', url: `${API_URL}/v1/fga/stores/st1/check` });
  });

  it('attack protection: rateLimitPolicy, riskBasedMfa, botSignals, networkAcls, managedWaf', async () => {
    const { impl, calls } = mockFetch([{ body: {} }]);
    const c = client(impl);
    await c.rateLimitPolicy.get();
    expect(last(calls).url).toBe(`${API_URL}/v1/rate_limit_policy`);
    await c.riskBasedMfa.get();
    expect(last(calls).url).toBe(`${API_URL}/v1/risk_based_mfa`);
    await c.botSignals.list();
    expect(last(calls).url).toBe(`${API_URL}/v1/bot_signals`);
    await c.networkAcls.list();
    expect(last(calls).url).toBe(`${API_URL}/v1/network_acls`);
    await c.managedWaf.status();
    expect(last(calls).url).toBe(`${API_URL}/v1/managed_waf/status`);
  });

  it('branding, templates & i18n: branding, emailTemplates, smsTemplates, localizations, logStreams', async () => {
    const { impl, calls } = mockFetch([{ body: {} }]);
    const c = client(impl);
    await c.branding.get();
    expect(last(calls).url).toBe(`${API_URL}/v1/branding`);
    await c.emailTemplates.list();
    expect(last(calls).url).toBe(`${API_URL}/v1/email_templates`);
    await c.smsTemplates.list();
    expect(last(calls).url).toBe(`${API_URL}/v1/sms_templates`);
    await c.localizations.list();
    expect(last(calls).url).toBe(`${API_URL}/v1/localizations`);
    await c.logStreams.test('ls1');
    expect(last(calls)).toMatchObject({ method: 'POST', url: `${API_URL}/v1/log_streams/ls1/test` });
  });

  it('automation & data: actions, importExport, dataSubjectRequests, messaging, billing', async () => {
    const { impl, calls } = mockFetch([{ body: {} }]);
    const c = client(impl);
    await c.actions.setBindings('post_login', {} as never);
    expect(last(calls)).toMatchObject({ method: 'PUT', url: `${API_URL}/v1/actions/bindings/post_login` });
    await c.importExport.listJobs();
    expect(last(calls).url).toBe(`${API_URL}/v1/jobs`);
    await c.dataSubjectRequests.fulfill('dsr1');
    expect(last(calls)).toMatchObject({ method: 'POST', url: `${API_URL}/v1/data_subject_requests/dsr1/fulfill` });
    await c.messaging.get();
    expect(last(calls).url).toBe(`${API_URL}/v1/messaging_providers`);
    await c.billing.listPlans();
    expect(last(calls).url).toBe(`${API_URL}/v1/billing/plans`);
  });

  it('connectors & instance: radiusClients, ltiPlatforms, instance, instanceSecurity, tokens', async () => {
    const { impl, calls } = mockFetch([{ body: {} }]);
    const c = client(impl);
    await c.radiusClients.list();
    expect(last(calls).url).toBe(`${API_URL}/v1/radius_clients`);
    await c.ltiPlatforms.list();
    expect(last(calls).url).toBe(`${API_URL}/v1/lti_platforms`);
    await c.instance.get();
    expect(last(calls).url).toBe(`${API_URL}/v1/instance`);
    await c.instanceSecurity.setCaptchaSecret({ secret: 's' } as never);
    expect(last(calls)).toMatchObject({ method: 'PUT', url: `${API_URL}/v1/instance/captcha_secret` });
    await c.tokens.verify({ token: 'jwt' });
    expect(last(calls)).toMatchObject({ method: 'POST', url: `${API_URL}/v1/tokens/verify` });
  });
});

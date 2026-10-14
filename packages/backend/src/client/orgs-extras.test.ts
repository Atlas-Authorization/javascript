import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

const SECRET = 'sk_test_placeholder_not_a_real_key';
const API_URL = 'https://api.example.test';

/** A fetch mock that records calls and replies with the queued responses. */
function mockFetch(responses: Array<{ status?: number; body?: unknown }>) {
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
    const payload = spec?.body === undefined ? '' : JSON.stringify(spec.body);
    return new Response(payload, { status });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function setup(body: unknown = { ok: true }) {
  const { impl, calls } = mockFetch([{ body }]);
  const atlas = createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl });
  const last = () => calls[calls.length - 1]!;
  return { atlas, calls, last };
}

const json = (b: string | undefined) => (b === undefined ? undefined : JSON.parse(b));

describe('organizations: policy, settings, audit streams, branding, end users, reader domain', () => {
  it('updatePolicy sends the typed camelCase patch, with null clearing', async () => {
    const { atlas, last } = setup({
      object: 'organization_policy',
      organization_id: 'org_1',
      policy: { requireMfa: true, ipAllowlist: ['203.0.113.0/24'], endUserPool: { enabled: true } },
    });
    const res = await atlas.organizations.updatePolicy('org_1', {
      requireMfa: true,
      allowedSignInMethods: ['password', 'oauth:google'],
      ipAllowlist: ['203.0.113.0/24'],
      maxSessionAgeSeconds: null,
      endUserPool: { enabled: true, requireApproval: false },
    });
    expect(last().method).toBe('PATCH');
    expect(last().url).toBe(`${API_URL}/v1/organizations/org_1/policy`);
    expect(json(last().body)).toEqual({
      requireMfa: true,
      allowedSignInMethods: ['password', 'oauth:google'],
      ipAllowlist: ['203.0.113.0/24'],
      maxSessionAgeSeconds: null,
      endUserPool: { enabled: true, requireApproval: false },
    });
    expect(res.policy.endUserPool?.enabled).toBe(true);
  });

  it('settings get / replace / update', async () => {
    const doc = { object: 'organization_settings', organization_id: 'org_1', values: { a: 1 }, version: 2, updated_by: null, updated_at: 1 };
    const { atlas, last } = setup(doc);
    expect((await atlas.organizations.settings.get('org_1')).version).toBe(2);
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/organizations/org_1/settings`);

    await atlas.organizations.settings.replace('org_1', { a: 1 }, 'idem-1');
    expect(last().method).toBe('PUT');
    expect(json(last().body)).toEqual({ values: { a: 1 } });
    expect(last().headers['idempotency-key']).toBe('idem-1');

    await atlas.organizations.settings.update('org_1', { a: null });
    expect(last().method).toBe('PATCH');
    expect(json(last().body)).toEqual({ values: { a: null } });
  });

  it('auditStreams list / create / delete', async () => {
    const { atlas, last } = setup({ object: 'list', data: [], has_more: false });
    await atlas.organizations.auditStreams.list('org_1');
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/organizations/org_1/audit_streams`);

    await atlas.organizations.auditStreams.create('org_1', {
      url: 'https://siem.example.test/in',
      secret: 'sixteen-chars-min!',
      format: 'json',
    });
    expect(last().method).toBe('POST');
    expect(json(last().body)).toEqual({
      url: 'https://siem.example.test/in',
      secret: 'sixteen-chars-min!',
      format: 'json',
    });

    await atlas.organizations.auditStreams.delete('org_1', 'oas_1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/organizations/org_1/audit_streams/oas_1`);
  });

  it('branding get / update', async () => {
    const { atlas, last } = setup({ object: 'organization_branding', organization_id: 'org_1' });
    await atlas.organizations.branding.get('org_1');
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/organizations/org_1/branding`);

    await atlas.organizations.branding.update('org_1', { display_name: 'Acme', logo_url: null });
    expect(last().method).toBe('PUT');
    expect(json(last().body)).toEqual({ display_name: 'Acme', logo_url: null });
  });

  it('endUsers list / add / update / remove', async () => {
    const { atlas, last } = setup({ object: 'list', data: [], has_more: false, next_cursor: null });
    await atlas.organizations.endUsers.list('org_1', { status: 'pending', limit: 10 });
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/organizations/org_1/end_users?status=pending&limit=10`);

    await atlas.organizations.endUsers.add('org_1', { user_id: 'user_1', source: 'import' });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/organizations/org_1/end_users`);
    expect(json(last().body)).toEqual({ user_id: 'user_1', source: 'import' });

    await atlas.organizations.endUsers.update('org_1', 'user_1', { status: 'blocked' });
    expect(last().method).toBe('PATCH');
    expect(last().url).toBe(`${API_URL}/v1/organizations/org_1/end_users/user_1`);
    expect(json(last().body)).toEqual({ status: 'blocked' });

    await atlas.organizations.endUsers.remove('org_1', 'user_1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/organizations/org_1/end_users/user_1`);
  });

  it('readerDomain list / create / delete', async () => {
    const { atlas, last } = setup({ object: 'list', data: [] });
    await atlas.organizations.readerDomain.list('org_1');
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/organizations/org_1/reader_domain`);

    await atlas.organizations.readerDomain.create('org_1', { host: 'readers.acme.test' });
    expect(last().method).toBe('POST');
    expect(json(last().body)).toEqual({ host: 'readers.acme.test' });

    await atlas.organizations.readerDomain.delete('org_1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/organizations/org_1/reader_domain`);
  });
});

describe('organizationSettingsSchema', () => {
  it('get / create / replace', async () => {
    const { atlas, last } = setup({ object: 'organization_settings_schema', schema: {}, version: 1, updated_at: 1 });
    await atlas.organizationSettingsSchema.get();
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/organization_settings_schema`);

    const schema = { type: 'object', properties: { tier: { type: 'string' } } };
    await atlas.organizationSettingsSchema.create(schema);
    expect(last().method).toBe('POST');
    expect(json(last().body)).toEqual({ schema });

    await atlas.organizationSettingsSchema.replace(schema);
    expect(last().method).toBe('PUT');
    expect(json(last().body)).toEqual({ schema });
  });
});

describe('entitlementOverrides', () => {
  it('create / list with filters / delete', async () => {
    const { atlas, last } = setup({ object: 'entitlement_override', id: 'eo_1' });
    await atlas.entitlementOverrides.create({
      subject_type: 'org',
      subject_id: 'org_1',
      plan: 'enterprise',
      limits: { max_devices: 50 },
      expires_at: null,
    });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/entitlement_overrides`);
    expect(json(last().body)).toEqual({
      subject_type: 'org',
      subject_id: 'org_1',
      plan: 'enterprise',
      limits: { max_devices: 50 },
      expires_at: null,
    });

    await atlas.entitlementOverrides.list({ subject_type: 'org', subject_id: 'org_1' });
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/entitlement_overrides?subject_type=org&subject_id=org_1`);

    await atlas.entitlementOverrides.delete('eo_1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/entitlement_overrides/eo_1`);
  });
});

describe('orgLdapConnections', () => {
  it('list / create / get / update / delete / test', async () => {
    const { atlas, last } = setup({ object: 'org_ldap_connection', id: 'ldap_1' });
    await atlas.orgLdapConnections.list({ organization_id: 'org_1' });
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/org_ldap_connections?organization_id=org_1`);

    const body = {
      organization_id: 'org_1',
      url: 'ldaps://dir.acme.test',
      bind_dn: 'cn=svc,dc=acme',
      base_dn: 'dc=acme',
      user_filter: '(uid={{username}})',
      attributes: { email: 'mail' },
      bind_password: 'pw',
    };
    await atlas.orgLdapConnections.create(body);
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/org_ldap_connections`);
    expect(json(last().body)).toEqual(body);

    await atlas.orgLdapConnections.get('ldap_1');
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/org_ldap_connections/ldap_1`);

    await atlas.orgLdapConnections.update('ldap_1', { status: 'active' });
    expect(last().method).toBe('PATCH');
    expect(json(last().body)).toEqual({ status: 'active' });

    await atlas.orgLdapConnections.test('ldap_1', { bind_password: 'pw2' });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/org_ldap_connections/ldap_1/test`);
    expect(json(last().body)).toEqual({ bind_password: 'pw2' });

    await atlas.orgLdapConnections.delete('ldap_1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/org_ldap_connections/ldap_1`);
  });
});

describe('billing, data subject requests, invitations, waitlist additions', () => {
  it('billing importSubscription / reportUsage / syncSeats', async () => {
    const { atlas, last } = setup({ object: 'billing_usage', recorded: true, metered: false, total: 5 });
    await atlas.billing.importSubscription({
      subject_type: 'org',
      subject_id: 'org_1',
      stripe_subscription_id: 'sub_123',
    });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/billing/subscriptions/import`);
    expect(json(last().body)).toEqual({
      subject_type: 'org',
      subject_id: 'org_1',
      stripe_subscription_id: 'sub_123',
    });

    const usage = await atlas.billing.reportUsage({
      subject_type: 'user',
      subject_id: 'user_1',
      quantity: 5,
      idempotency_key: 'k1',
    });
    expect(last().url).toBe(`${API_URL}/v1/billing/usage`);
    expect(json(last().body)).toEqual({
      subject_type: 'user',
      subject_id: 'user_1',
      quantity: 5,
      idempotency_key: 'k1',
    });
    expect(usage.total).toBe(5);

    await atlas.billing.syncSeats('org', 'org_1');
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/billing/subjects/org/org_1/sync_seats`);
    expect(last().body).toBeUndefined();
  });

  it('dataSubjectRequests create / cancel', async () => {
    const { atlas, last } = setup({ object: 'data_subject_request', id: 'dsr_1', status: 'scheduled' });
    await atlas.dataSubjectRequests.create({ type: 'erasure', subject_email: 'a@b.test' });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/data_subject_requests`);
    expect(json(last().body)).toEqual({ type: 'erasure', subject_email: 'a@b.test' });

    await atlas.dataSubjectRequests.cancel('dsr_1');
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/data_subject_requests/dsr_1/cancel`);
  });

  it('invitations bulkCreate', async () => {
    const { atlas, last } = setup({ object: 'list', data: [], errors: [] });
    await atlas.invitations.bulkCreate([{ email_address: 'a@b.test' }, { email_address: 'c@d.test' }]);
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/invitations/bulk`);
    expect(json(last().body)).toEqual({
      invitations: [{ email_address: 'a@b.test' }, { email_address: 'c@d.test' }],
    });
  });

  it('waitlist create / bulkCreate / delete', async () => {
    const { atlas, last } = setup({ object: 'waitlist_entry', id: 'wl_1' });
    await atlas.waitlist.create({ email_address: 'a@b.test' });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/waitlist_entries`);
    expect(json(last().body)).toEqual({ email_address: 'a@b.test' });

    await atlas.waitlist.bulkCreate(['a@b.test', 'c@d.test']);
    expect(last().url).toBe(`${API_URL}/v1/waitlist_entries/bulk`);
    expect(json(last().body)).toEqual({ email_addresses: ['a@b.test', 'c@d.test'] });

    await atlas.waitlist.delete('wl_1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/waitlist_entries/wl_1`);
  });
});

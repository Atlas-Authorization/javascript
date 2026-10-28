import { describe, expect, it } from 'vitest';
import { exportPropelauth, mapPropelauthUser, normalizeAuthUrl } from './propelauth';
import { fakeVendor, noSleep } from './propelauth-harness.test-helper';

/**
 * PropelAuth backend API responses as the SDKs document them: `GET
 * /api/backend/v1/user/query` (`{ users, total_users, current_page,
 * page_size, has_more_results }`, `org_id_to_org_info` per user), the org
 * query, `GET /org/{id}`, `pending_org_invites` and `end_user_api_keys`.
 * Timestamps are Unix seconds. Unrouted calls answer 404.
 */
const API = 'https://propelauth-api.com';
const AUTH_URL = 'https://123456.propelauthtest.com';
const KEY = 'pa_backend_key';
const B = '/api/backend/v1';
const PAGE = 'page_size=100';

const ORG_ACME = { org_id: 'org_acme', name: 'Acme', max_users: 50, is_saml_configured: true, metadata: { tier: 'gold' }, created_at: 1700000000 };
const ORG_BETA = { org_id: 'org_beta', name: 'Beta', max_users: -1, is_saml_configured: false, created_at: 1700000100 };

const JANE = {
  user_id: 'u_jane',
  email: 'Jane@Acme.example',
  email_confirmed: true,
  has_password: true,
  username: 'jane',
  first_name: 'Jane',
  last_name: 'Doe',
  picture_url: 'https://img.example/j.png',
  locked: false,
  enabled: true,
  mfa_enabled: true,
  can_create_orgs: true,
  created_at: 1700000000,
  last_active_at: 1700500000,
  legacy_user_id: 'old-1',
  metadata: { plan: 'pro' },
  org_id_to_org_info: {
    org_acme: {
      org_id: 'org_acme',
      org_name: 'Acme',
      url_safe_org_name: 'acme',
      user_role: 'Owner',
      inherited_user_roles_plus_current_role: ['Owner', 'Admin', 'Member'],
      user_permissions: ['billing:read', 'billing:write'],
      additional_roles: [],
    },
    org_beta: { org_id: 'org_beta', org_name: 'Beta', url_safe_org_name: 'beta', user_role: 'Admin', user_permissions: ['billing:read'], additional_roles: ['Auditor'] },
    org_gone: { org_id: 'org_gone', org_name: 'Gone Inc', url_safe_org_name: 'gone-inc', user_role: 'Member', user_permissions: [], additional_roles: [] },
  },
};
const SAM = {
  user_id: 'u_sam',
  email: 'sam@beta.example',
  email_confirmed: false,
  has_password: false,
  locked: true,
  enabled: false,
  mfa_enabled: false,
  created_at: 1700000200,
  org_id_to_org_info: { org_beta: { org_id: 'org_beta', user_role: 'Member', user_permissions: [], additional_roles: [] } },
};
const NO_ID = { user_id: 'u_none', has_password: true };

const INVITES = [
  { invitee_email: 'New@Acme.example', org_id: 'org_acme', org_name: 'Acme', role_in_org: 'Auditor', additional_roles_in_org: [], created_at: 1700000300, expires_at: 1700900000, inviter_email: 'jane@acme.example', inviter_user_id: 'u_jane' },
  { invitee_email: '', org_id: 'org_acme', role_in_org: 'Member' },
  { invitee_email: 'ghost@acme.example', org_id: 'org_acme', role_in_org: 'Member', inviter_user_id: 'u_deleted' },
];

function propelAuthApi(over: Record<string, unknown> = {}) {
  return fakeVendor(API, {
    [`GET ${B}/org/query?order_by=CREATED_AT_ASC&${PAGE}&page_number=0`]: { orgs: [ORG_ACME, ORG_BETA], total_orgs: 2, current_page: 0, page_size: 100, has_more_results: false },
    [`GET ${B}/org/org_acme`]: { org_id: 'org_acme', name: 'Acme', url_safe_org_slug: 'acme', domain: 'Acme.example', extra_domains: ['corp.acme.example', 'ACME.example'], domain_autojoin: true, domain_restrict: false },
    [`GET ${B}/user/query?include_orgs=true&order_by=CREATED_AT_ASC&${PAGE}&page_number=0`]: { users: [JANE], total_users: 3, current_page: 0, page_size: 100, has_more_results: true },
    [`GET ${B}/user/query?include_orgs=true&order_by=CREATED_AT_ASC&${PAGE}&page_number=1`]: { users: [SAM, NO_ID], total_users: 3, current_page: 1, page_size: 100, has_more_results: false },
    [`GET ${B}/pending_org_invites?org_id=org_acme&${PAGE}&page_number=0`]: { invites: INVITES, has_more_results: false },
    [`GET ${B}/end_user_api_keys?${PAGE}&page_number=0`]: { api_keys: [{ api_key_id: 'k1', user_id: 'u_jane', display_name: 'ci' }, { api_key_id: 'k2', org_id: 'org_acme' }], has_more_results: false },
    ...over,
  });
}

const run = (api: ReturnType<typeof propelAuthApi>, extra: { hashesText?: string } = {}) =>
  exportPropelauth({ authUrl: AUTH_URL, apiKey: KEY, fetchImpl: api.fetchImpl, sleep: noSleep, ...extra });

describe('exportPropelauth', () => {
  it('sends the API key and the auth hostname, and pages the user listing', async () => {
    const api = propelAuthApi();
    await run(api);
    const first = api.calls[0]!;
    expect(first.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(first.headers.get('x-propelauth-url')).toBe('123456.propelauthtest.com');
    const urls = api.calls.map((c) => c.url);
    expect(urls).toContain(`${API}${B}/user/query?include_orgs=true&order_by=CREATED_AT_ASC&${PAGE}&page_number=0`);
    expect(urls).toContain(`${API}${B}/user/query?include_orgs=true&order_by=CREATED_AT_ASC&${PAGE}&page_number=1`);
    expect(urls.some((u) => u.includes('page_number=2'))).toBe(false);
  });

  it('exports organizations with slug, self-join domains, member cap and metadata', async () => {
    const set = await run(propelAuthApi());
    expect(set.list('organization')).toEqual([
      { id: 'org_acme', name: 'Acme', slug: 'acme', domains: ['acme.example', 'corp.acme.example'], max_members: 50, public_metadata: { tier: 'gold' }, created_at: 1700000000000 },
      { id: 'org_beta', name: 'Beta', created_at: 1700000100000 },
      // Named on a member but missing from the listing: kept so the membership has somewhere to land.
      { id: 'org_gone', name: 'Gone Inc', slug: 'gone-inc' },
    ]);
    expect(set.omitted.sso_connection).toMatchObject({ count: 1 });
    expect(set.omitted.sso_connection!.reason).toMatch(/write-only/);
  });

  it('exports users with verified flags, names, metadata, locked / disabled and timestamps in ms', async () => {
    const set = await run(propelAuthApi());
    const users = set.list('user');
    expect(users.map((u) => u.id)).toEqual(['u_jane', 'u_sam']);
    expect(users[0]).toEqual({
      id: 'u_jane',
      emails: [{ email: 'jane@acme.example', verified: true, primary: true }],
      username: 'jane',
      first_name: 'Jane',
      last_name: 'Doe',
      image_url: 'https://img.example/j.png',
      private_metadata: { plan: 'pro', propelauth_legacy_user_id: 'old-1' },
      created_at: 1700000000000,
      last_sign_in_at: 1700500000000,
    });
    expect(users[1]).toMatchObject({ emails: [{ email: 'sam@beta.example', verified: false, primary: true }], banned: true, locked: true });
    expect(set.omitted.user).toMatchObject({ count: 1, reason: 'no email or username' });
  });

  it('seats members with the role they hold and keeps the permissions each role carries', async () => {
    const set = await run(propelAuthApi());
    expect(set.list('membership')).toEqual([
      { organization_id: 'org_acme', user_id: 'u_jane', role: 'owner' },
      { organization_id: 'org_beta', user_id: 'u_jane', role: 'admin' },
      { organization_id: 'org_gone', user_id: 'u_jane', role: 'member' },
      { organization_id: 'org_beta', user_id: 'u_sam', role: 'member' },
    ]);
    // admin / member are Atlas's own roles; owner and the role only an invitation names are custom.
    expect(set.list('role')).toEqual([
      { key: 'owner', name: 'owner', scope: 'organization', permissions: ['billing:read', 'billing:write'] },
      { key: 'auditor', name: 'auditor', scope: 'organization' },
    ]);
    expect(set.warnings.some((w) => /additional roles/.test(w))).toBe(true);
  });

  it('exports pending invitations whose inviter exists', async () => {
    const set = await run(propelAuthApi());
    expect(set.list('invitation')).toEqual([
      { id: 'org_acme:new@acme.example', organization_id: 'org_acme', email: 'new@acme.example', role: 'auditor', status: 'pending', inviter_user_id: 'u_jane', expires_at: 1700900000000, created_at: 1700000300000 },
      { id: 'org_acme:ghost@acme.example', organization_id: 'org_acme', email: 'ghost@acme.example', role: 'member', status: 'pending' },
    ]);
  });

  it('reports what PropelAuth cannot export', async () => {
    const set = await run(propelAuthApi());
    expect(set.omitted.api_key).toMatchObject({ count: 2 });
    expect(set.omitted.mfa_factor).toMatchObject({ count: 1 });
    expect(set.omitted.identity).toMatchObject({ count: 1 });
    expect(set.warnings.some((w) => /No password hashes/.test(w) && /--propelauth-hashes-file/.test(w))).toBe(true);
    expect(set.manifest).toEqual({ origin: AUTH_URL, settings: { auth_url: AUTH_URL } });
  });

  it('attaches support-exported hashes by user id, email or legacy id (algorithm auto)', async () => {
    const hashes = ['{"user_id":"u_jane","password_hash":"$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123"}', '{"email":"SAM@beta.example","password_hash":"$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA"}'].join('\n');
    const set = await run(propelAuthApi(), { hashesText: hashes });
    const [jane, sam] = set.list('user');
    expect(jane!.password).toEqual({ algorithm: 'auto', hash: '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123' });
    expect(sam!.password).toEqual({ algorithm: 'auto', hash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA' });
    expect(set.warnings.some((w) => /No password hashes/.test(w))).toBe(false);
  });

  it('accepts a CSV hash export and warns when it matches nobody', async () => {
    const csv = 'legacy_user_id,password_hash\nold-1,$2b$10$zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\n';
    const set = await run(propelAuthApi(), { hashesText: csv });
    expect(set.list('user')[0]!.password?.algorithm).toBe('auto');
    const none = await run(propelAuthApi(), { hashesText: 'user_id,password_hash\nnobody,$2b$10$x\n' });
    expect(none.list('user')[0]!.password).toBeUndefined();
    expect(none.warnings.some((w) => /matched no user/.test(w))).toBe(true);
  });

  it('falls back to POST for the organization query on a project that has no GET', async () => {
    const api = propelAuthApi({
      [`GET ${B}/org/query`]: { status: 405, body: { message: 'method not allowed' } },
      [`GET ${B}/org/query?order_by=CREATED_AT_ASC&${PAGE}&page_number=0`]: { status: 405, body: {} },
      [`POST ${B}/org/query`]: ({ body }: { body: unknown }) => ((body as { page_number: number }).page_number === 0 ? { orgs: [ORG_BETA], has_more_results: false } : { orgs: [] }),
    });
    const set = await run(api);
    expect(set.list('organization').map((o) => o.id)).toEqual(['org_beta', 'org_acme', 'org_gone']);
    const post = api.calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ page_size: 100, page_number: 0, order_by: 'CREATED_AT_ASC' });
  });

  it('names the failing call when the key is refused', async () => {
    const api = propelAuthApi({
      [`GET ${B}/org/query?order_by=CREATED_AT_ASC&${PAGE}&page_number=0`]: { status: 401, body: { message: 'Invalid API key' } },
    });
    await expect(run(api)).rejects.toThrow(/PropelAuth API 401 on \/api\/backend\/v1\/org\/query: Invalid API key/);
    await expect(exportPropelauth({ authUrl: AUTH_URL, apiKey: '', fetchImpl: api.fetchImpl })).rejects.toThrow(/API key/);
  });

  it('tolerates a project without invitations or API keys endpoints', async () => {
    const api = propelAuthApi({
      [`GET ${B}/pending_org_invites?org_id=org_acme&${PAGE}&page_number=0`]: { status: 403, body: {} },
      [`GET ${B}/end_user_api_keys?${PAGE}&page_number=0`]: { status: 404, body: {} },
    });
    const set = await run(api);
    expect(set.count('invitation')).toBe(0);
    expect(set.omitted.api_key).toBeUndefined();
  });
});

describe('mapPropelauthUser', () => {
  it('needs an email or a username', () => {
    expect(mapPropelauthUser({ user_id: 'u1' })).toBeNull();
    expect(mapPropelauthUser({ user_id: 'u1', username: 'ada' })).toEqual({ id: 'u1', username: 'ada' });
    expect(mapPropelauthUser({ email: 'a@b.example' })).toBeNull();
  });

  it('reads seconds and milliseconds timestamps', () => {
    expect(mapPropelauthUser({ user_id: 'u1', email: 'a@b.example', created_at: 1700000000 })!.created_at).toBe(1700000000000);
    expect(mapPropelauthUser({ user_id: 'u1', email: 'a@b.example', created_at: 1700000000000 })!.created_at).toBe(1700000000000);
  });
});

describe('normalizeAuthUrl', () => {
  it('accepts an https origin or a bare host, and nothing else', () => {
    expect(normalizeAuthUrl('https://123456.propelauthtest.com/')).toBe('https://123456.propelauthtest.com');
    expect(normalizeAuthUrl(' auth.example.com ')).toBe('https://auth.example.com');
    expect(() => normalizeAuthUrl('http://auth.example.com')).toThrow(/auth URL/);
    expect(() => normalizeAuthUrl('https://auth.example.com/path?x=1')).toThrow(/auth URL/);
    expect(() => normalizeAuthUrl('')).toThrow(/auth URL/);
  });
});

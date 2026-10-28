import { describe, expect, it } from 'vitest';
import { propelauthPlugin } from '../propelauth/plugin';
import { userfrontPlugin } from '../userfront/plugin';
import { FakeWriter, context, fakeVendor, resumeFrom } from './propelauth-harness.test-helper';

const AUTH_URL = 'https://123456.propelauthtest.com';
const B = '/api/backend/v1';

describe('propelauth plugin', () => {
  it('registers as the propelauth source with its bridge preset, codemod and no lazy preset', () => {
    expect(propelauthPlugin).toMatchObject({ vendor: 'propelauth', source: 'propelauth', codemod: 'propelauth', bridge: { preset: 'propelauth' } });
    expect(propelauthPlugin.lazy).toBeUndefined();
  });

  it('exports users and organizations through the bundle writer', async () => {
    const api = fakeVendor('https://propelauth-api.com', {
      [`GET ${B}/org/query?order_by=CREATED_AT_ASC&page_size=100&page_number=0`]: { orgs: [{ org_id: 'o1', name: 'Acme' }], has_more_results: false },
      [`GET ${B}/user/query?include_orgs=true&order_by=CREATED_AT_ASC&page_size=100&page_number=0`]: {
        users: [{ user_id: 'u1', email: 'a@b.example', email_confirmed: true, org_id_to_org_info: { o1: { org_id: 'o1', user_role: 'Admin' } } }],
        has_more_results: false,
      },
    });
    const { p } = context({ values: { 'propelauth-auth-url': AUTH_URL, 'propelauth-api-key': 'k' }, fetch: api.fetchImpl });
    const w = new FakeWriter();
    await propelauthPlugin.export!.run(p, w.writer, resumeFrom().resume);
    expect(w.ids('user')).toEqual(['u1']);
    expect(w.ids('organization')).toEqual(['o1']);
    expect(w.models()).toContain('membership');
    expect(w.warnings.some((m) => /--propelauth-hashes-file/.test(m))).toBe(true);
  });

  it('takes the auth URL from the app env and hands it to the bridge', async () => {
    const { p } = context({ env: { NEXT_PUBLIC_AUTH_URL: `${AUTH_URL}/` }, values: { 'propelauth-api-key': 'k' }, fetch: fakeVendor('https://propelauth-api.com', {}).fetchImpl });
    expect(propelauthPlugin.bridge!.vars(p)).toEqual({ auth_url: AUTH_URL });
    const tr = await propelauthPlugin.config!.translate(p);
    expect(tr.bridge).toEqual({ preset: 'propelauth', vars: { auth_url: AUTH_URL } });
  });

  it('asks for the auth URL when none is given', () => {
    const { p } = context();
    expect(() => propelauthPlugin.bridge!.vars(p)).toThrow(/auth URL/);
  });
});

describe('userfront plugin', () => {
  const TID = 'demo1234';

  it('registers as the userfront source with its lazy preset, codemod and no bridge', () => {
    expect(userfrontPlugin).toMatchObject({ vendor: 'userfront', source: 'userfront', codemod: 'userfront', lazy: { preset: 'userfront' } });
    expect(userfrontPlugin.bridge).toBeUndefined();
  });

  it('exports users and roles through the bundle writer', async () => {
    const api = fakeVendor('https://api.userfront.com', {
      [`POST /v0/tenants/${TID}/users/find`]: ({ body }: { body: unknown }) => ((body as { page: number }).page === 0 ? { results: [{ userId: 7, email: 'a@b.example', isEmailConfirmed: true, authorization: { [TID]: { roles: ['admin'] } } }] } : { results: [] }),
    });
    const { p } = context({ values: { 'userfront-tenant-id': TID, 'userfront-api-key': 'uf_live_admin_x' }, fetch: api.fetchImpl });
    const w = new FakeWriter();
    await userfrontPlugin.export!.run(p, w.writer, resumeFrom().resume);
    expect(w.ids('user')).toEqual(['7']);
    expect(w.models()).toContain('role');
    expect(w.described).toEqual([{ origin: TID, settings: { tenant_id: TID } }]);
  });

  it('takes the tenant id from the app env for the lazy preset and the translation', async () => {
    const { p } = context({ env: { NEXT_PUBLIC_USERFRONT_TENANT_ID: TID }, values: { 'userfront-api-key': 'uf_live_admin_x' }, fetch: fakeVendor('https://api.userfront.com', {}).fetchImpl });
    expect(userfrontPlugin.lazy!.config(p)).toEqual({ tenant_id: TID });
    const tr = await userfrontPlugin.config!.translate(p);
    expect(tr.lazy).toEqual({ preset: 'userfront', config: { tenant_id: TID } });
  });

  it('refuses a malformed tenant id', () => {
    const { p } = context({ values: { 'userfront-tenant-id': 'not valid!' } });
    expect(() => userfrontPlugin.lazy!.config(p)).toThrow(/tenant id/);
  });
});

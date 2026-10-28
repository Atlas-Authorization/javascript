import { describe, expect, it } from 'vitest';
import { fakeVendor, noSleep } from './propelauth-harness.test-helper';
import { userfrontHttp } from './userfront';
import { fetchUserfrontConfig, translateUserfrontConfig } from './userfront-config';

const API = 'https://api.userfront.com';
const TID = 'demo1234';
const http = (fetchImpl: typeof fetch) => userfrontHttp({ apiKey: 'uf_live_admin_abc', fetchImpl, sleep: noSleep });

describe('fetchUserfrontConfig', () => {
  it('reads the tenant roles', async () => {
    const api = fakeVendor(API, { [`GET /v0/tenants/${TID}/roles`]: { roles: [{ name: 'admin' }, { name: 'member' }, {}] } });
    expect(await fetchUserfrontConfig(http(api.fetchImpl), ` ${TID} `)).toEqual({ tenantId: TID, roles: ['admin', 'member'] });
  });

  it('degrades to no roles when the endpoint is not there', async () => {
    expect(await fetchUserfrontConfig(http(fakeVendor(API, {}).fetchImpl), TID)).toEqual({ tenantId: TID, roles: [] });
  });

  it('lets a rejected key through as an error', async () => {
    const api = fakeVendor(API, { [`GET /v0/tenants/${TID}/roles`]: { status: 401, body: { message: 'bad key' } } });
    await expect(fetchUserfrontConfig(http(api.fetchImpl), TID)).rejects.toThrow(/401/);
  });
});

describe('translateUserfrontConfig', () => {
  const t = translateUserfrontConfig({ tenantId: TID, roles: ['Admin', 'admin', 'Billing Team'] });

  it('turns roles into one app role each and maps passwords to lazy migration', () => {
    expect(t.origin).toBe(`Userfront tenant ${TID}`);
    expect(t.documents.roles).toEqual([
      { key: 'admin', name: 'Admin', description: '', permissions: [] },
      { key: 'billing_team', name: 'Billing Team', description: '', permissions: [] },
    ]);
    expect(t.report.find((r) => r.area === 'authorization')).toMatchObject({ status: 'mapped', setting: 'roles' });
    expect(t.report.find((r) => r.setting === 'password sign-in')).toMatchObject({ status: 'mapped' });
  });

  it('lists the dashboard-only settings as manual with where to look, and flags sessions as differing', () => {
    const manual = t.report.filter((r) => r.area === 'settings not in the API');
    expect(manual.map((r) => r.setting)).toContain('multi-factor authentication');
    for (const r of manual) expect(r.note).toMatch(/Dashboard/);
    expect(t.report.find((r) => r.area === 'sessions')).toMatchObject({ status: 'differs' });
  });

  it('hands the tenant id to the lazy preset and offers no bridge', () => {
    expect(t.lazy).toEqual({ preset: 'userfront', config: { tenant_id: TID } });
    expect(t.bridge).toBeUndefined();
  });

  it('omits the roles line when there are none', () => {
    expect(translateUserfrontConfig({ tenantId: TID, roles: [] }).report.some((r) => r.area === 'authorization')).toBe(false);
  });
});

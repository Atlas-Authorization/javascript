import { describe, expect, it } from 'vitest';
import { fetchPropelauthConfig, translatePropelauthConfig, type PropelauthConfigSnapshot } from './propelauth-config';
import { fakeVendor, noSleep } from './propelauth-harness.test-helper';
import { propelauthHttp } from './propelauth';

const API = 'https://propelauth-api.com';
const AUTH_URL = 'https://123456.propelauthtest.com';
const B = '/api/backend/v1';

describe('fetchPropelauthConfig', () => {
  it('reads role mappings (as objects or bare names) and counts organizations with SAML across pages', async () => {
    const api = fakeVendor(API, {
      [`GET ${B}/custom_role_mappings`]: { custom_role_mappings: [{ custom_role_mapping_name: 'Enterprise roles' }, 'Basic roles', { name: 'Legacy' }, {}] },
      [`GET ${B}/org/query?page_size=100&page_number=0`]: { orgs: [{ org_id: 'a', is_saml_configured: true }, { org_id: 'b' }], has_more_results: true },
      [`GET ${B}/org/query?page_size=100&page_number=1`]: { orgs: [{ org_id: 'c', is_saml_configured: true }], has_more_results: false },
    });
    const http = propelauthHttp({ authUrl: AUTH_URL, apiKey: 'k', fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(await fetchPropelauthConfig(http, `${AUTH_URL}/`)).toEqual({ authUrl: AUTH_URL, roleMappings: ['Enterprise roles', 'Basic roles', 'Legacy'], orgs: 3, samlOrgs: 2 });
  });

  it('degrades to an empty snapshot when the project exposes neither call', async () => {
    const api = fakeVendor(API, {});
    const http = propelauthHttp({ authUrl: AUTH_URL, apiKey: 'k', fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(await fetchPropelauthConfig(http, AUTH_URL)).toEqual({ authUrl: AUTH_URL, roleMappings: [], orgs: 0, samlOrgs: 0 });
  });

  it('lets a rejected key through as an error', async () => {
    const api = fakeVendor(API, { [`GET ${B}/custom_role_mappings`]: { status: 401, body: { message: 'bad key' } } });
    const http = propelauthHttp({ authUrl: AUTH_URL, apiKey: 'k', fetchImpl: api.fetchImpl, sleep: noSleep });
    await expect(fetchPropelauthConfig(http, AUTH_URL)).rejects.toThrow(/401/);
  });
});

describe('translatePropelauthConfig', () => {
  const SNAP: PropelauthConfigSnapshot = { authUrl: AUTH_URL, roleMappings: ['Enterprise roles'], orgs: 3, samlOrgs: 2 };

  it('reports organizations as mapped and the dashboard-only settings as manual, with where to look', () => {
    const t = translatePropelauthConfig(SNAP);
    expect(t.origin).toBe(`PropelAuth project ${AUTH_URL}`);
    expect(t.documents).toEqual({});
    const by = (area: string) => t.report.filter((r) => r.area === area);
    expect(by('organizations')[0]).toMatchObject({ status: 'mapped', atlas: 'organizations' });
    expect(by('roles')[0]).toMatchObject({ status: 'manual', setting: 'custom role mapping Enterprise roles' });
    expect(by('enterprise')[0]).toMatchObject({ status: 'manual', setting: 'SAML (2 organization(s))' });
    const manual = by('settings not in the API');
    expect(manual.map((r) => r.setting)).toContain('session and token lifetimes');
    for (const r of manual) expect(r.note).toMatch(/Dashboard/);
    expect(by('sessions')[0]).toMatchObject({ status: 'differs' });
  });

  it('hands the auth URL to the bridge step and offers no lazy preset', () => {
    const t = translatePropelauthConfig(SNAP);
    expect(t.bridge).toEqual({ preset: 'propelauth', vars: { auth_url: AUTH_URL } });
    expect(t.lazy).toBeUndefined();
    expect(t.env).toEqual([]);
  });

  it('omits the SAML and role lines when there is nothing to report', () => {
    const t = translatePropelauthConfig({ authUrl: AUTH_URL, roleMappings: [], orgs: 0, samlOrgs: 0 });
    expect(t.report.some((r) => r.area === 'enterprise' || r.area === 'roles')).toBe(false);
  });
});

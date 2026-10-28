import { describe, expect, it } from 'vitest';
import { translateStytchConfig } from './stytch-config';

describe('translateStytchConfig', () => {
  it('maps custom roles and permissions, skips built-in roles, and reports dashboard-only settings', () => {
    const r = translateStytchConfig({
      projectId: 'project-live-x',
      product: 'b2b',
      roles: [{ role_id: 'stytch_member' }, { role_id: 'billing', permissions: [{ resource_id: 'invoice', actions: ['read'] }] }],
      resources: [],
      organizations: 2,
      ssoConnections: 3,
    });
    expect(r.documents.roles).toEqual([{ key: 'billing', name: 'billing', description: '', permissions: ['invoice:read'] }]);
    expect(r.documents.permissions).toEqual([{ key: 'invoice:read', name: 'invoice:read', description: '' }]);
    expect(r.bridge).toEqual({ preset: 'stytch', vars: { project_id: 'project-live-x', jwks_path: 'b2b/sessions' } });
    expect(r.lazy).toEqual({ preset: 'stytch', config: { project_id: 'project-live-x', product: 'b2b' } });
    expect(r.report.some((e) => e.status === 'mapped' && e.setting.startsWith('3 SSO'))).toBe(true);
    expect(r.report.some((e) => e.status === 'manual' && e.setting.startsWith('password strength'))).toBe(true);
  });

  it('notes an empty policy and uses the test host for a test project', () => {
    const r = translateStytchConfig({ projectId: 'project-test-x', product: 'consumer', roles: [], resources: [], organizations: 0, ssoConnections: 0 });
    expect(r.documents.roles).toBeUndefined();
    expect(r.report.some((e) => e.status === 'manual' && e.setting === 'RBAC policy')).toBe(true);
    expect(r.bridge?.vars).toEqual({ project_id: 'project-test-x', api_host: 'test.stytch.com' });
  });
});

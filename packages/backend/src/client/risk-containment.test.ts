import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

const API_URL = 'https://api.example.test';
function mockFetch() {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body });
    return new Response(JSON.stringify({ object: 'x' }), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}
type C = ReturnType<typeof createAtlasClient>;
const TABLE: Array<[string, string, unknown, (c: C) => Promise<unknown>]> = [
  ['POST', '/v1/access_policies/impact', { draft: { name: 'd', grants: [{ type: 'block' }] }, days: 7 }, (c) => c.accessPolicies.impact({ draft: { name: 'd', grants: [{ type: 'block' }] }, days: 7 })],
  ['GET', '/v1/access_policies/insights?days=3', undefined, (c) => c.accessPolicies.insights({ days: 3 })],
  ['POST', '/v1/device_assurance_policies', { name: 'mac', platform: 'macos', min_os_version: '14' }, (c) => c.deviceAssurancePolicies.create({ name: 'mac', platform: 'macos', min_os_version: '14' })],
  ['POST', '/v1/device_assurance_policies/evaluate', {}, (c) => c.deviceAssurancePolicies.evaluate()],
  ['POST', '/v1/device_integrations', { provider: 'fleet', name: 'f', config: { baseUrl: 'https://f.example' }, credentials: { apiToken: 't' } }, (c) => c.deviceIntegrations.create({ provider: 'fleet', name: 'f', config: { baseUrl: 'https://f.example' }, credentials: { apiToken: 't' } })],
  ['POST', '/v1/device_integrations/dint_1/sync', {}, (c) => c.deviceIntegrations.sync('dint_1')],
  ['GET', '/v1/devices/dvc_1/compliance_history', undefined, (c) => c.devices.complianceHistory('dvc_1')],
  ['GET', '/v1/risky_users?state=at_risk', undefined, (c) => c.riskyUsers.list({ state: 'at_risk' })],
  ['POST', '/v1/risky_users/usr_1/force_password_change', {}, (c) => c.riskyUsers.forcePasswordChange('usr_1')],
  ['POST', '/v1/users/usr_1/contain', { reason: 'phished' }, (c) => c.containment.contain('usr_1', { reason: 'phished' })],
  ['POST', '/v1/users/usr_1/release', {}, (c) => c.containment.release('usr_1')],
  ['POST', '/v1/mfa_factor_quarantines/mfq_1/release', {}, (c) => c.factorQuarantines.release('mfq_1')],
  ['POST', '/v1/users/usr_1/temporary_access', { lifetime_seconds: 600 }, (c) => c.users.createTemporaryAccess('usr_1', { lifetime_seconds: 600 })],
  ['DELETE', '/v1/users/usr_1/temporary_access/tap_1', undefined, (c) => c.temporaryAccess.revoke('usr_1', 'tap_1')],
  ['POST', '/v1/fraud/email_risk', { email: 'a@x.com', verify_mailbox: true }, (c) => c.emailRisk.check({ email: 'a@x.com', verify_mailbox: true })],
  ['PUT', '/v1/fraud/email_risk/settings', { mode: 'mx', gate_sign_up: true }, (c) => c.emailRisk.updateSettings({ mode: 'mx', gate_sign_up: true })],
  ['POST', '/v1/messaging/suppressions', { email: 'a@x.com', reason: 'hard_bounce' }, (c) => c.emailRisk.suppressions.add({ email: 'a@x.com', reason: 'hard_bounce' })],
  ['DELETE', '/v1/messaging/suppressions/a%40x.com', undefined, (c) => c.emailRisk.suppressions.remove('a@x.com')],
  ['POST', '/v1/authenticator_policies', { name: 'admins', group: 'admins', required_factors: ['passkey'] }, (c) => c.authenticatorPolicies.create({ name: 'admins', group: 'admins', required_factors: ['passkey'] })],
  ['GET', '/v1/authenticator_policies/effective/usr_1', undefined, (c) => c.authenticatorPolicies.effective('usr_1')],
];

describe('conditional access, device, risk and email-risk operations', () => {
  it.each(TABLE)('%s %s', async (method, path, body, call) => {
    const { impl, calls } = mockFetch();
    await call(createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: impl }));
    const c = calls[calls.length - 1]!;
    expect([c.method, c.url]).toEqual([method, `${API_URL}${path}`]);
    expect(c.body === undefined ? undefined : JSON.parse(c.body as string)).toEqual(body);
  });
});

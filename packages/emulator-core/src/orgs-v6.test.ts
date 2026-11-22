import { describe, expect, it } from 'vitest';
import { client, makeEngine } from './test-support';

describe('organizations v6 in the emulator', () => {
  it('renames a permission, keeps the old key as an alias, and resolves it on role grants', async () => {
    const call = client(makeEngine());
    const perm = (await call('POST', '/v1/permissions', { key: 'org:invoices:manage' })).json;
    const role = (await call('POST', '/v1/roles', { key: 'billing', name: 'Billing', permissions: ['org:invoices:manage'] })).json;
    const renamed = await call('POST', `/v1/permissions/${perm.id}/rename`, { key: 'org:billing:invoices:manage' });
    expect(renamed.json).toMatchObject({ key: 'org:billing:invoices:manage', previous_key: 'org:invoices:manage' });
    expect((await call('GET', '/v1/permission_aliases')).json.data).toContainEqual(expect.objectContaining({ alias: 'org:invoices:manage', permission_key: 'org:billing:invoices:manage' }));
    const put = await call('PUT', `/v1/roles/${role.id}/permissions`, { permissions: ['org:invoices:manage'] });
    expect(put.json.permissions).toEqual(['org:billing:invoices:manage']);
    expect((await call('POST', '/v1/permissions', { key: 'org:invoices:manage' })).status).toBe(409);
    expect((await call('DELETE', '/v1/permission_aliases/org:invoices:manage')).status).toBe(200);
  });

  it('sets the active organization of a session for a member only, and searches invitations by email', async () => {
    const call = client(makeEngine());
    const user = (await call('POST', '/v1/users', { email_address: 'ada@example.com' })).json;
    const org = (await call('POST', '/v1/organizations', { name: 'Acme', created_by: user.id })).json;
    const other = (await call('POST', '/v1/organizations', { name: 'Other' })).json;
    const session = (await call('POST', '/v1/sessions', { user_id: user.id })).json;
    expect((await call('PUT', `/v1/sessions/${session.id}/active_organization`, { organization_id: org.id })).json.organization_id).toBe(org.id);
    expect((await call('PUT', `/v1/sessions/${session.id}/active_organization`, { organization_id: other.id })).status).toBe(404);
    expect((await call('PUT', `/v1/sessions/${session.id}/active_organization`, { organization_id: null })).json.organization_id).toBeNull();

    await call('POST', `/v1/organizations/${org.id}/invitations`, { email: 'bob@example.com', role: 'org:member' });
    const found = (await call('GET', '/v1/organization_invitations?email=BOB@example.com&status=pending')).json;
    expect(found.data).toHaveLength(1);
    expect(found.data[0]).toMatchObject({ organization_name: 'Acme', email: 'bob@example.com' });
  });
});

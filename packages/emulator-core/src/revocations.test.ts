/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { client, makeEngine } from './test-support';

/** The revocation stream, key and machine end records, dies_with and soft-ended grants, as the real API answers them. */
describe('emulator: revocation stream and credential ends', () => {
  async function seed() {
    const e = makeEngine();
    const call = client(e);
    const user = (await call('POST', '/v1/users', { email_address: `r-${Math.random().toString(36).slice(2)}@example.com` })).json;
    return { e, call, user };
  }

  it('a key with dies_with ends on sign-out everywhere, and the stream says why', async () => {
    const { e, call, user } = await seed();
    const start = (await call('GET', '/v1/revocations')).json.next_cursor;
    const key = (await call('POST', '/v1/api_keys', { subject_type: 'user', subject_id: user.id, dies_with: 'sign_out_everywhere', metadata: { team: 'ops' } })).json;
    expect(key).toMatchObject({ dies_with: 'sign_out_everywhere', metadata: { team: 'ops' }, claims: { team: 'ops' }, end_reason: null });
    const plain = (await call('POST', '/v1/api_keys', { subject_type: 'user', subject_id: user.id })).json;

    const { signOutEverywhere } = await import('./handlers/revocations');
    signOutEverywhere(e, user.id);

    expect((await call('GET', `/v1/api_keys/${key.id}`)).json).toMatchObject({ end_reason: 'signed_out_everywhere', revoked_by: { type: 'system' } });
    expect((await call('GET', `/v1/api_keys/${plain.id}`)).json.revoked_at).toBeNull();

    const page = (await call('GET', `/v1/revocations?after=${start}&kinds=api_key`)).json;
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({ kind: 'api_key', reason: 'signed_out_everywhere', ids: { api_key_id: key.id } });
    expect((await call('GET', `/v1/revocations?after=${page.next_cursor}`)).json.data.every((f: any) => f.kind !== 'api_key')).toBe(true);
  });

  it('validates dies_with, kinds and the cursor', async () => {
    const { call, user } = await seed();
    expect((await call('POST', '/v1/api_keys', { subject_type: 'user', subject_id: user.id, dies_with: 'forever' })).status).toBe(400);
    expect((await call('POST', '/v1/api_keys', { subject_type: 'user', subject_id: user.id, metadata: {}, claims: {} })).status).toBe(400);
    expect((await call('GET', '/v1/revocations?after=0&kinds=nope')).status).toBe(400);
    expect((await call('GET', '/v1/revocations?after=evt_1')).status).toBe(400);
  });

  it('a revoked machine keeps its first end record and shows in the deny feed', async () => {
    const { call } = await seed();
    const m = (await call('POST', '/v1/machines', { name: 'm1' })).json;
    const revoked = (await call('POST', `/v1/machines/${m.id}/revoke`)).json;
    expect(revoked).toMatchObject({ status: 'revoked', revoked_reason: 'revoked_by_api' });
    const again = (await call('POST', `/v1/machines/${m.id}/revoke`)).json;
    expect(again.ended_at).toBe(revoked.ended_at);
    const feed = (await call('GET', '/v1/machines/revoked')).json;
    expect(feed.data.find((x: any) => x.id === m.id)).toMatchObject({ object: 'machine', revoked_at: revoked.ended_at });
  });

  it('a deleted grant is soft-ended: listed only on request, never verifies, replaced by a new grant', async () => {
    const { call, user } = await seed();
    const m = (await call('POST', '/v1/machines', { name: 'owned', owner_user_id: user.id })).json;
    const rs = (await call('POST', '/v1/resource_servers', { identifier: `https://api-${Math.random().toString(36).slice(2)}.example.com`, name: 'API', scopes: ['a:read'] })).json;
    const g = (await call('POST', `/v1/machines/${m.id}/grants`, { resource_server_id: rs.id, scopes: ['a:read'] })).json;
    expect((await call('DELETE', `/v1/machines/${m.id}/grants/${g.id}`)).json).toMatchObject({ deleted: true, revoked_reason: 'revoked_by_api' });
    expect((await call('GET', `/v1/machines/${m.id}/grants`)).json.data).toHaveLength(0);
    const all = (await call('GET', `/v1/machines/${m.id}/grants?include_ended=true`)).json.data;
    expect(all[0]).toMatchObject({ id: g.id, revoked_reason: 'revoked_by_api' });
    expect((await call('DELETE', `/v1/machines/${m.id}/grants/${g.id}`)).status).toBe(404);
    expect((await call('GET', '/v1/machines/revoked')).json.data.find((x: any) => x.id === g.id)).toMatchObject({ object: 'machine_grant', machine_id: m.id, audience: rs.identifier });
    expect((await call('POST', `/v1/machines/${m.id}/grants`, { resource_server_id: rs.id, scopes: ['a:read'] })).status).toBe(201);
  });

  it('dies_with on a machine needs an owner', async () => {
    const { call, user } = await seed();
    expect((await call('POST', '/v1/machines', { name: 'x', dies_with: 'sign_out_everywhere' })).status).toBe(400);
    expect((await call('POST', '/v1/machines', { name: 'y', owner_user_id: user.id, dies_with: 'sign_out_everywhere' })).json.dies_with).toBe('sign_out_everywhere');
  });
});

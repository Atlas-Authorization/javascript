import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient, paginate } from './index';

const SECRET = 'sk_test_placeholder_not_a_real_key';
const API_URL = 'https://api.example.test';

/** A fetch mock that records calls and replies with the queued responses. */
function mockFetch(responses: Array<{ status?: number; body?: unknown; text?: string }>) {
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

function setup(body: unknown = {}, status = 200) {
  const { impl, calls } = mockFetch([{ status, body }]);
  const atlas = createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl });
  const last = () => calls[calls.length - 1]!;
  return { atlas, calls, last };
}

const json = (b: string | undefined) => (b === undefined ? undefined : JSON.parse(b));

describe('users: lookups and reads', () => {
  it('byEmails POSTs the batch with flags', async () => {
    const { atlas, last } = setup({
      object: 'list',
      data: [{ email_address: 'a@b.com', user_id: 'user_1', verified: false }],
    });
    const res = await atlas.users.byEmails({
      email_addresses: ['a@b.com'],
      include_unverified: true,
    });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/users/by_emails`);
    expect(json(last().body)).toEqual({ email_addresses: ['a@b.com'], include_unverified: true });
    expect(res.data[0]!.verified).toBe(false);
  });

  it('resolved / state GET their paths and decode', async () => {
    const { atlas, last } = setup({ object: 'resolved_user', user_id: 'user_1', email: 'a@b.com' });
    const r = await atlas.users.resolved('user_1');
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/resolved`);
    expect(r.email).toBe('a@b.com');

    await atlas.users.state('user 1');
    expect(last().url).toBe(`${API_URL}/v1/users/user%201/state`);
  });

  it('signInHistory sends cursor params and pages via paginate()', async () => {
    const { impl, calls } = mockFetch([
      {
        body: {
          object: 'list',
          data: [{ object: 'sign_in_event', id: 'sie_1' }],
          has_more: true,
          next_cursor: 'sie_1',
        },
      },
      {
        body: {
          object: 'list',
          data: [{ object: 'sign_in_event', id: 'sie_2' }],
          has_more: false,
          next_cursor: null,
        },
      },
    ]);
    const atlas = createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl });
    const ids: string[] = [];
    for await (const e of paginate((p) => atlas.users.signInHistory('user_1', p), { limit: 1 })) {
      ids.push(e.id);
    }
    expect(ids).toEqual(['sie_1', 'sie_2']);
    expect(calls[0]!.url).toBe(`${API_URL}/v1/users/user_1/sign_in_history?limit=1`);
    expect(calls[1]!.url).toBe(
      `${API_URL}/v1/users/user_1/sign_in_history?limit=1&starting_after=sie_1`,
    );
  });

  it('listOrganizationMemberships GETs with query', async () => {
    const { atlas, last } = setup({ object: 'list', data: [], has_more: false, next_cursor: null });
    await atlas.users.listOrganizationMemberships('user_1', { limit: 5 });
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/organization_memberships?limit=5`);
  });

  it('erasureExport GETs the export', async () => {
    const { atlas, last } = setup({ object: 'erasure_export', app_contributions: [] });
    const r = await atlas.users.erasureExport('user_1');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/erasure_export`);
    expect(r.object).toBe('erasure_export');
  });
});

describe('users: writes', () => {
  it('setPassword POSTs the password body', async () => {
    const { atlas, last } = setup({ object: 'user', id: 'user_1' });
    await atlas.users.setPassword('user_1', {
      password: 'correct horse',
      sign_out_of_other_sessions: true,
    });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/password`);
    expect(json(last().body)).toEqual({
      password: 'correct horse',
      sign_out_of_other_sessions: true,
    });
  });

  it('deleteProfileImage and deletePasskey use DELETE', async () => {
    const { atlas, last } = setup({ object: 'passkey', id: 'pk_1', deleted: true });
    await atlas.users.deleteProfileImage('user_1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/profile_image`);

    await atlas.users.deletePasskey('user_1', 'pk_1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/passkeys/pk_1`);
  });

  it('listDeviceKeys / deleteDeviceKey', async () => {
    const { atlas, last } = setup({ object: 'list', data: [] });
    await atlas.users.listDeviceKeys('user_1');
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/device_keys`);
    await atlas.users.deleteDeviceKey('user_1', 'dvk_1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/device_keys/dvk_1`);
  });

  it('importIdentity / removeIdentityByProvider', async () => {
    const { atlas, last } = setup({ object: 'identity', id: 'idn_1' });
    await atlas.users.importIdentity('user_1', {
      provider: 'google',
      provider_user_id: '123',
      verified: true,
    });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/identities/import`);
    expect(json(last().body)).toEqual({ provider: 'google', provider_user_id: '123', verified: true });

    await atlas.users.removeIdentityByProvider('user_1', 'google');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/identities/by-provider/google`);
  });

  it('acknowledgeErasure POSTs with an idempotency key', async () => {
    const { atlas, last } = setup({ object: 'user_erasure_ack', id: 'ack_1' }, 201);
    await atlas.users.acknowledgeErasure(
      'user_1',
      { source: 'billing-app', payload: { invoices: 3 } },
      'idem-1',
    );
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/erasure_acks`);
    expect(last().headers['idempotency-key']).toBe('idem-1');
    expect(json(last().body)).toEqual({ source: 'billing-app', payload: { invoices: 3 } });
  });

  it('createLink POSTs the type and expiry', async () => {
    const { atlas, last } = setup({ object: 'user_link', type: 'password_reset' }, 201);
    await atlas.users.createLink('user_1', { type: 'password_reset', expires_in_seconds: 600 }, 'idem-3');
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/links`);
    expect(last().headers['idempotency-key']).toBe('idem-3');
    expect(json(last().body)).toEqual({ type: 'password_reset', expires_in_seconds: 600 });
  });

  it('search query / export / views', async () => {
    const { atlas, last } = setup({ data: [], has_more: false });
    const filter = { field: 'traits.plan', op: 'eq', value: 'pro' } as const;
    await atlas.users.search.query({ filter, limit: 5 });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/users/search`);
    expect(json(last().body)).toEqual({ filter, limit: 5 });

    await atlas.users.search.views.create({ name: 'Pros', filter });
    expect(last().url).toBe(`${API_URL}/v1/users/search/views`);
    await atlas.users.search.views.update('usv_1', { name: 'P' });
    expect(last().method).toBe('PATCH');
    expect(last().url).toBe(`${API_URL}/v1/users/search/views/usv_1`);
    await atlas.users.search.views.delete('usv_1');
    expect(last().method).toBe('DELETE');
  });

  it('minor status and guardians', async () => {
    const { atlas, last } = setup({ object: 'minor_status', status: 'consent_required', guardians: [] });
    await atlas.users.minorStatus('user_1');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/minor_status`);
    await atlas.users.guardians.request('user_1', { email: 'p@example.com', send_email: true });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/guardians`);
    await atlas.users.guardians.approve('user_1', 'grdn_1', { note: 'form' });
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/guardians/grdn_1/approve`);
    await atlas.users.guardians.revoke('user_1', 'grdn_1');
    expect(last().method).toBe('DELETE');
  });

  it('notes create / list / update / delete and history', async () => {
    const { atlas, last } = setup({ object: 'user_note', id: 'unote_1' }, 201);
    await atlas.users.notes.create('user_1', { body: 'VIP', pinned: true });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/notes`);
    expect(json(last().body)).toEqual({ body: 'VIP', pinned: true });
    await atlas.users.notes.list('user_1');
    expect(last().method).toBe('GET');
    await atlas.users.notes.update('user_1', 'unote_1', { pinned: false });
    expect(last().method).toBe('PATCH');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/notes/unote_1`);
    await atlas.users.notes.delete('user_1', 'unote_1');
    expect(last().method).toBe('DELETE');
    await atlas.users.history('user_1', { limit: 10, starting_after: 'uhist_9', action: ['user.banned', 'user.locked'] });
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/history?limit=10&starting_after=uhist_9&action=user.banned%2Cuser.locked`);
  });

  it('requiredActions request / list / clear / bulk', async () => {
    const { atlas, last } = setup({ object: 'required_action', id: 'ura_1' }, 201);
    await atlas.users.requiredActions.request('user_1', { action: 'update_password' }, 'idem-2');
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/required_actions`);
    expect(last().headers['idempotency-key']).toBe('idem-2');
    expect(json(last().body)).toEqual({ action: 'update_password' });

    await atlas.users.requiredActions.list('user_1');
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/required_actions`);

    await atlas.users.requiredActions.clear('user_1', 'ura_1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/required_actions/ura_1`);

    await atlas.users.requiredActions.bulk({ action: 'verify_email', user_ids: ['a', 'b'] });
    expect(last().url).toBe(`${API_URL}/v1/required_actions/bulk`);
    expect(json(last().body)).toEqual({ action: 'verify_email', user_ids: ['a', 'b'] });
  });

  it('deletion schedule / cancel / finalize', async () => {
    const { atlas, last } = setup({ object: 'user', id: 'user_1' });
    await atlas.users.deletion.schedule('user_1', { grace_seconds: 60 });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/deletion`);
    expect(json(last().body)).toEqual({ grace_seconds: 60 });

    await atlas.users.deletion.cancel('user_1');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/deletion/cancel`);
    expect(last().body).toBeUndefined();

    await atlas.users.deletion.finalize('user_1', 'idem-f');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/deletion/finalize`);
    expect(last().headers['idempotency-key']).toBe('idem-f');
  });

  it('directives impose / lift', async () => {
    const { atlas, last } = setup({ object: 'directive', user_id: 'user_1', sessions_revoked: 2 });
    const d = await atlas.users.directives.impose('user_1', { read_only: true, reason: 'abuse' });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/directives`);
    expect(json(last().body)).toEqual({ read_only: true, reason: 'abuse' });
    expect(d.sessions_revoked).toBe(2);

    await atlas.users.directives.lift('user_1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/directives`);
  });

  it('consents list / record', async () => {
    const { atlas, last } = setup({ object: 'list', data: [] });
    await atlas.users.consents.list('user_1');
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/consents`);

    await atlas.users.consents.record('user_1', { policy: 'tos', version: '2026-10' });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/consents`);
    expect(json(last().body)).toEqual({ policy: 'tos', version: '2026-10' });
  });

  it('approvalRequests create / get', async () => {
    const { atlas, last } = setup(
      { object: 'approval_request', id: 'apr_1', status: 'pending', match_number: '42' },
      201,
    );
    const a = await atlas.users.approvalRequests.create('user_1', {
      description: 'Wire $500',
      context: { to: 'ACME' },
    });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/approval_requests`);
    expect(json(last().body)).toEqual({ description: 'Wire $500', context: { to: 'ACME' } });
    expect(a.match_number).toBe('42');

    await atlas.users.approvalRequests.get('user_1', 'apr_1');
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/approval_requests/apr_1`);
  });

  it('notificationPreferences get / update', async () => {
    const { atlas, last } = setup({ object: 'notification_preferences', preferences: [] });
    await atlas.users.notificationPreferences.get('user_1');
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/notification_preferences`);

    await atlas.users.notificationPreferences.update('user_1', {
      preferences: { new_device: false },
    });
    expect(last().method).toBe('PATCH');
    expect(json(last().body)).toEqual({ preferences: { new_device: false } });
  });

  it('phoneNumbers add / verify / delete', async () => {
    const { atlas, last } = setup({ object: 'phone_number', id: 'ph_1', verified: false });
    await atlas.users.phoneNumbers.add('user_1', { phone_number: '+15555550100' });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/phone_numbers`);
    expect(json(last().body)).toEqual({ phone_number: '+15555550100' });

    await atlas.users.phoneNumbers.verify('user_1', 'ph_1');
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/phone_numbers/ph_1/verify`);

    await atlas.users.phoneNumbers.delete('user_1', 'ph_1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/phone_numbers/ph_1`);
  });

  it('progression.addEvent POSTs the event', async () => {
    const { atlas, last } = setup(
      { object: 'progression_event', track: 'xp', xp: 10, level: 1, level_changed: false, delta: 10 },
      201,
    );
    const r = await atlas.users.progression.addEvent('user_1', {
      amount: 10,
      reason: 'quest',
      idempotency_key: 'q-1',
    });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/users/user_1/progression/events`);
    expect(json(last().body)).toEqual({ amount: 10, reason: 'quest', idempotency_key: 'q-1' });
    expect(r.xp).toBe(10);
  });
});

describe('email addresses, session tokens, sign-in token revoke', () => {
  it('emailAddresses.verify / setPrimary', async () => {
    const { atlas, last } = setup({ object: 'email_address', id: 'idn_1', verified: true });
    await atlas.emailAddresses.verify('idn_1');
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/email_addresses/idn_1/verify`);

    await atlas.emailAddresses.setPrimary('idn_1');
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/email_addresses/idn_1/primary`);
  });

  it('sessions.getToken POSTs to the template path', async () => {
    const { atlas, last } = setup({ object: 'token', jwt: 'a.b.c', expires_in: 60 });
    const t = await atlas.sessions.getToken('sess_1', 'supabase');
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/sessions/sess_1/tokens/supabase`);
    expect(t.jwt).toBe('a.b.c');
  });

  it('signInTokens.revoke POSTs to revoke', async () => {
    const { atlas, last } = setup({ object: 'sign_in_token', id: 'sit_1', revoked: true });
    await atlas.signInTokens.revoke('sit_1');
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/sign_in_tokens/sit_1/revoke`);
  });
});

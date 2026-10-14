import { describe, expect, it, vi } from 'vitest';
import { AtlasApiError, AtlasErrorCodes, createAtlasClient } from './index';

const API_URL = 'https://api.example.test';

function mockFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const spec = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined });
    return new Response(spec.body === undefined ? '' : JSON.stringify(spec.body), { status: spec.status ?? 200 });
  });
  const client = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: impl as unknown as typeof fetch });
  return { client, calls };
}

const STATE = {
  unit: 'usd_cents',
  period: 'month' as const,
  amount: 5000,
  used: 12,
  remaining: 4988,
  window_start: 1_790_000_000_000,
  resets_at: 1_792_000_000_000,
};
const COUNTER = { unit: 'usd_cents', period: 'month' as const, used: 12, window_start: 1_790_000_000_000, resets_at: 1_792_000_000_000 };

describe('apiKeys: spend caps and usage metering', () => {
  it('create sends limits and decodes limits + usage', async () => {
    const { client, calls } = mockFetch([
      {
        status: 201,
        body: {
          object: 'api_key',
          id: 'eak_1',
          secret: 'ak_x',
          limits: [{ unit: 'usd_cents', amount: 5000, period: 'month' }],
          usage: [{ ...STATE, used: 0, remaining: 5000 }],
        },
      },
    ]);
    const key = await client.apiKeys.create({
      subject_type: 'user',
      subject_id: 'user_1',
      limits: [{ unit: 'usd_cents', amount: 5000, period: 'month' }],
    });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${API_URL}/v1/api_keys` });
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      subject_type: 'user',
      subject_id: 'user_1',
      limits: [{ unit: 'usd_cents', amount: 5000, period: 'month' }],
    });
    expect(key.limits?.[0]?.period).toBe('month');
    expect(key.usage?.[0]?.remaining).toBe(5000);
  });

  it('update sends limits: null to clear the caps', async () => {
    const { client, calls } = mockFetch([{ body: { object: 'api_key', id: 'eak_1', limits: null, usage: [] } }]);
    const key = await client.apiKeys.update('eak_1', { limits: null });
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: `${API_URL}/v1/api_keys/eak_1` });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ limits: null });
    expect(key.limits).toBeNull();
  });

  it('recordUsage POSTs the debit and decodes an allowed outcome', async () => {
    const body = {
      object: 'api_key_usage_debit',
      key_id: 'eak_1',
      unit: 'usd_cents',
      amount: 12,
      allowed: true,
      exceeded: [],
      usage: [STATE],
      counters: [COUNTER],
      idempotent_replay: false,
    };
    const { client, calls } = mockFetch([{ body }]);
    const out = await client.apiKeys.recordUsage('eak_1', { amount: 12, unit: 'usd_cents', idempotency_key: 'req_1' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${API_URL}/v1/api_keys/eak_1/usage` });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ amount: 12, unit: 'usd_cents', idempotency_key: 'req_1' });
    expect(out).toEqual(body);
  });

  it('recordUsage resolves (does not throw) on a LIMIT_EXCEEDED refusal', async () => {
    const { client } = mockFetch([
      {
        body: {
          object: 'api_key_usage_debit',
          key_id: 'eak_1',
          unit: 'usd_cents',
          amount: 9999,
          allowed: false,
          code: 'LIMIT_EXCEEDED',
          exceeded: [STATE],
          usage: [STATE],
          counters: [COUNTER],
          idempotent_replay: false,
        },
      },
    ]);
    const out = await client.apiKeys.recordUsage('eak_1', { amount: 9999, unit: 'usd_cents' });
    expect(out.allowed).toBe(false);
    expect(out.code).toBe(AtlasErrorCodes.LIMIT_EXCEEDED);
    expect(out.exceeded[0]!.unit).toBe('usd_cents');
  });

  it('recordUsage surfaces 409 IDEMPOTENCY_CONFLICT as an AtlasApiError', async () => {
    const { client } = mockFetch([
      { status: 409, body: { errors: [{ code: 'IDEMPOTENCY_CONFLICT', message: 'reused', param: 'idempotency_key' }] } },
    ]);
    const err = await client.apiKeys.recordUsage('eak_1', { amount: 1, unit: 'requests', idempotency_key: 'k' }).catch((e) => e);
    expect(err).toBeInstanceOf(AtlasApiError);
    expect(err.status).toBe(409);
    expect(err.hasCode(AtlasErrorCodes.IDEMPOTENCY_CONFLICT)).toBe(true);
  });

  it('getUsage GETs the usage and decodes caps + counters', async () => {
    const body = {
      object: 'api_key_usage',
      key_id: 'eak_1',
      limits: [{ unit: 'usd_cents', amount: 5000, period: 'month' }],
      usage: [STATE],
      counters: [COUNTER],
    };
    const { client, calls } = mockFetch([{ body }]);
    const out = await client.apiKeys.getUsage('eak_1');
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${API_URL}/v1/api_keys/eak_1/usage` });
    expect(calls[0]!.body).toBeUndefined();
    expect(out).toEqual(body);
  });

  it('verify decodes name, scopes, constraints, limits and usage', async () => {
    const { client } = mockFetch([
      {
        body: {
          object: 'api_key_verification',
          valid: true,
          id: 'eak_1',
          subject_type: 'user',
          subject_id: 'user_1',
          name: 'CI',
          claims: {},
          scopes: ['read'],
          constraints: { ip: ['10.0.0.0/8'] },
          limits: [{ unit: 'usd_cents', amount: 5000, period: 'month' }],
          usage: [STATE],
          last_used_at: null,
          expires_at: null,
        },
      },
    ]);
    const v = await client.apiKeys.verify('ak_x');
    if (!v.valid) throw new Error('expected valid');
    expect(v.name).toBe('CI');
    expect(v.scopes).toEqual(['read']);
    expect(v.limits?.[0]?.amount).toBe(5000);
    expect(v.usage?.[0]?.used).toBe(12);
  });
});

describe('sessions.touch', () => {
  it('POSTs with no body and decodes extended + idle_expires_at', async () => {
    const { client, calls } = mockFetch([
      {
        body: {
          object: 'session',
          id: 'sess_1',
          user_id: 'user_1',
          status: 'active',
          last_active_organization_id: null,
          impersonated_by: null,
          last_active_at: 1,
          expire_at: 3,
          abandon_at: 2,
          idle_expires_at: 2,
          created_at: 0,
          extended: true,
        },
      },
    ]);
    const s = await client.sessions.touch('sess_1');
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${API_URL}/v1/sessions/sess_1/touch` });
    expect(calls[0]!.body).toBeUndefined();
    expect(s.extended).toBe(true);
    expect(s.idle_expires_at).toBe(2);
  });

  it('surfaces 409 SESSION_IDLE_EXPIRED', async () => {
    const { client } = mockFetch([{ status: 409, body: { errors: [{ code: 'SESSION_IDLE_EXPIRED', message: 'timed out' }] } }]);
    const err = await client.sessions.touch('sess_1').catch((e) => e);
    expect(err).toBeInstanceOf(AtlasApiError);
    expect(err.code).toBe(AtlasErrorCodes.SESSION_IDLE_EXPIRED);
  });
});

describe('notify on user create and import', () => {
  it('users.create forwards notify', async () => {
    const { client, calls } = mockFetch([{ status: 201, body: { object: 'user', id: 'user_1' } }]);
    await client.users.create({ email_address: 'a@b.test', notify: false });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${API_URL}/v1/users` });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ email_address: 'a@b.test', notify: false });
  });

  it('importExport.importUsers forwards notify', async () => {
    const { client, calls } = mockFetch([{ status: 201, body: { object: 'job', id: 'job_1' } }]);
    await client.importExport.importUsers({ users: [{ email_address: 'a@b.test' }], notify: true });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${API_URL}/v1/user_imports` });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ users: [{ email_address: 'a@b.test' }], notify: true });
  });
});

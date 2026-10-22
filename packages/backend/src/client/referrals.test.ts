import { describe, expect, it, vi } from 'vitest';
import { AtlasApiError, AtlasErrorCodes, createAtlasClient } from './index';

const API_URL = 'https://api.example.test';

function mockFetch(body: unknown = { object: 'x' }, status = 200) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v as string;
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers, body: init?.body });
    return new Response(JSON.stringify(body), { status });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

type Bapi = ReturnType<typeof createAtlasClient>;

// [method, path+query, expected JSON body (undefined = none), call]
const OPS: Array<[string, string, unknown, (c: Bapi) => Promise<unknown>]> = [
  ['GET', '/v1/instance/referrals', undefined, (c) => c.referrals.get()],
  [
    'PATCH',
    '/v1/instance/referrals',
    { enabled: true, endpoint_url: 'https://referrals.example.com/atlas', signing_secret: 'x'.repeat(32), security: { on_high_risk: 'hold' } },
    (c) =>
      c.referrals.update({
        enabled: true,
        endpoint_url: 'https://referrals.example.com/atlas',
        signing_secret: 'x'.repeat(32),
        security: { on_high_risk: 'hold' },
      }),
  ],
  ['PATCH', '/v1/instance/referrals', { link_template: null }, (c) => c.referrals.update({ link_template: null })],
  [
    'PATCH',
    '/v1/instance/referrals',
    { inbound_secret: 'whsec_' + 'y'.repeat(32), inbound_endpoint_id: 'we_1' },
    (c) => c.referrals.update({ inbound_secret: 'whsec_' + 'y'.repeat(32), inbound_endpoint_id: 'we_1' }),
  ],
  [
    'PATCH',
    '/v1/instance/referrals',
    { inbound_secret: null, inbound_endpoint_id: null },
    (c) => c.referrals.update({ inbound_secret: null, inbound_endpoint_id: null }),
  ],
  [
    'PATCH',
    '/v1/instance/referrals',
    { browser_sources: ['rewardful', 'dub'], consent_provider: 'onetrust' },
    (c) => c.referrals.update({ browser_sources: ['rewardful', 'dub'], consent_provider: 'onetrust' }),
  ],
  ['PATCH', '/v1/instance/referrals', { browser_sources: null }, (c) => c.referrals.update({ browser_sources: null })],
  ['POST', '/v1/instance/referrals/test', undefined, (c) => c.referrals.test()],
  ['GET', '/v1/instance/referrals/calls', undefined, (c) => c.referrals.listCalls()],
  [
    'GET',
    '/v1/instance/referrals/calls?limit=10&status=failed&kind=signup&user_id=user_1',
    undefined,
    (c) => c.referrals.listCalls({ limit: 10, status: 'failed', kind: 'signup', user_id: 'user_1' }),
  ],
  ['POST', '/v1/instance/referrals/calls/rfc_1/retry', undefined, (c) => c.referrals.retryCall('rfc_1')],
  ['POST', '/v1/users/user_1/referral/flag', { reason: 'self-referral ring' }, (c) => c.users.flagReferral('user_1', { reason: 'self-referral ring' })],
  ['POST', '/v1/users/user_1/referral/flag', {}, (c) => c.users.flagReferral('user_1')],
  [
    'POST',
    '/v1/users',
    { email_address: 'a@example.com', referral: { code: 'ACME10', click_id: 'clk_123' }, referral_code: 'ada-1' },
    (c) => c.users.create({ email_address: 'a@example.com', referral: { code: 'ACME10', click_id: 'clk_123' }, referral_code: 'ada-1' }),
  ],
  ['PATCH', '/v1/users/user_1', { referral_code: null }, (c) => c.users.update('user_1', { referral_code: null })],
  // v2
  ['PATCH', '/v1/users/user_1', { external_id: 'usr_8812' }, (c) => c.users.setExternalId('user_1', 'usr_8812')],
  ['PATCH', '/v1/users/user_1', { external_id: null }, (c) => c.users.setExternalId('user_1', null)],
  ['GET', '/v1/users/user_1/referral', undefined, (c) => c.referrals.getForUser('user_1')],
  ['POST', '/v1/instance/referrals/calls/retry_failed', {}, (c) => c.referrals.retryFailed()],
  ['POST', '/v1/instance/referrals/calls/retry_failed', { error_code: 'signature_rejected' }, (c) => c.referrals.retryFailed({ error_code: 'signature_rejected' })],
  ['POST', '/v1/instance/referrals/simulate', { code: 'WJXQGLBW' }, (c) => c.referrals.simulate({ code: 'WJXQGLBW' })],
  ['POST', '/v1/instance/referrals/simulate', {}, (c) => c.referrals.simulate()],
  [
    'POST',
    '/v1/instance/referrals/backfill',
    { since: '2026-01-01', codes: { usr_1: 'ABC123' }, code_metadata_path: 'public_metadata.referral_code' },
    (c) => c.referrals.backfill({ since: '2026-01-01', codes: { usr_1: 'ABC123' }, code_metadata_path: 'public_metadata.referral_code' }),
  ],
  ['GET', '/v1/instance/referrals/backfill/rbf_1', undefined, (c) => c.referrals.getBackfill('rbf_1')],
  ['GET', '/v1/instance/hooks/before_user_create', undefined, (c) => c.userHooks.getBeforeUserCreate()],
  [
    'PATCH',
    '/v1/instance/hooks/before_user_create',
    { enabled: true, url: 'https://app.example.com/hook', timeout_ms: 2000 },
    (c) => c.userHooks.updateBeforeUserCreate({ enabled: true, url: 'https://app.example.com/hook', timeout_ms: 2000 }),
  ],
  ['POST', '/v1/instance/hooks/before_user_create/test', undefined, (c) => c.userHooks.testBeforeUserCreate()],
  [
    'GET',
    '/v1/instance/referrals/calls?limit=1000&kind=alias&starting_after=rfc_9',
    undefined,
    (c) => c.referrals.listCalls({ limit: 1000, kind: 'alias', starting_after: 'rfc_9' }),
  ],
  [
    'PATCH',
    '/v1/instance/referrals',
    { provider: 'referally', endpoint_url: 'https://referrals.example.com', connection_id: 'conn_1', tracking_token: 'tt_1', forward_lifecycle: true, signup_code_field: true },
    (c) =>
      c.referrals.update({
        provider: 'referally',
        endpoint_url: 'https://referrals.example.com',
        connection_id: 'conn_1',
        tracking_token: 'tt_1',
        forward_lifecycle: true,
        signup_code_field: true,
      }),
  ],
];

describe('referral attribution operations', () => {
  it.each(OPS)('%s %s', async (method, path, body, call) => {
    const { impl, calls } = mockFetch();
    await call(createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: impl }));
    const c = calls[calls.length - 1]!;
    expect([c.method, c.url]).toEqual([method, `${API_URL}${path}`]);
    expect(c.body === undefined ? undefined : JSON.parse(c.body as string)).toEqual(body);
  });

  it('sends an idempotency key on the settings update, the retry and the flag', async () => {
    const { impl, calls } = mockFetch();
    const atlas = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: impl });
    await atlas.referrals.update({ enabled: false }, 'idem-1');
    await atlas.referrals.retryCall('rfc_1', 'idem-2');
    await atlas.users.flagReferral('user_1', {}, 'idem-3');
    expect(calls.map((c) => c.headers['idempotency-key'])).toEqual(['idem-1', 'idem-2', 'idem-3']);
  });

  it('decodes the settings, a call and the user referral fields', async () => {
    let m = mockFetch({
      object: 'referral_settings',
      enabled: true,
      provider: 'webhook',
      endpoint_url: 'https://referrals.example.com/atlas',
      program_id: null,
      connection_id: null,
      signing_secret_set: true,
      api_key_set: false,
      url_params: ['ref', 'via', 'aff'],
      context_cookie: null,
      consent_category: 'referrals',
      consent_fallback_category: 'marketing',
      auto_enroll_users: true,
      link_template: 'https://app.example.com/join?ref={code}',
      timeout_ms: 3000,
      security: { challenge_referred_signups: 'always', on_high_risk: 'flag', hold_until_email_verified: false, max_referred_signups_per_ip_hour: 5 },
      missing: [],
      connection: { last_test: { ok: true, at: 1, http_status: 404, error: null }, failed_calls_7d: 0, retrying_calls: 0, last_success_at: 1 },
      inbound: {
        url: 'https://api.example.test/v1/webhooks/referrals/ins_1',
        secret_set: false,
        endpoint_id: null,
        last_event: { at: 1700000000000, type: 'referral.updated', outcome: 'applied' },
      },
      browser_sources: ['referally', 'rewardful', 'tolt', 'promotekit', 'firstpromoter', 'partnerstack', 'dub'],
      browser_sources_default: true,
      consent_provider: 'auto',
      providers: [
        {
          id: 'webhook',
          name: 'Atlas referral protocol (any platform)',
          capabilities: { signup: true, erase: true, export: true, partner: true, auto_enroll: true, signal: true, inbound: true },
          needs: ['endpoint_url', 'signing_secret'],
          default_context_cookie: null,
          docs_url: null,
        },
      ],
      updated_at: 1,
    });
    const settings = await createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: m.impl }).referrals.get();
    expect(settings.security.on_high_risk).toBe('flag');
    expect(settings.providers[0]!.capabilities.signal).toBe(true);
    expect(settings.connection?.last_test?.http_status).toBe(404);
    expect(settings.providers[0]!.capabilities.inbound).toBe(true);
    expect(settings.inbound?.url).toBe('https://api.example.test/v1/webhooks/referrals/ins_1');
    expect(settings.inbound?.secret_set).toBe(false);
    expect(settings.inbound?.last_event?.outcome).toBe('applied');
    expect(settings.browser_sources).toHaveLength(7);
    expect(settings.browser_sources_default).toBe(true);
    expect(settings.consent_provider).toBe('auto');

    m = mockFetch({
      object: 'referral_call',
      id: 'rfc_1',
      kind: 'signup',
      status: 'succeeded',
      outcome: 'referred',
      customer_ref: 'user_1',
      user_id: 'user_1',
      http_status: 200,
      last_error: null,
      attempts: 2,
      next_attempt_at: null,
      risk: { level: 'low', score: 5, signals: [], captcha: 'passed', emailVerified: true },
      payload: { customerRef: 'user_1' },
      created_at: 1,
      updated_at: 2,
    });
    const call = await createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: m.impl }).referrals.retryCall('rfc_1');
    expect(call.risk?.emailVerified).toBe(true);

    m = mockFetch({
      object: 'user',
      id: 'user_1',
      referral: { partner_id: 'pn_1', referrer_external_id: 'cust_9', referrer_user_id: 'user_9', matched_via: 'code', status: 'lead', risk_level: 'low', flagged: false },
      referral_code: 'ada-1',
      referral_link: 'https://app.example.com/join?ref=ada-1',
    });
    const user = await createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: m.impl }).users.get('user_1');
    expect(user.referral?.referrer_user_id).toBe('user_9');
    expect(user.referral_link).toContain('ada-1');
  });

  it('surfaces the referral error codes', async () => {
    expect(AtlasErrorCodes.REFERRALS_NOT_CONFIGURED).toBe('REFERRALS_NOT_CONFIGURED');
    expect(AtlasErrorCodes.REFERRAL_CODE_TAKEN).toBe('REFERRAL_CODE_TAKEN');
    const m = mockFetch({ errors: [{ code: 'REFERRAL_CODE_TAKEN', message: 'taken', param: 'referral_code' }] }, 409);
    const err = await createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: m.impl })
      .users.update('user_1', { referral_code: 'ada-1' })
      .then(
        () => null,
        (e: unknown) => e as AtlasApiError,
      );
    expect(err).toBeInstanceOf(AtlasApiError);
    expect(err?.status).toBe(409);
    expect(err?.code).toBe(AtlasErrorCodes.REFERRAL_CODE_TAKEN);
  });
});

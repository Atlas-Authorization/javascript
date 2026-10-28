import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

const SECRET = 'sk_test_placeholder_not_a_real_key';
const API_URL = 'https://api.example.test';

function mockFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> =
    [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v as string;
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers, body: init?.body });
    const payload = spec?.body === undefined ? '' : JSON.stringify(spec.body);
    return new Response(payload, { status: spec?.status ?? 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const client = (f: typeof fetch) => createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: f });
const last = <T>(xs: T[]): T => xs[xs.length - 1]!;
const json = (body: unknown) => JSON.parse(body as string);

describe('instance preflight', () => {
  it('reads typed findings', async () => {
    const report = {
      object: 'preflight',
      ok: false,
      checked_at: 1,
      findings: [
        {
          severity: 'error',
          code: 'oauth_provider_missing_credentials',
          message: 'Google is enabled without a client secret.',
          fix: 'Add the client secret.',
          subject: { provider: 'google' },
        },
      ],
    };
    const { impl, calls } = mockFetch([{ body: report }]);
    const r = await client(impl).instance.preflight();
    expect([last(calls).method, last(calls).url]).toEqual(['GET', `${API_URL}/v1/instance/preflight`]);
    expect(r.ok).toBe(false);
    expect(r.findings[0]!.severity).toBe('error');
    expect(r.findings[0]!.subject).toEqual({ provider: 'google' });
  });
});

describe('instance cookie consent', () => {
  it('gets, sets and deletes', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'cookie_consent', enabled: true } }]);
    const c = client(impl);
    await c.instance.cookieConsent.get();
    expect([last(calls).method, last(calls).url]).toEqual(['GET', `${API_URL}/v1/instance/cookie_consent`]);
    const body = {
      script_url: 'https://cmp.example/consent.js',
      site_id: 'site_1',
      blocking_mode: 'auto',
      extra_origins: ['https://api.cmp.example'],
    };
    await c.instance.cookieConsent.set(body);
    expect(last(calls).method).toBe('PUT');
    expect(json(last(calls).body)).toEqual(body);
    await c.instance.cookieConsent.delete();
    expect([last(calls).method, last(calls).url]).toEqual(['DELETE', `${API_URL}/v1/instance/cookie_consent`]);
  });
});

describe('oauth providers (filters, display overrides, wallet settings)', () => {
  it('passes provider and configured filters', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'list', data: [] } }]);
    const c = client(impl);
    await c.oauthProviders.list({ provider: ['google', 'github'], configured: true });
    expect(last(calls).url).toBe(
      `${API_URL}/v1/oauth_providers?provider=google%2Cgithub&configured=true`,
    );
    await c.oauthProviders.list();
    expect(last(calls).url).toBe(`${API_URL}/v1/oauth_providers`);
  });

  it('upserts display_name, icon_url, mode and nullable wallet settings', async () => {
    const { impl, calls } = mockFetch([
      {
        body: {
          object: 'oauth_provider',
          provider: 'siwe',
          configured: true,
          enabled: false,
          setting_values: { domain: 'acme.test' },
          updated_fields: ['settings'],
        },
      },
    ]);
    const c = client(impl);
    const r = await c.oauthProviders.upsert('siwe', {
      settings: { domain: 'acme.test', chain_ids: [1, 10], rpc_url: null },
      display_name: 'Ethereum',
      icon_url: null,
      mode: '',
    });
    expect(r.setting_values).toEqual({ domain: 'acme.test' });
    expect(last(calls).method).toBe('PUT');
    expect(last(calls).url).toBe(`${API_URL}/v1/oauth_providers/siwe`);
    expect(json(last(calls).body)).toEqual({
      settings: { domain: 'acme.test', chain_ids: [1, 10], rpc_url: null },
      display_name: 'Ethereum',
      icon_url: null,
      mode: '',
    });
  });
});

describe('ATL track: preflight filters, unknown fields report, OpenAPI diff, singleton reads', () => {
  it('passes min_severity and include_suppressed and types the suppressed list', async () => {
    const { impl, calls } = mockFetch([
      { body: { object: 'preflight', ok: true, checked_at: 1, min_severity: 'warning', findings: [], suppressed: [{ code: 'allowed_origin_session_cookie_unreachable', severity: 'info', subject: null, reason: 'redirect' }], integrations: [] } },
    ]);
    const r = await client(impl).instance.preflight({ min_severity: 'warning', include_suppressed: true });
    expect(last(calls).url).toBe(`${API_URL}/v1/instance/preflight?min_severity=warning&include_suppressed=true`);
    expect(r.suppressed![0]!.reason).toBe('redirect');
  });

  it('reads the unknown fields report and the OpenAPI diff', async () => {
    const { impl, calls } = mockFetch([
      { body: { object: 'unknown_fields_report', days: 7, retention_days: 90, strict_request_bodies: false, safe_to_enable_strict: true, data: [] } },
      { body: { object: 'openapi_diff', since: '2026-10-15', version: '2026-10-23+abc1234', added: [], deprecated: [], removed: [] } },
    ]);
    const c = client(impl);
    expect((await c.instance.unknownFieldsReport({ days: 7 })).safe_to_enable_strict).toBe(true);
    expect(last(calls).url).toBe(`${API_URL}/v1/instance/unknown_fields_report?days=7`);
    expect((await c.instance.openapiDiff({ since: '2026-10-15' })).version).toContain('+');
    expect(last(calls).url).toBe(`${API_URL}/v1/openapi/diff?since=2026-10-15`);
  });

  it('reads one messaging channel, configured or not', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'messaging_provider', configured: false, channel: 'email' } }]);
    const r = await client(impl).messaging.channel('email');
    expect(last(calls).url).toBe(`${API_URL}/v1/messaging_providers/email`);
    expect('configured' in r && r.configured === false).toBe(true);
  });
});

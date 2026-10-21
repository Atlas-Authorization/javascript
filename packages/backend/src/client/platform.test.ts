import { describe, expect, it, vi } from 'vitest';
import { createAtlasPlatformClient } from './index';

const PLATFORM_KEY = 'psk_test_placeholder_not_a_real_key';
const API_URL = 'https://api.example.test';

function mockFetch(
  responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>,
) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
  }> = [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v as string;
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers, body: init?.body });
    const status = spec?.status ?? 200;
    const payload = spec?.body === undefined ? '' : JSON.stringify(spec.body);
    return new Response(payload, { status, headers: spec?.headers });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function platform(fetchImpl: typeof fetch, extra: { strict?: boolean } = {}) {
  return createAtlasPlatformClient({
    platformKey: PLATFORM_KEY,
    apiUrl: API_URL,
    fetch: fetchImpl,
    ...extra,
  });
}

const last = <T>(xs: T[]): T => xs[xs.length - 1]!;
const json = (body: unknown) => JSON.parse(body as string);

describe('createAtlasPlatformClient', () => {
  it('requires a platform key', () => {
    expect(() => createAtlasPlatformClient({ platformKey: '' })).toThrow(/platformKey/);
  });

  it('authenticates with the platform key as a bearer', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'list', data: [], has_more: false } }]);
    await platform(impl).apps.list();
    expect(last(calls).headers.authorization).toBe(`Bearer ${PLATFORM_KEY}`);
    expect(last(calls).url).toBe(`${API_URL}/v1/platform/apps`);
  });
});

describe('platform apps', () => {
  it('maps every app operation to its method and path', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'app', id: 'ins_1' } }]);
    const p = platform(impl);

    await p.apps.list({ tag: 'probe', include_archived: true });
    expect(last(calls).url).toBe(`${API_URL}/v1/platform/apps?tag=probe&include_archived=true`);

    await p.apps.create({ name: 'Acme', environment: 'production', create_development_sibling: false }, 'idem-1');
    expect(last(calls).method).toBe('POST');
    expect(last(calls).url).toBe(`${API_URL}/v1/platform/apps`);
    expect(last(calls).headers['idempotency-key']).toBe('idem-1');
    expect(json(last(calls).body)).toEqual({
      name: 'Acme',
      environment: 'production',
      create_development_sibling: false,
    });

    await p.apps.get('ins_1');
    expect([last(calls).method, last(calls).url]).toEqual(['GET', `${API_URL}/v1/platform/apps/ins_1`]);

    await p.apps.update('ins_1', { tags: ['a'] });
    expect(last(calls).method).toBe('PATCH');
    expect(json(last(calls).body)).toEqual({ tags: ['a'] });

    await p.apps.delete('ins_1');
    expect([last(calls).method, last(calls).url]).toEqual(['DELETE', `${API_URL}/v1/platform/apps/ins_1`]);

    await p.apps.bulkDelete(['ins_1', 'ins_2']);
    expect(last(calls).url).toBe(`${API_URL}/v1/platform/apps/bulk_delete`);
    expect(json(last(calls).body)).toEqual({ ids: ['ins_1', 'ins_2'] });

    await p.apps.archive('ins_1');
    expect(last(calls).url).toBe(`${API_URL}/v1/platform/apps/ins_1/archive`);
    await p.apps.unarchive('ins_1');
    expect(last(calls).url).toBe(`${API_URL}/v1/platform/apps/ins_1/unarchive`);

    await p.apps.rotateSecret('ins_1', { overlap_seconds: 0 });
    expect(last(calls).url).toBe(`${API_URL}/v1/platform/apps/ins_1/rotate_secret`);
    expect(json(last(calls).body)).toEqual({ overlap_seconds: 0 });

    await p.apps.secretKeys('ins_1');
    expect([last(calls).method, last(calls).url]).toEqual([
      'GET',
      `${API_URL}/v1/platform/apps/ins_1/secret_keys`,
    ]);

    await p.apps.instances.list('ins_1');
    expect(last(calls).url).toBe(`${API_URL}/v1/platform/apps/ins_1/instances`);
    await p.apps.instances.create('ins_1', { environment: 'development' });
    expect(last(calls).method).toBe('POST');
    expect(json(last(calls).body)).toEqual({ environment: 'development' });
    await p.apps.instances.rotateSecret('ins_1', 'ins_2');
    expect(last(calls).url).toBe(`${API_URL}/v1/platform/apps/ins_1/instances/ins_2/rotate_secret`);
    await p.apps.instances.rotateSecret('ins_1', 'ins_2', { overlap_seconds: 3600 }, 'idem_1');
    expect(json(last(calls).body)).toEqual({ overlap_seconds: 3600 });
    expect(last(calls).headers['idempotency-key']).toBe('idem_1');
    // The 0.9 signature: the third argument is the idempotency key.
    await p.apps.instances.rotateSecret('ins_1', 'ins_2', 'idem_2');
    expect(last(calls).body).toBeUndefined();
    expect(last(calls).headers['idempotency-key']).toBe('idem_2');

    await p.apps.transfer('ins_1');
    expect(last(calls).url).toBe(`${API_URL}/v1/platform/apps/ins_1/transfer`);
    await p.apps.acceptTransfer('tt_1');
    expect(last(calls).url).toBe(`${API_URL}/v1/platform/apps/accept_transfer`);
    expect(json(last(calls).body)).toEqual({ transfer_token: 'tt_1' });
    await p.apps.claim('ct_1');
    expect(last(calls).url).toBe(`${API_URL}/v1/platform/apps/claim`);
    expect(json(last(calls).body)).toEqual({ claim_token: 'ct_1' });

    await p.accountlessApps.create({ name: 'Draft' });
    expect(last(calls).url).toBe(`${API_URL}/v1/platform/accountless_apps`);
    expect(json(last(calls).body)).toEqual({ name: 'Draft' });
  });

  it('decodes the create response with its sibling instance', async () => {
    const created = {
      object: 'app',
      id: 'ins_p',
      name: 'Acme',
      environment: 'production',
      secret: 'sk_live_x',
      sibling_instance: { object: 'app', id: 'ins_d', environment: 'development', secret: 'sk_test_y' },
    };
    const { impl } = mockFetch([{ status: 201, body: created }]);
    const app = await platform(impl).apps.create({ name: 'Acme' });
    expect(app.secret).toBe('sk_live_x');
    expect(app.sibling_instance?.id).toBe('ins_d');
  });
});

describe('Sign in with Atlas apps', () => {
  it('creates an app with logout URIs and branding', async () => {
    const { impl, calls } = mockFetch([
      { status: 201, body: { object: 'atlas_id_app', id: 'app_1', client_secret: 'oacs_x' } },
    ]);
    const body = {
      name: 'Acme',
      redirect_uris: ['https://acme.test/cb'],
      post_logout_redirect_uris: ['https://acme.test/'],
      backchannel_logout_uri: 'https://acme.test/bcl',
      backchannel_logout_session_required: true,
      frontchannel_logout_uri: 'https://acme.test/fcl',
      frontchannel_logout_session_required: false,
      branding: {
        theme: 'dark' as const,
        accent_color: '#4F46E5',
        background_color: null,
        privacy_policy_url: 'https://acme.test/privacy',
        terms_of_service_url: 'https://acme.test/terms',
        copy: { sign_in_title: 'Welcome back', support_label: 'Help' },
        design: { preset: 'midnight' as const, palette: { primary: '#4F46E5' } },
      },
    };
    const app = await platform(impl).atlasIdApps.create(body);
    expect(app.client_secret).toBe('oacs_x');
    expect(last(calls).method).toBe('POST');
    expect(last(calls).url).toBe(`${API_URL}/v1/platform/atlas_id_apps`);
    expect(json(last(calls).body)).toEqual(body);
  });

  it('maps list/get/update/delete/rotate/preview', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'atlas_id_app', id: 'app_1' } }]);
    const p = platform(impl);
    await p.atlasIdApps.list();
    expect([last(calls).method, last(calls).url]).toEqual(['GET', `${API_URL}/v1/platform/atlas_id_apps`]);
    await p.atlasIdApps.get('app_1');
    expect(last(calls).url).toBe(`${API_URL}/v1/platform/atlas_id_apps/app_1`);
    await p.atlasIdApps.update('app_1', {
      post_logout_redirect_uris: [],
      backchannel_logout_uri: null,
      branding: { design: { palette: { primary: null } } },
    });
    expect(last(calls).method).toBe('PATCH');
    expect(json(last(calls).body)).toEqual({
      post_logout_redirect_uris: [],
      backchannel_logout_uri: null,
      branding: { design: { palette: { primary: null } } },
    });
    await p.atlasIdApps.delete('app_1');
    expect([last(calls).method, last(calls).url]).toEqual([
      'DELETE',
      `${API_URL}/v1/platform/atlas_id_apps/app_1`,
    ]);
    await p.atlasIdApps.rotateSecret('app_1');
    expect(last(calls).url).toBe(`${API_URL}/v1/platform/atlas_id_apps/app_1/rotate_secret`);
    await p.atlasIdApps.rotateSecret('app_1', { overlap_seconds: 0 });
    expect(json(last(calls).body)).toEqual({ overlap_seconds: 0 });
    await p.atlasIdApps.previewDesign({ preset: 'glass' });
    expect(last(calls).url).toBe(`${API_URL}/v1/platform/atlas_id_apps/design/preview`);
    expect(json(last(calls).body)).toEqual({ design: { preset: 'glass' } });
  });
});

describe('platform design assets', () => {
  it('uploads raw bytes with the image content type and kind', async () => {
    const { impl, calls } = mockFetch([
      { status: 201, body: { object: 'design_asset', asset_id: 'dasset_1', kind: 'logo' } },
    ]);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const asset = await platform(impl).designAssets.upload(bytes, {
      kind: 'logo',
      contentType: 'image/png',
    });
    expect(asset.asset_id).toBe('dasset_1');
    const call = last(calls);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${API_URL}/v1/platform/design/assets?kind=logo`);
    expect(call.headers['content-type']).toBe('image/png');
    expect(call.body).toBe(bytes);
  });

  it('lists and deletes', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'list', data: [] } }]);
    const p = platform(impl);
    await p.designAssets.list();
    expect([last(calls).method, last(calls).url]).toEqual(['GET', `${API_URL}/v1/platform/design/assets`]);
    await p.designAssets.delete('dasset_1');
    expect([last(calls).method, last(calls).url]).toEqual([
      'DELETE',
      `${API_URL}/v1/platform/design/assets/dasset_1`,
    ]);
  });
});

describe('platform strict bodies', () => {
  it('sends Atlas-Strict on writes when strict is set, not on reads', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'app', id: 'ins_1' } }]);
    const p = platform(impl, { strict: true });
    await p.apps.update('ins_1', { name: 'x' });
    expect(last(calls).headers['atlas-strict']).toBe('true');
    await p.apps.get('ins_1');
    expect(last(calls).headers['atlas-strict']).toBeUndefined();
  });

  it('withOptions overrides strict for the calls made through it', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'app', id: 'ins_1' } }]);
    const p = platform(impl);
    await p.apps.update('ins_1', { name: 'x' });
    expect(last(calls).headers['atlas-strict']).toBeUndefined();
    await p.withOptions({ strict: true }).apps.update('ins_1', { name: 'x' });
    expect(last(calls).headers['atlas-strict']).toBe('true');
    await p.withOptions({ strict: false }).apps.update('ins_1', { name: 'x' });
    expect(last(calls).headers['atlas-strict']).toBe('false');
  });

  it('reports ignored fields through onUnknownFields', async () => {
    const { impl } = mockFetch([
      { body: { object: 'app', id: 'ins_1' }, headers: { 'Atlas-Unknown-Fields': 'nmae, tags.x' } },
    ]);
    const seen: unknown[] = [];
    const p = createAtlasPlatformClient({
      platformKey: PLATFORM_KEY,
      apiUrl: API_URL,
      fetch: impl,
      onUnknownFields: (e) => seen.push(e),
    });
    await p.apps.update('ins_1', { name: 'x' });
    expect(seen).toEqual([
      { method: 'PATCH', path: '/v1/platform/apps/ins_1', fields: ['nmae', 'tags.x'] },
    ]);
  });
});

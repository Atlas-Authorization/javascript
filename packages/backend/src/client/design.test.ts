import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient, type AtlasDesign, type AtlasDesignPatch } from './index';

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

const design: AtlasDesign = {
  preset: 'atlas',
  colorScheme: 'auto',
  palette: { primary: '#4F46E5', primaryInk: '#FFFFFF' },
  typography: { font: 'inter', baseSize: 15, scale: 'major-third' },
  layout: { position: 'split', splitImageSide: 'left', logoPlacement: 'card' },
  background: {
    gradient: { type: 'linear', angle: 135, stops: [{ color: '#000000', at: 0 }, { color: '#FFFFFF', at: 100 }] },
    image: { assetId: 'dasset_01HZZZZZZZZZZZZZZZZZZZZZZZ', fit: 'cover', overlay: { color: '#000000', opacity: 0.4 } },
  },
  logo: { assetId: 'dasset_01HZZZZZZZZZZZZZZZZZZZZZZZ' },
};

describe('instance design', () => {
  it('reads, replaces, patches and previews', async () => {
    const settings = {
      object: 'design',
      design,
      resolved: { preset: 'atlas' },
      warnings: [
        {
          code: 'low_contrast',
          mode: 'light',
          pair: ['primary', 'primaryInk'],
          ratio: 2.1,
          required: 4.5,
          path: 'palette.primaryInk',
          message: 'Low contrast.',
        },
      ],
      legacy: false,
    };
    const { impl, calls } = mockFetch([{ body: settings }]);
    const c = client(impl);

    const got = await c.design.get();
    expect([last(calls).method, last(calls).url]).toEqual(['GET', `${API_URL}/v1/instance/design`]);
    expect(got.warnings[0]!.path).toBe('palette.primaryInk');

    await c.design.replace(design);
    expect(last(calls).method).toBe('PUT');
    expect(json(last(calls).body)).toEqual({ design });

    const patch: AtlasDesignPatch = { palette: { primary: null }, background: null };
    await c.design.update(patch);
    expect(last(calls).method).toBe('PATCH');
    expect(last(calls).url).toBe(`${API_URL}/v1/instance/design`);
    expect(json(last(calls).body)).toEqual({ design: { palette: { primary: null }, background: null } });

    await c.design.preview({ preset: 'glass' });
    expect([last(calls).method, last(calls).url]).toEqual([
      'POST',
      `${API_URL}/v1/instance/design/preview`,
    ]);
    expect(json(last(calls).body)).toEqual({ design: { preset: 'glass' } });
  });
});

describe('organization design', () => {
  it('reads, replaces and patches the override', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'organization_design', organization_id: 'org_1' } }]);
    const c = client(impl);
    await c.design.organizations.get('org_1');
    expect([last(calls).method, last(calls).url]).toEqual(['GET', `${API_URL}/v1/organizations/org_1/design`]);
    await c.design.organizations.replace('org_1', {});
    expect(last(calls).method).toBe('PUT');
    expect(json(last(calls).body)).toEqual({ design: {} });
    await c.design.organizations.update('org_1', { card: { style: 'glass', blur: 12 } });
    expect(last(calls).method).toBe('PATCH');
    expect(json(last(calls).body)).toEqual({ design: { card: { style: 'glass', blur: 12 } } });
  });
});

describe('design assets', () => {
  it('uploads raw bytes with a content type and ?kind=', async () => {
    const { impl, calls } = mockFetch([
      { status: 201, body: { object: 'design_asset', asset_id: 'dasset_1', kind: 'background' } },
    ]);
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]).buffer;
    const asset = await client(impl).design.assets.upload(bytes, {
      kind: 'background',
      contentType: 'image/jpeg',
    });
    expect(asset.asset_id).toBe('dasset_1');
    const call = last(calls);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${API_URL}/v1/design/assets?kind=background`);
    expect(call.headers['content-type']).toBe('image/jpeg');
    expect(call.body).toBe(bytes);
  });

  it("uses a Blob's own type when no content type is given", async () => {
    const { impl, calls } = mockFetch([{ status: 201, body: { object: 'design_asset' } }]);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
    await client(impl).design.assets.upload(blob);
    expect(last(calls).url).toBe(`${API_URL}/v1/design/assets`);
    expect(last(calls).headers['content-type']).toBe('image/webp');
  });

  it('refuses an upload with no content type', async () => {
    const { impl } = mockFetch([{ body: {} }]);
    await expect(client(impl).design.assets.upload(new Uint8Array([1]))).rejects.toThrow(/contentType/);
  });

  it('lists, deletes and reads the catalog', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'list', data: [] } }]);
    const c = client(impl);
    await c.design.assets.list();
    expect([last(calls).method, last(calls).url]).toEqual(['GET', `${API_URL}/v1/design/assets`]);
    await c.design.assets.delete('dasset_1');
    expect([last(calls).method, last(calls).url]).toEqual(['DELETE', `${API_URL}/v1/design/assets/dasset_1`]);
    await c.design.catalog();
    expect([last(calls).method, last(calls).url]).toEqual(['GET', `${API_URL}/v1/design/catalog`]);
  });
});

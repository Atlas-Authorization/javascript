import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

const SECRET = 'sk_test_placeholder_not_a_real_key';
const API_URL = 'https://api.example.test';

function setup(body: unknown = {}, status = 200) {
  const calls: Array<{ url: string; method: string; body?: string; headers: Record<string, string> }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v as string;
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined, headers });
    return new Response(JSON.stringify(body), { status });
  });
  const atlas = createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl as unknown as typeof fetch });
  return { atlas, last: () => calls[calls.length - 1]! };
}

describe('actionGallery', () => {
  it('lists with filters and reads one template', async () => {
    const { atlas, last } = setup({ object: 'list', data: [] });
    await atlas.actionGallery.list({ trigger: 'post_login', q: 'slack' });
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/action_gallery?trigger=post_login&q=slack`);
    await atlas.actionGallery.get('geo-fence');
    expect(last().url).toBe(`${API_URL}/v1/action_gallery/geo-fence`);
  });

  it('installs with secrets and an idempotency key', async () => {
    const { atlas, last } = setup({ object: 'action_gallery_install', missing_secrets: [] }, 201);
    const res = await atlas.actionGallery.install('slack-alert-on-admin-sign-in', { secrets: { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/x' } }, 'idem-1');
    expect(res.object).toBe('action_gallery_install');
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/action_gallery/slack-alert-on-admin-sign-in/install`);
    expect(JSON.parse(last().body!)).toEqual({ secrets: { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/x' } });
    expect(last().headers['idempotency-key']).toBe('idem-1');
  });

  it('lists installs and updates an installed action', async () => {
    const { atlas, last } = setup({ object: 'action_gallery_update', updated: true });
    await atlas.actionGallery.installs();
    expect(last().url).toBe(`${API_URL}/v1/action_gallery_installs`);
    await atlas.actionGallery.update('act_1', { secrets: { API_TOKEN: 't' } });
    expect(last().url).toBe(`${API_URL}/v1/actions/act_1/gallery_update`);
    expect(JSON.parse(last().body!)).toEqual({ secrets: { API_TOKEN: 't' } });
  });
});

describe('actionTemplates', () => {
  it('drives the authoring lifecycle', async () => {
    const { atlas, last } = setup({ object: 'action_template' });
    await atlas.actionTemplates.create({ slug: 'my-hook', name: 'My hook', author_name: 'Me', trigger: 'post_login', version: '1.0.0', code: 'x', submit: true });
    expect(last()).toMatchObject({ method: 'POST', url: `${API_URL}/v1/action_templates` });
    await atlas.actionTemplates.update('atpl_1', { summary: 'S' });
    expect(last()).toMatchObject({ method: 'PATCH', url: `${API_URL}/v1/action_templates/atpl_1` });
    await atlas.actionTemplates.addVersion('atpl_1', { version: '1.1.0', code: 'y', secrets: [{ name: 'A', description: '', required: true }] });
    expect(last()).toMatchObject({ method: 'POST', url: `${API_URL}/v1/action_templates/atpl_1/versions` });
    await atlas.actionTemplates.submitVersion('atpl_1', '1.1.0');
    expect(last().url).toBe(`${API_URL}/v1/action_templates/atpl_1/versions/1.1.0/submit`);
    await atlas.actionTemplates.deleteVersion('atpl_1', '1.1.0');
    expect(last()).toMatchObject({ method: 'DELETE', url: `${API_URL}/v1/action_templates/atpl_1/versions/1.1.0` });
    await atlas.actionTemplates.unlist('atpl_1');
    expect(last().url).toBe(`${API_URL}/v1/action_templates/atpl_1/unlist`);
    await atlas.actionTemplates.publish('atpl_1');
    expect(last().url).toBe(`${API_URL}/v1/action_templates/atpl_1/publish`);
    await atlas.actionTemplates.list();
    await atlas.actionTemplates.get('atpl_1');
    await atlas.actionTemplates.delete('atpl_1');
    expect(last()).toMatchObject({ method: 'DELETE', url: `${API_URL}/v1/action_templates/atpl_1` });
  });
});

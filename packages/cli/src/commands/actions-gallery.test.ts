import { describe, expect, it, vi } from 'vitest';
import type { ManagementClient, RunContext } from '../context';
import { MemoryConfigStore } from '../config';
import { captureIO, type CaptureIO } from '../io';
import { run } from '../run';

/** `atlas actions gallery | show | install | installs | update | publish` against a fake client. */
const ENTRY = {
  object: 'action_template',
  source: 'builtin',
  slug: 'slack-alert-on-admin-sign-in',
  name: 'Slack alert on admin sign-in',
  summary: 'Post to Slack.',
  trigger: 'post_login',
  category: 'notifications',
  tags: [],
  license: 'MIT',
  author: { name: 'Atlas', first_party: true },
  verified: true,
  featured: true,
  install_count: 3,
  latest_version: '1.0.0',
  uses_http: true,
  secrets: [{ name: 'SLACK_WEBHOOK_URL', description: 'Webhook URL.', required: true }],
  updated_at: null,
};
const ACTION = { object: 'action', id: 'act_9', name: 'Slack alert', trigger: 'post_login', code: 'x', runtime: 'node', enabled: false, secret_names: [], created_at: 0, updated_at: 0 };

function ctx(io: CaptureIO, client: Record<string, unknown>, files: Record<string, string> = {}): RunContext {
  return {
    io,
    env: {},
    config: new MemoryConfigStore({
      active_profile: 'default',
      profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } },
    }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => client as unknown as ManagementClient,
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  };
}

describe('actions gallery', () => {
  it('lists templates with the query and trigger', async () => {
    const io = captureIO();
    const list = vi.fn(async () => ({ object: 'list', data: [ENTRY] }));
    expect(await run(['actions', 'gallery', 'slack', 'alert', '--trigger', 'post_login'], ctx(io, { actionGallery: { list } }))).toBe(0);
    expect(list).toHaveBeenCalledWith({ q: 'slack alert', trigger: 'post_login' });
    expect(io.stdout()).toContain('slack-alert-on-admin-sign-in');
    expect(io.stdout()).toContain('yes');
  });

  it('show prints secrets and the code', async () => {
    const io = captureIO();
    const get = vi.fn(async () => ({ ...ENTRY, description: 'd', code: "api.http.post(event.secrets.SLACK_WEBHOOK_URL, {});", changelog: null, repository_url: null, versions: [] }));
    await run(['actions', 'show', 'slack-alert-on-admin-sign-in'], ctx(io, { actionGallery: { get } }));
    expect(io.stdout()).toContain('SLACK_WEBHOOK_URL (required)');
    expect(io.stdout()).toContain('  api.http.post(');
    expect(io.stdout()).toContain('Sends outbound HTTPS requests');
  });
});

describe('actions install / installs / update', () => {
  it('install reads secret values from the dotenv file, never argv', async () => {
    const io = captureIO();
    const install = vi.fn(async () => ({
      object: 'action_gallery_install',
      action: ACTION,
      template: { slug: ENTRY.slug, source: 'builtin', version: '1.0.0' },
      install_id: 'atpli_1',
      missing_secrets: [],
    }));
    const files = { '.env.slack': 'SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T/B/X\n' };
    await run(['actions', 'install', ENTRY.slug, '--secrets-file', '.env.slack', '--name', 'Admin alert'], ctx(io, { actionGallery: { install } }, files));
    expect(install).toHaveBeenCalledWith(ENTRY.slug, { name: 'Admin alert', secrets: { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X' } });
    expect(io.stdout()).toContain('DISABLED');
    expect(io.stdout()).not.toContain('hooks.slack.com');
  });

  it('install says which required secrets are still missing', async () => {
    const io = captureIO();
    const install = vi.fn(async () => ({
      object: 'action_gallery_install',
      action: ACTION,
      template: { slug: ENTRY.slug, source: 'builtin', version: '1.0.0' },
      install_id: 'atpli_1',
      missing_secrets: ['SLACK_WEBHOOK_URL'],
    }));
    await run(['actions', 'install', ENTRY.slug], ctx(io, { actionGallery: { install } }));
    expect(install).toHaveBeenCalledWith(ENTRY.slug, {});
    expect(io.stdout()).toContain('Still needs: SLACK_WEBHOOK_URL');
  });

  it('installs renders update status; update reports the move', async () => {
    const io = captureIO();
    const installsFn = vi.fn(async () => ({
      object: 'list',
      data: [
        {
          object: 'action_gallery_installation',
          action_id: 'act_9',
          action_name: 'Slack alert',
          enabled: true,
          trigger: 'post_login',
          source: 'community',
          template_slug: 'my-hook',
          installed_version: '1.0.0',
          latest_version: '1.1.0',
          update_available: true,
          missing_secrets: [],
          update_requires_secrets: [],
          installed_at: 0,
          updated_at: 0,
        },
      ],
    }));
    const update = vi.fn(async () => ({ object: 'action_gallery_update', updated: true, action: ACTION, from_version: '1.0.0', version: '1.1.0' }));
    const c = { actionGallery: { installs: installsFn, update } };
    await run(['actions', 'installs'], ctx(io, c));
    expect(io.stdout()).toContain('available');
    await run(['actions', 'update', 'act_9'], ctx(io, c));
    expect(update).toHaveBeenCalledWith('act_9', {});
    expect(io.stdout()).toContain('Updated act_9 from 1.0.0 to 1.1.0.');
  });
});

describe('actions publish', () => {
  const manifest = {
    slug: 'my-hook',
    name: 'My hook',
    author_name: 'Example Labs',
    summary: 'Does a thing.',
    trigger: 'post_login',
    license: 'MIT',
    version: '1.0.0',
    code_file: 'hook.js',
    secrets: [{ name: 'TOKEN', description: 'Token', required: true }],
  };
  const files = { 'tpl/template.json': JSON.stringify(manifest), [`${process.cwd()}/tpl/hook.js`]: "api.console.log('hi');" };

  it('creates a new template with its first version and submits it', async () => {
    const io = captureIO();
    const create = vi.fn(async () => ({ object: 'action_template' }));
    const list = vi.fn(async () => ({ object: 'list', data: [] }));
    await run(['actions', 'publish', 'tpl/template.json'], ctx(io, { actionTemplates: { list, create } }, files));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'my-hook', author_name: 'Example Labs', version: '1.0.0', code: "api.console.log('hi');", submit: true }),
    );
    expect(io.stdout()).toContain('submitted it for review');
  });

  it('adds a version to an existing template; --draft keeps it a draft', async () => {
    const io = captureIO();
    const list = vi.fn(async () => ({ object: 'list', data: [{ id: 'atpl_1', slug: 'my-hook' }] }));
    const updateFn = vi.fn(async () => ({}));
    const addVersion = vi.fn(async () => ({ object: 'action_template_version' }));
    await run(['actions', 'publish', 'tpl/template.json', '--draft'], ctx(io, { actionTemplates: { list, update: updateFn, addVersion } }, files));
    expect(addVersion).toHaveBeenCalledWith('atpl_1', expect.objectContaining({ version: '1.0.0', submit: false }));
    expect(io.stdout()).toContain('as a draft');
  });

  it('refuses a manifest without the required fields', async () => {
    const io = captureIO();
    const bad = { 'x.json': JSON.stringify({ slug: 'a-b-c' }) };
    expect(await run(['actions', 'publish', 'x.json'], ctx(io, {}, bad))).toBe(1);
    expect(io.stderr()).toContain('needs "name"');
  });
});

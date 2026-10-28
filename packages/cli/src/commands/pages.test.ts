import { describe, expect, it, vi } from 'vitest';
import type { ManagementClient, RunContext } from '../context';
import { MemoryConfigStore } from '../config';
import { captureIO, type CaptureIO } from '../io';
import { run } from '../run';

const DEF = { regions: { header: [{ type: 'text', text: 'Hello' }] } };
const STATE = { object: 'page_template', page: 'sign-in', live: null, draft: { version: 1, updated_at: 0, definition: DEF } };

function ctx(io: CaptureIO, pageTemplates: Record<string, ReturnType<typeof vi.fn>>, files: Record<string, string> = {}): RunContext {
  const client = { pageTemplates } as unknown as ManagementClient;
  return {
    io,
    env: {},
    config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => client,
    readFile: (path) => {
      const c = files[path];
      if (c === undefined) throw new Error(`ENOENT: ${path}`);
      return c;
    },
  };
}

describe('pages', () => {
  it('push saves the draft, and publishes it only with --promote', async () => {
    const saveDraft = vi.fn(async () => STATE);
    const promote = vi.fn(async () => STATE);
    const files = { 'tpl.json': JSON.stringify(DEF), 'wrapped.json': JSON.stringify({ definition: DEF }) };

    const io = captureIO();
    expect(await run(['pages', 'push', 'tpl.json', '--page', 'sign-in'], ctx(io, { saveDraft, promote }, files))).toBe(0);
    expect(saveDraft).toHaveBeenCalledWith('sign-in', DEF);
    expect(promote).not.toHaveBeenCalled();

    const io2 = captureIO();
    expect(await run(['pages', 'push', 'wrapped.json', '--page', 'sign-in', '--promote'], ctx(io2, { saveDraft, promote }, files))).toBe(0);
    expect(promote).toHaveBeenCalledWith('sign-in');
    expect(io2.stdout()).toContain('published');
  });

  it('refuses a missing page, a bad page and a file that is not a template', async () => {
    const files = { 'bad.json': '{"nope":1}', 'junk.json': 'not json' };
    for (const argv of [['pages', 'push', 'bad.json'], ['pages', 'push', 'bad.json', '--page', 'checkout'], ['pages', 'push', 'bad.json', '--page', 'sign-in'], ['pages', 'push', 'junk.json', '--page', 'sign-in']]) {
      const io = captureIO();
      expect(await run(argv, ctx(io, { saveDraft: vi.fn() }, files)), argv.join(' ')).not.toBe(0);
    }
  });

  it('preview prints the link, pull prints the definition, discard needs a status', async () => {
    const preview = vi.fn(async () => ({ object: 'page_template_preview', page: 'sign-in', url: 'https://x.test/hosted/sign-in?atlas_preview=t', expires_at: 0 }));
    const get = vi.fn(async () => ({ ...STATE, live: STATE.draft }));
    const discard = vi.fn(async () => STATE);

    const io = captureIO();
    expect(await run(['pages', 'preview', '--page', 'sign-in'], ctx(io, { preview }))).toBe(0);
    expect(io.stdout()).toContain('atlas_preview=t');

    const io2 = captureIO();
    expect(await run(['pages', 'pull', '--page', 'sign-in'], ctx(io2, { get }))).toBe(0);
    expect(JSON.parse(io2.stdout())).toEqual(DEF);

    expect(await run(['pages', 'discard', '--page', 'sign-in'], ctx(captureIO(), { discard }))).not.toBe(0);
    expect(await run(['pages', 'discard', '--page', 'sign-in', '--status', 'draft'], ctx(captureIO(), { discard }))).toBe(0);
    expect(discard).toHaveBeenCalledWith('sign-in', 'draft');
  });
});

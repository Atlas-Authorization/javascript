import { describe, expect, it, vi } from 'vitest';
import type { ManagementClient, RunContext } from '../context';
import { captureIO, type CaptureIO } from '../io';
import { MemoryConfigStore } from '../config';
import { run } from '../run';

const ctx = (io: CaptureIO, connections: Record<string, unknown>): RunContext => ({
  io,
  env: {},
  config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
  prompt: { text: async () => '', secret: async () => '' },
  makeClient: () => ({ connections }) as unknown as ManagementClient,
  readFile: () => '',
});

const RESULT = { object: 'connection_rehome', from_client: 'a', to_client: 'b', dry_run: false, same_app: false, moved: 1, would_move: 0, failed: 1, skipped: 0, data: [{ connection_id: 'c1', status: 'moved' }, { connection_id: 'c2', status: 'failed', reason: 'refresh_failed' }] };

describe('connections templates', () => {
  it('prints the templates and emits JSON under --json', async () => {
    const templates = vi.fn(async () => ({ object: 'list', data: [{ provider: 'discogs', kind: 'oauth1', flow: 'connect', secrets: ['consumer_key'], allowed_hosts: ['api.discogs.com'], signature: 'PLAINTEXT' }], has_more: false }));
    const io = captureIO();
    expect(await run(['connections', 'templates'], ctx(io, { templates }))).toBe(0);
    expect(io.stdout()).toMatch(/discogs\s+oauth1\s+connect/);
    const j = captureIO();
    expect(await run(['connections', 'templates', '--json'], ctx(j, { templates }))).toBe(0);
    expect(JSON.parse(j.stdout()).data[0].provider).toBe('discogs');
  });
});

describe('connections rehome', () => {
  it('needs --yes or --dry-run before anything is moved', async () => {
    const rehome = vi.fn();
    const io = captureIO();
    expect(await run(['connections', 'rehome', 'a', 'b'], ctx(io, { rehome }))).not.toBe(0);
    expect(rehome).not.toHaveBeenCalled();
    expect(io.stderr()).toMatch(/--yes/);
  });

  it('moves with --yes, passes connection ids, and exits non-zero when a connection did not move', async () => {
    const rehome = vi.fn(async () => RESULT);
    const io = captureIO();
    expect(await run(['connections', 'rehome', 'a', 'b', 'c1', 'c2', '--yes'], ctx(io, { rehome }))).toBe(1);
    expect(rehome).toHaveBeenCalledWith({ from_client: 'a', to_client: 'b', connection_ids: ['c1', 'c2'] });
    expect(io.stdout()).toMatch(/refresh_failed/);
  });

  it('--dry-run previews without --yes', async () => {
    const rehome = vi.fn(async () => ({ ...RESULT, dry_run: true, moved: 0, failed: 0, would_move: 2, data: [] }));
    const io = captureIO();
    expect(await run(['connections', 'rehome', 'a', 'b', '--dry-run'], ctx(io, { rehome }))).toBe(0);
    expect(rehome).toHaveBeenCalledWith({ from_client: 'a', to_client: 'b', dry_run: true });
    expect(io.stdout()).toMatch(/Would move 2/);
  });

  it('rejects an unknown subcommand', async () => {
    const io = captureIO();
    expect(await run(['connections', 'nope'], ctx(io, {}))).not.toBe(0);
    expect(io.stderr()).toMatch(/templates, rehome/);
  });
});

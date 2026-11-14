import { describe, expect, it, vi } from 'vitest';
import type { ManagementClient, RunContext } from '../context';
import { captureIO, type CaptureIO } from '../io';
import { MemoryConfigStore } from '../config';
import { run } from '../run';

const USAGE = {
  object: 'grant_usage',
  grant_type: 'machine',
  grant_id: 'mrg_1',
  machine_id: 'mch_1',
  live: true,
  counters: [{ counter: 'calls', limit: 10, window: 'day', amount_field: null, window_start: 0, resets_at: 86_400_000, used: 4, remaining: 6 }],
  leases: [{ id: 'ulse_1', counter: 'calls', amount: 3, expires_at: 60_000 }],
};

function ctx(io: CaptureIO, usage: ReturnType<typeof vi.fn>): RunContext {
  return {
    io,
    env: {},
    config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({ grantUsage: { usage } }) as unknown as ManagementClient,
    readFile: () => '',
  };
}

describe('grants usage', () => {
  it('prints counters and leases for a machine grant', async () => {
    const io = captureIO();
    const usage = vi.fn(async () => USAGE);
    expect(await run(['grants', 'usage', 'machine', 'mrg_1'], ctx(io, usage))).toBe(0);
    expect(usage).toHaveBeenCalledWith('machine', 'mrg_1');
    const out = io.stdout();
    expect(out).toContain('calls');
    expect(out).toContain('REMAINING');
    expect(out).toContain('ulse_1');
  });

  it('emits JSON under --json', async () => {
    const io = captureIO();
    expect(await run(['grants', 'usage', 'agent', 'g1', '--json'], ctx(io, vi.fn(async () => USAGE)))).toBe(0);
    expect(JSON.parse(io.stdout()).grant_id).toBe('mrg_1');
  });

  it('rejects an unknown grant type and a missing id without calling Atlas', async () => {
    const usage = vi.fn();
    const a = captureIO();
    expect(await run(['grants', 'usage', 'robot', 'x'], ctx(a, usage))).not.toBe(0);
    expect(a.stderr()).toMatch(/machine or agent/);
    const b = captureIO();
    expect(await run(['grants', 'usage', 'machine'], ctx(b, usage))).not.toBe(0);
    expect(b.stderr()).toMatch(/grant-id/);
    expect(usage).not.toHaveBeenCalled();
  });
});

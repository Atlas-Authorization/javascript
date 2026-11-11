import { describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';

describe('atlas init <template>', () => {
  const make = (exec: RunContext['exec']): RunContext => ({
    io: captureIO(),
    env: {},
    config: new MemoryConfigStore({ active_profile: 'default', profiles: {} }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    readFile: () => '',
    exec,
  });

  it('runs create-atlas-app with the template and the directory', async () => {
    const seen: Array<{ cmd: string; args: string[] }> = [];
    const code = await run(['init', 'nextjs-local-users', '--dir', 'shop'], make(async (cmd, args) => (seen.push({ cmd, args }), 0)));
    expect(code).toBe(0);
    expect(seen[0]!.cmd).toBe('npx');
    expect(seen[0]!.args).toEqual(expect.arrayContaining(['shop', '--template', 'nextjs-local-users']));
  });

  it('refuses an unknown template without running anything', async () => {
    const seen: string[] = [];
    const code = await run(['init', 'nope'], make(async (cmd) => (seen.push(cmd), 0)));
    expect(code).not.toBe(0);
    expect(seen).toEqual([]);
  });
});

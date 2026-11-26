import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('atlas init --next', () => {
  it('writes a Node, non-cached mount, the matcher exclusion and working commented config examples', async () => {
    const root = mkdtempSync(join(tmpdir(), 'init-next-'));
    const ctx: RunContext = {
      io: captureIO(),
      env: {},
      config: new MemoryConfigStore({ active_profile: 'default', profiles: {} }),
      prompt: { text: async () => '', secret: async () => '' },
      makeClient: () => ({}) as ManagementClient,
      readFile: () => '',
    };
    expect(await run(['init', '--next', '--dir', root], ctx)).toBe(0);
    const route = readFileSync(join(root, 'app', 'atlas', '[[...path]]', 'route.ts'), 'utf8');
    expect(route).toContain("export const runtime = 'nodejs';");
    expect(route).toContain("export const dynamic = 'force-dynamic';");
    expect(route).toContain('matcher:');
    const yaml = readFileSync(join(root, 'atlas.yaml'), 'utf8');
    expect(yaml).toContain('# redirect_urls:');
    expect(yaml).toContain('privacyUrl');
    expect(yaml).toContain('indented under instance:');
    expect(readFileSync(join(root, '.env.example'), 'utf8')).not.toContain('ATLAS_JWKS_URL=');
  });
});

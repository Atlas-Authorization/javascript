import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ManagementClient, RunContext } from '../context';
import { MemoryConfigStore } from '../config';
import { captureIO } from '../io';
import { run } from '../run';
import { mergeCodexToml, mergeJsonConfig } from './mcp';

/** `atlas mcp install`: writes each client's MCP config, keeping what is already there. */

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-mcp-project-'));
  home = mkdtempSync(join(tmpdir(), 'atlas-mcp-home-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function ctx(): RunContext & { io: ReturnType<typeof captureIO> } {
  return {
    io: captureIO(),
    env: { HOME: home },
    config: new MemoryConfigStore({ active_profile: 'default', profiles: {} }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    readFile: (p) => readFileSync(p, 'utf8'),
  };
}
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const ENTRY = { command: 'npx', args: ['-y', '@atlasauth/mcp'] };

describe('atlas mcp install', () => {
  it('writes Cursor, Claude Code, VS Code and Codex configs in one go', async () => {
    const c = ctx();
    const code = await run(['mcp', 'install', '--cursor', '--claude-code', '--vscode', '--codex', '--dir', dir], c);
    expect(code).toBe(0);
    expect(readJson(join(dir, '.cursor', 'mcp.json'))).toEqual({ mcpServers: { atlas: ENTRY } });
    expect(readJson(join(dir, '.mcp.json'))).toEqual({ mcpServers: { atlas: ENTRY } });
    expect(readJson(join(dir, '.vscode', 'mcp.json'))).toEqual({ servers: { atlas: { type: 'stdio', ...ENTRY } } });
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(
      '[mcp_servers.atlas]\ncommand = "npx"\nargs = ["-y", "@atlasauth/mcp"]\n',
    );
    expect(c.io.stdout()).toMatch(/cursor: Atlas MCP server added to/);
    // Never a key in any file.
    expect(readFileSync(join(dir, '.mcp.json'), 'utf8')).not.toMatch(/sk_|SECRET/);
  });

  it('keeps other servers, and a second run changes nothing', async () => {
    mkdirSync(join(dir, '.cursor'));
    writeFileSync(join(dir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    await run(['mcp', 'install', '--cursor', '--dir', dir], ctx());
    expect(readJson(join(dir, '.cursor', 'mcp.json')).mcpServers).toEqual({ other: { command: 'x' }, atlas: ENTRY });
    const again = ctx();
    await run(['mcp', 'install', '--cursor', '--dir', dir], again);
    expect(again.io.stdout()).toMatch(/already set up/);
  });

  it('--global puts Cursor in the home directory', async () => {
    await run(['mcp', 'install', '--cursor', '--global', '--dir', dir], ctx());
    expect(readJson(join(home, '.cursor', 'mcp.json')).mcpServers.atlas).toEqual(ENTRY);
  });

  it('refuses to touch a config that is not valid JSON, and needs a client flag', async () => {
    writeFileSync(join(dir, '.mcp.json'), '{ not json');
    const c = ctx();
    expect(await run(['mcp', 'install', '--claude-code', '--dir', dir], c)).not.toBe(0);
    expect(readFileSync(join(dir, '.mcp.json'), 'utf8')).toBe('{ not json');
    expect(await run(['mcp', 'install', '--dir', dir], ctx())).not.toBe(0);
  });
});

describe('config merging', () => {
  it('codex: appends after existing content, never twice', () => {
    const first = mergeCodexToml('model = "o4"\n');
    expect(first.text).toBe('model = "o4"\n\n[mcp_servers.atlas]\ncommand = "npx"\nargs = ["-y", "@atlasauth/mcp"]\n');
    expect(mergeCodexToml(first.text).status).toBe('unchanged');
  });

  it('json: replaces a stale atlas entry', () => {
    const out = mergeJsonConfig(JSON.stringify({ mcpServers: { atlas: { command: 'old' } } }), 'cursor');
    expect(out.status).toBe('updated');
    expect(JSON.parse(out.text).mcpServers.atlas).toEqual(ENTRY);
  });
});

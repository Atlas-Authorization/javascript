import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import { wantsJson } from './shared';
import { GATEWAYS, resourceCommand } from './resources';

/**
 * `atlas mcp install --cursor | --claude-code | --codex | --vscode` — add the
 * Atlas MCP server to an AI coding agent's config, so the agent can search and
 * read the Atlas docs while it works.
 *
 * The server runs as `npx -y @atlasauth/mcp`. No key is written: without
 * `ATLAS_SECRET_KEY` it serves only the read-only docs tools, which is what a
 * coding agent needs. Existing servers in the file are kept; an existing
 * `atlas` entry is replaced (or, in Codex's TOML, left alone and reported).
 */

export const MCP_SERVER_NAME = 'atlas';
const COMMAND = 'npx';
const ARGS = ['-y', '@atlasauth/mcp'];

export const MCP_CLIENTS = ['cursor', 'claude-code', 'codex', 'vscode'] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

interface InstallResult {
  client: McpClient;
  path: string;
  status: 'added' | 'updated' | 'unchanged';
}

/** Where each client keeps its MCP config. Project files go under `dir`. */
export function mcpConfigPath(client: McpClient, opts: { dir: string; global: boolean; env: NodeJS.ProcessEnv }): string {
  const home = opts.env.HOME || homedir();
  switch (client) {
    case 'cursor':
      return opts.global ? join(home, '.cursor', 'mcp.json') : join(opts.dir, '.cursor', 'mcp.json');
    case 'claude-code':
      // Project scope: a checked-in `.mcp.json` that Claude Code offers to the whole team.
      return join(opts.dir, '.mcp.json');
    case 'vscode':
      return join(opts.dir, '.vscode', 'mcp.json');
    case 'codex':
      return join(opts.env.CODEX_HOME || join(home, '.codex'), 'config.toml');
  }
}

/** Merge the Atlas server into a JSON MCP config. Pure, for tests. */
export function mergeJsonConfig(existing: string | null, client: McpClient): { text: string; status: InstallResult['status'] } {
  let doc: Record<string, unknown> = {};
  if (existing && existing.trim()) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      doc = parsed as Record<string, unknown>;
    } catch {
      throw new CliError('The existing MCP config is not valid JSON. Fix or move it, then run this again; it was not changed.');
    }
  }
  // VS Code calls the map `servers` and wants an explicit transport type.
  const key = client === 'vscode' ? 'servers' : 'mcpServers';
  const entry = client === 'vscode' ? { type: 'stdio', command: COMMAND, args: ARGS } : { command: COMMAND, args: ARGS };
  const servers = (typeof doc[key] === 'object' && doc[key] !== null ? doc[key] : {}) as Record<string, unknown>;
  const before = servers[MCP_SERVER_NAME];
  const status: InstallResult['status'] =
    before === undefined ? 'added' : JSON.stringify(before) === JSON.stringify(entry) ? 'unchanged' : 'updated';
  doc[key] = { ...servers, [MCP_SERVER_NAME]: entry };
  return { text: `${JSON.stringify(doc, null, 2)}\n`, status };
}

/** Append the Atlas server to Codex's TOML config, unless one is already there. Pure, for tests. */
export function mergeCodexToml(existing: string | null): { text: string; status: InstallResult['status'] } {
  const current = existing ?? '';
  if (/^\s*\[mcp_servers\.(atlas|"atlas")\]\s*$/m.test(current)) return { text: current, status: 'unchanged' };
  const block = `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "${COMMAND}"\nargs = [${ARGS.map((a) => JSON.stringify(a)).join(', ')}]\n`;
  const sep = current === '' ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  return { text: `${current}${sep}${block}`, status: 'added' };
}

export async function mcp(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  if (sub && sub in GATEWAYS) return resourceCommand('mcp', GATEWAYS)(ctx, args);
  if (sub !== 'install') throw new CliError("Usage: atlas mcp install --cursor | --claude-code | --codex | --vscode, or a gateway command (atlas mcp --help)");

  const chosen = MCP_CLIENTS.filter((c) => args.values[c] === true);
  if (chosen.length === 0) {
    throw new CliError('Choose at least one client: --cursor, --claude-code, --codex or --vscode.');
  }
  const dir = resolve(str(args.values, 'dir') ?? process.cwd());
  const global = args.values.global === true;

  const results: InstallResult[] = [];
  for (const client of chosen) {
    const path = mcpConfigPath(client, { dir, global, env: ctx.env });
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const merged = client === 'codex' ? mergeCodexToml(existing) : mergeJsonConfig(existing, client);
    if (merged.status !== 'unchanged') {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, merged.text);
    }
    results.push({ client, path, status: merged.status });
  }

  if (wantsJson(args.values)) printJson(ctx.io, { server: MCP_SERVER_NAME, command: [COMMAND, ...ARGS].join(' '), results });
  else {
    for (const r of results) {
      const verb = r.status === 'unchanged' ? 'already set up in' : r.status === 'updated' ? 'updated in' : 'added to';
      ctx.io.out(`${r.client}: Atlas MCP server ${verb} ${r.path}`);
    }
    ctx.io.out('Restart the client (or reload its MCP servers). It can now search and read the Atlas docs.');
  }
  return 0;
}

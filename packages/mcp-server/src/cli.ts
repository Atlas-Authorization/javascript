#!/usr/bin/env node
/**
 * The `atlasauth-mcp` executable: a stdio Model Context Protocol server, the
 * local transport Claude Desktop and Cursor speak. It reads its configuration
 * from the environment / CLI flags (see {@link resolveOptions}), builds the
 * server, and serves on stdin/stdout until the client disconnects.
 *
 * Claude Desktop config example (`claude_desktop_config.json`):
 *   {
 *     "mcpServers": {
 *       "atlas": {
 *         "command": "npx",
 *         "args": ["-y", "@atlasauth/mcp"],
 *         "env": { "ATLAS_SECRET_KEY": "sk_..." }
 *       }
 *     }
 *   }
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAtlasMcpServer } from './server';
import { resolveOptions } from './config';

async function main(): Promise<void> {
  const { server } = createAtlasMcpServer(resolveOptions());
  // stdio transport claims process.stdin/stdout for the protocol; it runs until
  // the stream closes, so there is nothing to await after connect.
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // stdout is the MCP wire — ANY non-protocol byte there corrupts the session,
  // so every diagnostic goes to stderr. We print only the message, never the
  // error object (whose stack or wrapped request could carry the secret key).
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[atlasauth-mcp] fatal: ${message}\n`);
  process.exit(1);
});

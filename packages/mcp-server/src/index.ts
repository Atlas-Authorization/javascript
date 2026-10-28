/**
 * `@atlasauth/mcp` — a public Model Context Protocol server for Atlas.
 *
 * It exposes Atlas backend operations (users, organizations, invitations,
 * sessions, API keys) as MCP tools so an AI agent in Claude Desktop, Cursor, or
 * any MCP client can manage an Atlas instance. It is the standalone, public peer
 * of `@atlasauth/agent-toolkit`: the toolkit owns the tool definitions and the
 * safe-by-default scoping, and this package transports them over MCP.
 *
 * Two entry points:
 *   - the `atlasauth-mcp` bin (see `./cli`) — a stdio server for local MCP clients;
 *   - {@link createAtlasMcpServer} — a factory returning an unconnected
 *     `McpServer` for programmatic or HTTP embedding.
 */
export { createAtlasMcpServer, SERVER_NAME, SERVER_VERSION } from './server';
export type { AtlasMcpServer, AtlasMcpServerOptions } from './server';

export { registerAtlasTools, toMcpToolSpecs } from './tools';
export type { McpToolSpec } from './tools';

export { resolveOptions, ENV } from './config';

export {
  DEFAULT_DOCS_URL,
  DOCS_TOOL_NAMES,
  createDocsSource,
  docsToolSpecs,
  findDoc,
  parseDocs,
  searchDocs,
} from './docs';
export type { DocHit, DocPage, DocsSource, DocsSourceOptions } from './docs';

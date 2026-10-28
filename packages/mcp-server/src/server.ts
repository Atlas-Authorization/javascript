import { createAtlasToolkit } from '@atlasauth/agent-toolkit';
import type { AtlasClient } from '@atlasauth/backend';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toMcpToolSpecs, type McpToolSpec } from './tools';
import { DOCS_TOOL_NAMES, createDocsSource, docsToolSpecs, type DocsSourceOptions } from './docs';

/** This package's own identity, surfaced to MCP clients during the handshake. */
export const SERVER_NAME = '@atlasauth/mcp';
export const SERVER_VERSION = '0.3.1';

/**
 * Options for {@link createAtlasMcpServer}. The tool-selection fields
 * (`allowedTools`, `scopes`) and the client fields (`backend`/`secretKey`/
 * `apiUrl`/`fetch`) have the SAME contract as `createAtlasToolkit` — this server
 * is a thin MCP transport over that toolkit, so the safety model is identical:
 * with neither `allowedTools` nor `scopes`, only read tools are exposed.
 */
export interface AtlasMcpServerOptions {
  /** Instance secret key (`sk_...`). Used to build a client when `backend` is absent. */
  secretKey?: string;
  /** Atlas Backend-API base URL. Ignored when `backend` is passed. */
  apiUrl?: string;
  /** An already-configured `@atlasauth/backend` client. Mutually exclusive with `secretKey`. */
  backend?: AtlasClient;
  /** Injectable `fetch`, forwarded to the built client. Ignored when `backend` is passed. */
  fetch?: typeof fetch;
  /**
   * Explicit allowlist of tool NAMES. Authoritative when present (scopes
   * ignored) — the precise way to enable a single destructive tool.
   */
  allowedTools?: readonly string[];
  /**
   * `resource:verb` scope grants (e.g. `users:read`, `organizations:*`). Used
   * only when `allowedTools` is absent. Destructive `:delete` is granted only by
   * an explicit `:delete`/`:*`, never by `:write`.
   */
  scopes?: readonly string[];
  /** Override the advertised server name (defaults to {@link SERVER_NAME}). */
  name?: string;
  /** Override the advertised server version (defaults to {@link SERVER_VERSION}). */
  version?: string;
  /**
   * The read-only Atlas docs tools (`search_atlas_docs`, `read_atlas_doc`). On
   * by default; `false` leaves them out, an object configures where the docs
   * are fetched from. Like every tool they obey `allowedTools` when it is set.
   */
  docs?: boolean | DocsSourceOptions;
}

/** An {@link McpServer} plus the specs it was built from, for embedding/testing. */
export interface AtlasMcpServer {
  /** The MCP server — connect it to any transport (`StdioServerTransport`, HTTP, in-memory). */
  server: McpServer;
  /** The tools registered on it, in catalogue order. */
  tools: McpToolSpec[];
}

/**
 * Build an Atlas MCP server: a Model Context Protocol wrapper around the Atlas
 * agent toolkit. The returned `server` is NOT yet connected to a transport, so
 * this one factory serves both the stdio CLI ({@link ./cli}) and any programmatic
 * / HTTP embedding — the caller chooses the transport and calls `server.connect`.
 *
 * Safe by default: pass no `allowedTools`/`scopes` and only read tools are
 * registered. See {@link AtlasMcpServerOptions}.
 *
 * @example
 * const { server } = createAtlasMcpServer({ secretKey: process.env.ATLAS_SECRET_KEY });
 * await server.connect(new StdioServerTransport());
 */
export function createAtlasMcpServer(options: AtlasMcpServerOptions): AtlasMcpServer {
  const specs: McpToolSpec[] = [];

  // With no key and no client there is nothing to manage, so the server runs in
  // docs-only mode (the setup `atlas mcp install` writes by default).
  const hasInstance = Boolean(options.backend || options.secretKey);
  if (hasInstance) {
    // Delegate client construction AND scoping to the toolkit so this package
    // owns no part of the safety model — it only transports what the toolkit
    // decided to expose.
    const toolkit = createAtlasToolkit({
      backend: options.backend,
      secretKey: options.secretKey,
      apiUrl: options.apiUrl,
      fetch: options.fetch,
      allowedTools: options.allowedTools,
      scopes: options.scopes,
    });
    specs.push(...toMcpToolSpecs(toolkit));
  }

  if (options.docs !== false) {
    const docs = docsToolSpecs(createDocsSource(typeof options.docs === 'object' ? options.docs : { fetch: options.fetch }));
    // An allowlist is authoritative for every tool, docs included.
    specs.push(...(options.allowedTools ? docs.filter((t) => options.allowedTools!.includes(t.name)) : docs));
  }

  if (specs.length === 0) {
    throw new Error('No tools to serve: pass ATLAS_SECRET_KEY for instance tools, or leave the docs tools on.');
  }

  const server = new McpServer({
    name: options.name ?? SERVER_NAME,
    version: options.version ?? SERVER_VERSION,
  });
  for (const spec of specs) {
    if ((DOCS_TOOL_NAMES as readonly string[]).includes(spec.name)) {
      // The docs tools only read public pages: say so, so clients can run them without a prompt.
      server.tool(spec.name, spec.description, spec.shape, { readOnlyHint: true, openWorldHint: true }, spec.handler);
    } else {
      server.tool(spec.name, spec.description, spec.shape, spec.handler);
    }
  }
  return { server, tools: specs };
}

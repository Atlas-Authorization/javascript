# @atlasauth/mcp changelog

## 0.3.1 — 2026-10-28

- The server reports its own version correctly in the MCP handshake.

## 0.3.0 — 2026-10-24

- ATLAS_API_BASE is accepted and wins over ATLAS_API_URL.

## 0.2.0 — 2026-10-23

### Added

- `search_atlas_docs` and `read_atlas_doc`: read-only tools over the public Atlas docs. Without `ATLAS_SECRET_KEY` the server runs docs-only instead of exiting.

## 0.1.0

First published release.

### Added
- Model Context Protocol server exposing Atlas backend operations (users, organizations, invitations, sessions, API keys) as MCP tools for any MCP client.
- `atlasauth-mcp` command-line binary.
- Safe by default: only read tools are exposed unless writes are opted into via `ATLAS_MCP_ALLOWED_TOOLS` or scopes.
- `createAtlasMcpServer()` for embedding the server programmatically.
- `registerAtlasTools()` and `toMcpToolSpecs()` to register the tools on an existing MCP server.
- `resolveOptions()` and `ENV` for environment-based configuration.

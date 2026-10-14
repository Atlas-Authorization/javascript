# @atlasauth/mcp changelog

## 0.1.0

First published release.

### Added
- Model Context Protocol server exposing Atlas backend operations (users, organizations, invitations, sessions, API keys) as MCP tools for any MCP client.
- `atlasauth-mcp` command-line binary.
- Safe by default: only read tools are exposed unless writes are opted into via `ATLAS_MCP_ALLOWED_TOOLS` or scopes.
- `createAtlasMcpServer()` for embedding the server programmatically.
- `registerAtlasTools()` and `toMcpToolSpecs()` to register the tools on an existing MCP server.
- `resolveOptions()` and `ENV` for environment-based configuration.

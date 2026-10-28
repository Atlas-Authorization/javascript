# @atlasauth/mcp

A public [Model Context Protocol](https://modelcontextprotocol.io) server for
Atlas. It exposes Atlas backend operations — users, organizations, invitations,
sessions, and API keys — as MCP tools, so an AI agent in **Claude Desktop**,
**Cursor**, or any MCP client can manage an Atlas instance.

It is the standalone, public peer of
[`@atlasauth/agent-toolkit`](../agent-toolkit): the toolkit owns the tool
definitions and the **safe-by-default** scoping, and this package transports them
over MCP. Nothing is re-implemented here.

## Safe by default

With no allowlist or scopes, **only read tools are exposed** — an agent cannot
create, update, ban, revoke, or delete anything. Destructive capability is
opt-in, with the exact same contract as `@atlasauth/agent-toolkit`:

- `ATLAS_MCP_ALLOWED_TOOLS` — a comma-separated allowlist of tool **names**.
  Authoritative when set (scopes are ignored). The precise way to enable a
  single destructive tool, e.g. `create_user,revoke_session`.
- `ATLAS_MCP_SCOPES` — comma-separated `resource:verb` grants, e.g.
  `users:read,organizations:write`. A `:write` grants `:read` too, but the
  irreversible `:delete` is granted **only** by an explicit `:delete` (or `:*`).

## Docs tools

Two read-only tools search and read the public Atlas documentation, so a coding
agent can look up how to integrate Atlas while it works:

- `search_atlas_docs` `{ query, limit? }` — the best-matching pages, each with its URL and an excerpt.
- `read_atlas_doc` `{ page }` — one page in full, by URL, slug or title.

They need no key. Without `ATLAS_SECRET_KEY` the server runs in **docs-only**
mode and exposes just these two. With a key they sit next to the instance
tools; an `ATLAS_MCP_ALLOWED_TOOLS` allowlist governs them like any other tool.

The quickest setup is the Atlas CLI, which writes the config for your editor:

```bash
npx @atlasauth/cli mcp install --cursor        # or --claude-code, --codex, --vscode
```

## Usage (stdio — Claude Desktop / Cursor)

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "atlas": {
      "command": "npx",
      "args": ["-y", "@atlasauth/mcp"],
      "env": { "ATLAS_SECRET_KEY": "sk_..." }
    }
  }
}
```

### Environment variables

| Variable                  | Purpose                                             |
| ------------------------- | --------------------------------------------------- |
| `ATLAS_SECRET_KEY`        | Instance secret key (`sk_...`). **Required.**       |
| `ATLAS_API_URL`           | Atlas Backend-API base URL (optional).              |
| `ATLAS_MCP_ALLOWED_TOOLS` | Comma-separated allowlist of tool names (optional). |
| `ATLAS_MCP_SCOPES`        | Comma-separated `resource:verb` grants (optional).  |

### CLI flags

The `atlasauth-mcp` bin accepts flags that override the matching env var:
`--secret-key`, `--api-url`, `--allowed-tools`, `--scopes`.

```bash
atlasauth-mcp --secret-key sk_... --scopes users:read,organizations:read
```

## Programmatic / HTTP embedding

`createAtlasMcpServer` returns an **unconnected** `McpServer`, so you choose the
transport:

```ts
import { createAtlasMcpServer } from '@atlasauth/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const { server } = createAtlasMcpServer({
  secretKey: process.env.ATLAS_SECRET_KEY,
  scopes: ['users:read'],
});
await server.connect(new StdioServerTransport());
```

You may also pass an already-configured `@atlasauth/backend` client as
`backend` instead of a `secretKey`.

# @atlasauth/agent-toolkit changelog

## 0.2.0 — 2026-10-28

- Connection tools toolkit and adapters for OpenAI Agents, Mastra, LlamaIndex and Google ADK

### Added
- `createConnectionsToolkit()`: connection tools that run as the agent (list connections, list and run catalog actions, call a provider API through a connection, request access). No tool returns a provider token.
- Adapters for the OpenAI Agents SDK, Mastra, LlamaIndex.TS and Google ADK (TypeScript), each loading its framework lazily.

## 0.1.0

First published release.

### Added
- `createAtlasToolkit()` exposes Atlas backend operations (users, organizations, invitations, sessions, API keys) as tools for AI agents, returning an `AtlasToolkit` of `BoundTool`s.
- Safe-by-default scoping: with no `allowedTools` or `scopes`, only read tools are exposed; writes and deletes must be explicitly granted.
- `allowedTools` allowlist and `resource:verb` `scopes` (e.g. `users:read`, `organizations:*`, `*:read`); `delete` is only granted by an explicit `:delete` or `:*`.
- Tool results are sanitized (`sanitize()`): private/unsafe metadata and credential fields never reach the model.
- `@atlasauth/agent-toolkit/ai-sdk` entry with `toAiSdkTools()` for the Vercel AI SDK.
- `@atlasauth/agent-toolkit/langchain` entry with `toLangChainTools()` for LangChain.
- `allTools`, `selectTools()`, `scopeGrants()` and `defineTool()` for inspecting and extending the tool registry.

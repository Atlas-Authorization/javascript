/**
 * `@atlasauth/agent-toolkit` — the Atlas peer of `@clerk/agent-toolkit`.
 *
 * It wraps the `@atlasauth/backend` management client and exposes a scoped,
 * SAFE-BY-DEFAULT set of identity tools (users, organizations, invitations,
 * sessions, API keys) an AI agent can call. Reads are available by default;
 * every write and the two destructive deletes are hidden unless the integrator
 * opts in via `allowedTools` or `scopes`.
 *
 * This main entry is framework-agnostic and imports NEITHER `ai` NOR
 * `@langchain/core`, so it (and its core tools) work with neither installed.
 * The adapters live behind their own subpaths — import only the one you use:
 *
 *   import { createAtlasToolkit } from '@atlasauth/agent-toolkit';
 *   import { toAiSdkTools }       from '@atlasauth/agent-toolkit/ai-sdk';
 *   import { toLangChainTools }   from '@atlasauth/agent-toolkit/langchain';
 */
export { createAtlasToolkit } from './toolkit';
export type { AtlasToolkit, BoundTool, CreateAtlasToolkitOptions } from './toolkit';

export { allTools, selectTools, scopeGrants } from './registry';
export type { Scope, ToolSelection } from './registry';

export { defineTool } from './types';
export type { ToolDefinition, ToolContext, ToolResource, ToolVerb } from './types';

export { sanitize } from './sanitize';

export { createConnectionsToolkit } from './connections';
export type { ConnectionsToolkitOptions } from './connections';
export type { AgentTool } from './types';

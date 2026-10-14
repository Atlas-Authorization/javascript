import { createAtlasClient, type AtlasClient } from '@atlasauth/backend';
import type { z } from 'zod';
import type { ToolDefinition, ToolResource } from './types';
import { selectTools, type ToolSelection } from './registry';

/**
 * A tool with its Atlas client already bound in, so callers (and the framework
 * adapters) invoke `execute(args)` with just the model-supplied arguments. This
 * is the shape every adapter maps from.
 */
export interface BoundTool {
  name: string;
  description: string;
  resource: ToolResource;
  /** `read` | `write` | `delete` — the tool's access level. */
  verb: ToolDefinition['verb'];
  /** `true` for a pure read. */
  readOnly: boolean;
  /** The Zod schema for this tool's arguments — used for both docs and validation. */
  schema: z.ZodTypeAny;
  /** Run the tool. Returns a sanitized, JSON-serializable result. */
  execute(args: unknown): Promise<unknown>;
}

/** Options for {@link createAtlasToolkit}. */
export interface CreateAtlasToolkitOptions extends ToolSelection {
  /**
   * An existing `@atlasauth/backend` client. Pass this to reuse one you already
   * configured (custom `apiUrl`, injected `fetch`, retry wrapper, …). Mutually
   * exclusive with `secretKey`.
   */
  backend?: AtlasClient;
  /** Instance secret key (`sk_...`). Used to build a client when `backend` is absent. */
  secretKey?: string;
  /** BAPI base URL, forwarded to the built client. Ignored when `backend` is passed. */
  apiUrl?: string;
  /** Injectable `fetch`, forwarded to the built client. Ignored when `backend` is passed. */
  fetch?: typeof fetch;
}

/** Group-accessor names, keyed off {@link ToolResource}. `api_keys` → `apiKeys`. */
export interface AtlasToolkit {
  /** The underlying Atlas Backend-API client. */
  backend: AtlasClient;
  /** Every exposed tool, in catalogue order. */
  all: BoundTool[];
  /** Every exposed tool, keyed by name. */
  tools: Record<string, BoundTool>;
  /** Exposed user tools, keyed by name. */
  users: Record<string, BoundTool>;
  /** Exposed organization tools, keyed by name. */
  organizations: Record<string, BoundTool>;
  /** Exposed invitation tools, keyed by name. */
  invitations: Record<string, BoundTool>;
  /** Exposed session tools, keyed by name. */
  sessions: Record<string, BoundTool>;
  /** Exposed API-key tools, keyed by name. */
  apiKeys: Record<string, BoundTool>;
  /** Names of every exposed tool. */
  names(): string[];
  /** Is a tool with this name exposed? */
  has(name: string): boolean;
  /** Fetch one exposed tool by name, or `undefined`. */
  get(name: string): BoundTool | undefined;
}

const RESOURCE_TO_GROUP: Record<ToolResource, keyof Pick<
  AtlasToolkit,
  'users' | 'organizations' | 'invitations' | 'sessions' | 'apiKeys'
>> = {
  users: 'users',
  organizations: 'organizations',
  invitations: 'invitations',
  sessions: 'sessions',
  api_keys: 'apiKeys',
};

/**
 * Build an Atlas agent toolkit: a scoped, safe-by-default set of identity tools
 * an AI agent can call against the Atlas Backend API, ready to hand to a
 * framework adapter (see `@atlasauth/agent-toolkit/ai-sdk` and `.../langchain`).
 *
 * SCOPING IS MANDATORY AND SAFE BY DEFAULT. With no `allowedTools`/`scopes`, the
 * toolkit exposes ONLY read tools — an agent cannot create, update, ban, revoke,
 * or delete anything. Destructive capability is granted exclusively through an
 * explicit `allowedTools` name list or `scopes` grant (see {@link selectTools}).
 *
 * @example
 * // Reads only — the default. No write tool is present.
 * const toolkit = createAtlasToolkit({ secretKey: process.env.ATLAS_SECRET_KEY });
 *
 * @example
 * // Opt into specific capability.
 * const toolkit = createAtlasToolkit({
 *   backend: myAtlasClient,
 *   scopes: ['users:write', 'organizations:read'], // can create/update/ban users; delete still hidden
 * });
 */
export function createAtlasToolkit(options: CreateAtlasToolkitOptions): AtlasToolkit {
  const backend = resolveBackend(options);
  const ctx = { backend };

  const bound: BoundTool[] = selectTools(options).map((def) => ({
    name: def.name,
    description: def.description,
    resource: def.resource,
    verb: def.verb,
    readOnly: def.readOnly,
    schema: def.schema,
    execute: (args: unknown) => def.execute(args, ctx),
  }));

  const tools: Record<string, BoundTool> = {};
  const groups = {
    users: {} as Record<string, BoundTool>,
    organizations: {} as Record<string, BoundTool>,
    invitations: {} as Record<string, BoundTool>,
    sessions: {} as Record<string, BoundTool>,
    apiKeys: {} as Record<string, BoundTool>,
  };
  for (const tool of bound) {
    tools[tool.name] = tool;
    groups[RESOURCE_TO_GROUP[tool.resource]][tool.name] = tool;
  }

  return {
    backend,
    all: bound,
    tools,
    ...groups,
    names: () => bound.map((t) => t.name),
    has: (name) => name in tools,
    get: (name) => tools[name],
  };
}

/** Turn the `{ backend } | { secretKey }` options into a concrete client. */
function resolveBackend(options: CreateAtlasToolkitOptions): AtlasClient {
  if (options.backend) return options.backend;
  if (!options.secretKey) {
    throw new Error(
      'createAtlasToolkit requires either a `backend` client or a `secretKey` to build one.',
    );
  }
  return createAtlasClient({
    secretKey: options.secretKey,
    apiUrl: options.apiUrl,
    fetch: options.fetch,
  });
}

import type { z } from 'zod';
import type { AtlasClient } from '@atlasauth/backend';
import { sanitize } from './sanitize';

/**
 * The five Atlas resources this toolkit surfaces. Scopes are written as
 * `resource:verb` against these names (plus the `*` wildcard), so they are the
 * single source of truth for both the scope grammar and the toolkit's group
 * accessors.
 */
export type ToolResource = 'users' | 'organizations' | 'invitations' | 'sessions' | 'api_keys';

/**
 * A tool's access level, ordered least→most dangerous. The ordering matters:
 * granting a higher verb implies the lower ones for the same resource (a
 * `users:write` scope also reads users), but never the other way, and `delete`
 * — the only irreversible verb — is never implied by `write`. See
 * {@link scopeGrants}.
 */
export type ToolVerb = 'read' | 'write' | 'delete';

/** Everything a tool's `execute` needs: the bound Atlas Backend-API client. */
export interface ToolContext {
  backend: AtlasClient;
}

/**
 * A framework-agnostic tool: a name the model sees, a human description it
 * reads to decide when to call, a Zod schema that both documents and validates
 * the arguments, and an `execute` that performs the Atlas operation. The two
 * framework adapters ({@link ./ai-sdk} and {@link ./langchain}) are thin maps
 * over this shape, which is why adding a third framework is a few lines.
 *
 * The specific input schema is intentionally erased to `z.ZodTypeAny` at the
 * registry boundary so a heterogeneous set of tools lives in one record;
 * per-tool argument inference is preserved where it matters — at each tool's
 * definition site — by {@link defineTool}.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  resource: ToolResource;
  verb: ToolVerb;
  /** `true` for a pure read; `false` for any state change. Derived from `verb`. */
  readOnly: boolean;
  schema: z.ZodTypeAny;
  execute(args: unknown, ctx: ToolContext): Promise<unknown>;
}

/**
 * Define one tool with full argument inference: `execute` sees `z.infer<S>`,
 * not `unknown`, so a tool body is type-checked against its own schema. The
 * returned value is widened to {@link ToolDefinition} for storage in the
 * registry. `readOnly` is computed here, never hand-passed, so it can never
 * drift from `verb`.
 */
export function defineTool<S extends z.ZodTypeAny>(def: {
  name: string;
  description: string;
  resource: ToolResource;
  verb: ToolVerb;
  schema: S;
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}): ToolDefinition {
  return {
    name: def.name,
    description: def.description,
    resource: def.resource,
    verb: def.verb,
    readOnly: def.verb === 'read',
    schema: def.schema,
    // Every result is sanitized here, by construction, so no individual tool
    // body can forget to and leak a secret or private bag. The cast re-widens
    // the inferred-arg signature to the erased one; it is sound because
    // `execute` only ever receives args this tool's own schema parsed.
    execute: async (args, ctx) => sanitize(await def.execute(args as z.infer<S>, ctx)),
  };
}

/**
 * The minimal tool shape every framework adapter maps from. A toolkit's {@link BoundTool} satisfies it, and so does
 * a tool you write by hand, which is what lets the same adapters carry the connection tools too.
 */
export interface AgentTool {
  name: string;
  description: string;
  /** The Zod schema of the arguments: documents them and validates them. */
  schema: z.ZodTypeAny;
  /** True for a pure read. */
  readOnly?: boolean;
  /** Run the tool with already-validated arguments. */
  execute(args: unknown): Promise<unknown>;
}

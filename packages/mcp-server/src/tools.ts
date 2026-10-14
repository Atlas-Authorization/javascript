import { z } from 'zod';
import type { AtlasToolkit, BoundTool } from '@atlasauth/agent-toolkit';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * One Atlas tool reshaped for the MCP high-level `server.tool(name, description,
 * paramsSchema, handler)` API. We keep this as a plain, inspectable value — not
 * only a side effect on an `McpServer` — so the registry can be asserted in a
 * unit test WITHOUT standing up a stdio transport (instantiate, read `shape`,
 * invoke `handler`). {@link registerAtlasTools} is the only thing that touches a
 * live server.
 */
export interface McpToolSpec {
  name: string;
  description: string;
  /**
   * A Zod RAW SHAPE (not a wrapped `z.object`): the MCP SDK re-wraps it into an
   * object schema and both advertises it as the tool's JSON-Schema and validates
   * the model's arguments against it before the handler runs.
   */
  shape: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

/**
 * The agent-toolkit hands us each tool's arguments as a single `z.object({…})`.
 * MCP's `tool()` wants the inner raw shape, so we unwrap it here.
 *
 * Detection is STRUCTURAL (`_def.typeName`), never `instanceof z.ZodObject`:
 * agent-toolkit's schema may be built by a different physical copy of zod than
 * the one imported here (a real possibility under bundlers/test runners that
 * resolve a dependency's zod separately), across which `instanceof` is false —
 * which would silently return the empty shape below and strip EVERY tool
 * argument. The `.shape` getter and `_def` exist on any zod-v3 object schema
 * regardless of which copy created it.
 *
 * Every toolkit tool uses an object schema today; the empty-shape fallback keeps
 * a future non-object tool from throwing at registration (it would simply take
 * no declared arguments) rather than crashing the whole server.
 */
function rawShapeOf(schema: z.ZodTypeAny): z.ZodRawShape {
  const typeName = (schema as { _def?: { typeName?: string } })._def?.typeName;
  if (typeName === 'ZodObject') {
    return (schema as unknown as z.ZodObject<z.ZodRawShape>).shape;
  }
  return {};
}

/** Render a tool's (already-sanitized) result as MCP text content. */
function okResult(value: unknown): CallToolResult {
  return {
    // `null, 2` keeps it legible when a client surfaces raw tool output to a
    // human. The value is JSON by construction — agent-toolkit sanitizes every
    // result into a plain, serializable structure before it reaches us.
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

/**
 * Surface a failed Atlas call to the model as an MCP tool error rather than
 * throwing out of the handler: an MCP client shows `isError` results back to the
 * model so it can recover, whereas a thrown error becomes an opaque protocol
 * fault. We stringify only `error.message` — never the error object — so a
 * stack, request headers, or a secret embedded in a thrown client error cannot
 * ride out to the model.
 */
function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: `Atlas tool error: ${message}` }],
    isError: true,
  };
}

/** Turn one agent-toolkit bound tool into its MCP spec. */
function toSpec(tool: BoundTool): McpToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    shape: rawShapeOf(tool.schema),
    handler: async (args) => {
      try {
        // `tool.execute` returns a SANITIZED, JSON-serializable value (the
        // toolkit strips `private_metadata`, api-key `secret`, bearer tokens,
        // etc. at its own boundary), so nothing extra is needed to keep secrets
        // out of the model-visible result.
        return okResult(await tool.execute(args));
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

/**
 * Project a built Atlas toolkit onto the MCP tool shape. The toolkit has already
 * applied its safe-by-default scoping (reads only, unless the caller opted into
 * writes/deletes via `allowedTools`/`scopes`), so this is a pure 1:1 mapping —
 * we expose exactly what the toolkit exposes, no more.
 */
export function toMcpToolSpecs(toolkit: AtlasToolkit): McpToolSpec[] {
  return toolkit.all.map(toSpec);
}

/**
 * Register every toolkit tool on an `McpServer` via the standard
 * `server.tool(name, description, paramsSchema, handler)` API, and return the
 * specs for inspection/testing. Separated from {@link toMcpToolSpecs} so the
 * mapping can be tested without a server instance.
 */
export function registerAtlasTools(server: McpServer, toolkit: AtlasToolkit): McpToolSpec[] {
  const specs = toMcpToolSpecs(toolkit);
  for (const spec of specs) {
    server.tool(spec.name, spec.description, spec.shape, spec.handler);
  }
  return specs;
}

/**
 * Vercel AI SDK adapter — the PRIMARY target.
 *
 * It maps the toolkit's bound tools onto the AI SDK `tool()` shape
 * (`{ description, parameters, execute }`) and nothing more. We build the plain
 * objects directly rather than importing `ai`'s `tool()` helper: that helper is
 * an identity function that exists only for type inference, so reproducing its
 * output shape lets this adapter (and the whole package) build and run with
 * `ai` NOT installed. `ai` is therefore an OPTIONAL peer — a consumer has it for
 * their own `generateText`/`streamText` calls, into whose `tools` these objects
 * drop unchanged.
 */
import type { z } from 'zod';
import type { AtlasToolkit, BoundTool } from './toolkit';

/**
 * One tool in the AI SDK's `tool()` shape. Structurally compatible with the
 * SDK's `CoreTool`/`Tool`: `parameters` is a Zod schema and `execute` receives
 * the parsed arguments. Kept as a local interface so the adapter is not coupled
 * to a specific `ai` version's exported generics.
 */
export interface AiSdkTool {
  description: string;
  parameters: z.ZodTypeAny;
  execute: (args: unknown) => Promise<unknown>;
}

/** Accept either a built toolkit or a raw list of its bound tools. */
function toToolList(source: AtlasToolkit | readonly BoundTool[]): readonly BoundTool[] {
  return Array.isArray(source) ? source : (source as AtlasToolkit).all;
}

/**
 * Convert an Atlas toolkit (or a list of its bound tools) into a
 * `Record<toolName, AiSdkTool>` ready to pass as the `tools` option of the AI
 * SDK's `generateText`/`streamText`.
 *
 * @example
 * const toolkit = createAtlasToolkit({ secretKey, scopes: ['users:read'] });
 * const result = await generateText({
 *   model,
 *   tools: toAiSdkTools(toolkit),
 *   prompt: 'How many users signed in this week?',
 * });
 */
export function toAiSdkTools(source: AtlasToolkit | readonly BoundTool[]): Record<string, AiSdkTool> {
  const out: Record<string, AiSdkTool> = {};
  for (const tool of toToolList(source)) {
    out[tool.name] = {
      description: tool.description,
      parameters: tool.schema,
      // The AI SDK validates args against `parameters` before calling this, so
      // `execute` receives a value already matching the schema.
      execute: (args: unknown) => tool.execute(args),
    };
  }
  return out;
}

/**
 * Mastra adapter: maps tools onto `createTool({ id, description, inputSchema, execute })` from `@mastra/core/tools`
 * (https://mastra.ai/docs/tools-mcp/overview). `execute` receives the validated input as its first argument.
 */
import type { z } from 'zod';
import type { AgentTool } from './types';
import { loadPeer, toToolList } from './adapters-shared';

export type MastraCreateTool = (def: { id: string; description: string; inputSchema: z.ZodTypeAny; execute: (input: unknown) => Promise<unknown> }) => unknown;

export interface ToMastraToolsOptions {
  /** `createTool` from `@mastra/core/tools`. Loaded lazily when omitted. */
  createTool?: MastraCreateTool;
}

/** Tools keyed by id, the shape an `Agent`'s `tools` option takes. */
export function toMastraTools(source: { all: readonly AgentTool[] } | readonly AgentTool[], options: ToMastraToolsOptions = {}): Record<string, unknown> {
  let create = options.createTool;
  if (!create) {
    // `createTool` lives in a subpath, so it is resolved by the module id, not a package export of the root.
    create = loadPeer<MastraCreateTool>('@mastra/core/tools', 'createTool', '@atlasauth/agent-toolkit/mastra');
  }
  const out: Record<string, unknown> = {};
  for (const t of toToolList(source)) {
    out[t.name] = create({
      id: t.name,
      description: t.description,
      inputSchema: t.schema,
      execute: async (input) => t.execute(t.schema.parse(input)),
    });
  }
  return out;
}

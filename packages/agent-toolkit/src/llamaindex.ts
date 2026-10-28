/**
 * LlamaIndex.TS adapter: maps tools onto `tool(fn, { name, description, parameters })` from `llamaindex`
 * (https://developers.llamaindex.ai/typescript/framework/modules/agents/tool). The function takes the LLM's input first.
 */
import type { z } from 'zod';
import type { AgentTool } from './types';
import { asText, loadPeer, toToolList } from './adapters-shared';

export type LlamaIndexToolFactory = (fn: (input: unknown) => Promise<string>, config: { name: string; description: string; parameters: z.ZodTypeAny }) => unknown;

export interface ToLlamaIndexToolsOptions {
  /** `tool` from `llamaindex`. Loaded lazily when omitted. */
  tool?: LlamaIndexToolFactory;
}

export function toLlamaIndexTools(source: { all: readonly AgentTool[] } | readonly AgentTool[], options: ToLlamaIndexToolsOptions = {}): unknown[] {
  const factory = options.tool ?? loadPeer<LlamaIndexToolFactory>('llamaindex', 'tool', '@atlasauth/agent-toolkit/llamaindex');
  return toToolList(source).map((t) =>
    factory(async (input) => asText(await t.execute(t.schema.parse(input))), { name: t.name, description: t.description, parameters: t.schema }),
  );
}

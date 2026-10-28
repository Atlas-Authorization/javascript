/**
 * OpenAI Agents SDK (JS) adapter: maps tools onto `tool({ name, description, parameters, execute })` from `@openai/agents`
 * (https://openai.github.io/openai-agents-js/guides/tools/). `strict` is off by default because the Atlas schemas have
 * optional fields, which the SDK's strict mode would reject.
 */
import type { z } from 'zod';
import type { AgentTool } from './types';
import { asText, loadPeer, toToolList } from './adapters-shared';

export type OpenAiToolFactory = (def: { name: string; description: string; parameters: z.ZodTypeAny; strict?: boolean; execute: (input: unknown) => Promise<string> }) => unknown;

export interface ToOpenAiAgentsToolsOptions {
  /** `tool` from `@openai/agents`. Loaded lazily when omitted. */
  tool?: OpenAiToolFactory;
  strict?: boolean;
}

export function toOpenAiAgentsTools(source: { all: readonly AgentTool[] } | readonly AgentTool[], options: ToOpenAiAgentsToolsOptions = {}): unknown[] {
  const factory = options.tool ?? loadPeer<OpenAiToolFactory>('@openai/agents', 'tool', '@atlasauth/agent-toolkit/openai-agents');
  return toToolList(source).map((t) =>
    factory({
      name: t.name,
      description: t.description,
      parameters: t.schema,
      strict: options.strict ?? false,
      execute: async (input) => asText(await t.execute(t.schema.parse(input))),
    }),
  );
}

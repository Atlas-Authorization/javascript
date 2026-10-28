/**
 * Google ADK (TypeScript) adapter: maps tools onto `new FunctionTool({ name, description, parameters, execute })` from
 * `@google/adk` (https://adk.dev/tools-custom/function-tools/). ADK wants an object back, so a non-object result is
 * wrapped as `{ result }`.
 */
import type { z } from 'zod';
import type { AgentTool } from './types';
import { toToolList } from './adapters-shared';

export type AdkFunctionToolCtor = new (def: { name: string; description: string; parameters: z.ZodTypeAny; execute: (input: unknown) => Promise<Record<string, unknown>> }) => unknown;

export interface ToAdkToolsOptions {
  /** `FunctionTool` from `@google/adk`. Loaded lazily when omitted. */
  FunctionTool?: AdkFunctionToolCtor;
}

declare function require(id: string): unknown;

export function toAdkTools(source: { all: readonly AgentTool[] } | readonly AgentTool[], options: ToAdkToolsOptions = {}): unknown[] {
  let Ctor = options.FunctionTool;
  if (!Ctor) {
    try {
      Ctor = (require('@google/adk') as { FunctionTool?: AdkFunctionToolCtor }).FunctionTool;
    } catch (cause) {
      throw new Error('`@atlasauth/agent-toolkit/google-adk` requires `@google/adk` to be installed. Add it as a dependency, or pass `{ FunctionTool }`.', { cause });
    }
    if (typeof Ctor !== 'function') throw new Error('`@google/adk` did not export `FunctionTool`.');
  }
  const C = Ctor;
  return toToolList(source).map(
    (t) =>
      new C({
        name: t.name,
        description: t.description,
        parameters: t.schema,
        execute: async (input) => {
          const out = await t.execute(t.schema.parse(input));
          return typeof out === 'object' && out !== null && !Array.isArray(out) ? (out as Record<string, unknown>) : { result: out };
        },
      }),
  );
}

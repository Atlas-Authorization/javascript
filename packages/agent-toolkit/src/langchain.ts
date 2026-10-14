/**
 * LangChain adapter — the SECOND target.
 *
 * It maps the toolkit's bound tools onto LangChain's `DynamicStructuredTool`
 * (name + description + Zod `schema` + `func`). LangChain agents accept only
 * real tool instances (they are matched structurally by the executor), so this
 * adapter constructs the genuine class.
 *
 * `@langchain/core` is an OPTIONAL peer. We never import it for types — the
 * constructor and instance are described by the small structural interfaces
 * below — and we load the class LAZILY (a `require` only reached when this
 * adapter actually runs). So the package builds, and its core tools work, with
 * `@langchain/core` absent; only calling {@link toLangChainTools} without it
 * (and without injecting the class) throws, with a message that says what to
 * install. The class can also be injected, for DI and tests.
 */
import type { z } from 'zod';
import type { AtlasToolkit, BoundTool } from './toolkit';

/** The subset of a `DynamicStructuredTool` instance this adapter produces and exposes. */
export interface LangChainStructuredTool {
  name: string;
  description: string;
  /** The Zod argument schema. */
  schema: z.ZodTypeAny;
  /** The executor LangChain invokes with validated args; returns a string. */
  func: (input: Record<string, unknown>) => Promise<string>;
}

interface DynamicStructuredToolFields {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  func: (input: Record<string, unknown>) => Promise<string>;
}

/** Structural view of `@langchain/core/tools`' `DynamicStructuredTool` constructor. */
export interface DynamicStructuredToolCtor {
  new (fields: DynamicStructuredToolFields): LangChainStructuredTool;
}

export interface ToLangChainToolsOptions {
  /**
   * The `DynamicStructuredTool` class to instantiate. When omitted it is loaded
   * lazily from `@langchain/core/tools`. Pass it explicitly to avoid the
   * resolution (e.g. in tests, or to use a drop-in subclass).
   */
  DynamicStructuredTool?: DynamicStructuredToolCtor;
}

// Declared locally rather than via `@types/node` so this package keeps
// `types: []` and depends on no global typings. At runtime (CommonJS emit)
// `require` is always present; this only reaches the checker.
declare function require(id: string): unknown;

/** Resolve the constructor: the injected one, else a lazy load of the peer. */
function resolveCtor(explicit?: DynamicStructuredToolCtor): DynamicStructuredToolCtor {
  if (explicit) return explicit;
  let mod: unknown;
  try {
    mod = require('@langchain/core/tools');
  } catch (cause) {
    throw new Error(
      '`@atlasauth/agent-toolkit/langchain` requires `@langchain/core` to be installed. ' +
        'Add it as a dependency, or pass `{ DynamicStructuredTool }` explicitly.',
      { cause },
    );
  }
  const ctor = (mod as { DynamicStructuredTool?: unknown }).DynamicStructuredTool;
  if (typeof ctor !== 'function') {
    throw new Error('`@langchain/core/tools` did not export a `DynamicStructuredTool` class.');
  }
  return ctor as DynamicStructuredToolCtor;
}

/** Accept either a built toolkit or a raw list of its bound tools. */
function toToolList(source: AtlasToolkit | readonly BoundTool[]): readonly BoundTool[] {
  return Array.isArray(source) ? source : (source as AtlasToolkit).all;
}

/**
 * Convert an Atlas toolkit (or a list of its bound tools) into an array of
 * LangChain `DynamicStructuredTool`s, ready to hand to an agent/executor.
 *
 * LangChain tools must return a string, so each tool's sanitized result is
 * JSON-stringified. Arguments are re-validated against the Zod schema inside
 * `func` as a defensive second check.
 *
 * @example
 * const toolkit = createAtlasToolkit({ secretKey, scopes: ['users:read'] });
 * const tools = toLangChainTools(toolkit);
 * const agent = createToolCallingAgent({ llm, tools, prompt });
 */
export function toLangChainTools(
  source: AtlasToolkit | readonly BoundTool[],
  options: ToLangChainToolsOptions = {},
): LangChainStructuredTool[] {
  const Ctor = resolveCtor(options.DynamicStructuredTool);
  return toToolList(source).map(
    (tool) =>
      new Ctor({
        name: tool.name,
        description: tool.description,
        schema: tool.schema,
        func: async (input) => {
          const parsed = tool.schema.parse(input) as unknown;
          const result = await tool.execute(parsed);
          return JSON.stringify(result);
        },
      }),
  );
}

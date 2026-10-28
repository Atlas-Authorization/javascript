import type { AgentTool } from './types';

/** Accept a built toolkit (anything with `.all`) or a plain list of tools. */
export function toToolList(source: { all: readonly AgentTool[] } | readonly AgentTool[]): readonly AgentTool[] {
  return Array.isArray(source) ? (source as readonly AgentTool[]) : (source as { all: readonly AgentTool[] }).all;
}

/** Tool results go back to the model as JSON; a string result stays a string. */
export const asText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

// Declared locally so this package keeps `types: []`; at runtime (CommonJS emit) `require` is present.
declare function require(id: string): unknown;

/** Load an optional peer lazily, with a message that says what to install. */
export function loadPeer<T>(moduleId: string, exportName: string, hint: string): T {
  let mod: unknown;
  try {
    mod = require(moduleId);
  } catch (cause) {
    throw new Error(`\`${hint}\` requires \`${moduleId}\` to be installed. Add it as a dependency, or pass the factory explicitly.`, { cause });
  }
  const v = (mod as Record<string, unknown>)[exportName];
  if (typeof v !== 'function') throw new Error(`\`${moduleId}\` did not export \`${exportName}\`.`);
  return v as T;
}

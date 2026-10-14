/**
 * Programmatic entry point for `@atlasauth/upgrade`.
 *
 * The CLI (`dist/cli.js`) is the primary interface, but every moving part is
 * exported here too so the transforms can be composed, embedded in other tools,
 * or unit-tested without spawning a process.
 */

export { default as clerkToAtlas, type ClerkToAtlasOptions } from './transforms/clerk-to-atlas';
export { bumpAtlasDeps, toRange, type VersionBumpResult } from './transforms/version-bump';
export {
  collectSourceFiles,
  runClerkToAtlas,
  type FileChange,
  type RunClerkToAtlasOptions,
  type RunResult,
} from './runner';
export { unifiedDiff } from './diff';
export {
  IDENTIFIER_MAP,
  PACKAGE_MAP,
  SHARED_IDENTIFIERS,
  TODO_PREFIX,
  isClerkPackage,
  renameEnvKey,
} from './mappings';

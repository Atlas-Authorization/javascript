/**
 * Programmatic entry point for `@atlasauth/upgrade`.
 *
 * The CLI (`dist/cli.js`) is the primary interface, but every moving part is
 * exported here too so the transforms can be composed, embedded in other tools
 * (the `atlas migrate code` command drives `runMigration`), or unit-tested
 * without spawning a process.
 */

export { default as clerkToAtlas, type ClerkToAtlasOptions } from './transforms/clerk-to-atlas';
export { default as authjsToAtlas } from './vendors/authjs';
export { default as supabaseToAtlas } from './vendors/supabase';
export { default as auth0ToAtlas } from './vendors/auth0';
export { default as betterAuthToAtlas } from './vendors/better-auth';
export { default as oktaToAtlas } from './vendors/okta';
export { default as kindeToAtlas } from './vendors/kinde';
export { default as descopeToAtlas } from './vendors/descope';
export { openidClientToAtlas, joseToAtlas, genericOidcToAtlas } from './vendors/oidc';
export { default as luciaToAtlas } from './vendors/lucia';
export { default as passportToAtlas } from './vendors/passport';
export { default as ironSessionToAtlas } from './vendors/iron-session';
export { default as firebaseToAtlas } from './vendors/firebase';
export { default as cognitoToAtlas } from './vendors/cognito';
export { default as azureToAtlas } from './vendors/azure';
export { default as appwriteToAtlas } from './vendors/appwrite';
export { default as pocketbaseToAtlas } from './vendors/pocketbase';
export { default as nhostToAtlas } from './vendors/nhost';
export { OSS_IDP_TRANSFORMS, OSS_IDP_VENDORS, type OssIdpVendor } from './vendors/oss-idps';
export { default as workosToAtlas } from './vendors/workos';
export { default as stytchToAtlas } from './vendors/stytch';
export { default as fronteggToAtlas } from './vendors/frontegg';
export { default as propelauthToAtlas } from './vendors/propelauth';
export { default as magicToAtlas } from './vendors/magic';
export { default as userfrontToAtlas } from './vendors/userfront';
export { default as corbadoToAtlas } from './vendors/corbado';
export { MIGRATE_TODO, type EnvStyle, type ReportItem, type VendorOptions } from './vendors/engine';
export {
  MIGRATE_VENDORS,
  IMPORTABLE_VENDORS,
  MIGRATE_EXPORT_VENDORS,
  EXPORTABLE_VENDORS,
  detectEnvStyle,
  formatMigration,
  resolveVendor,
  runMigration,
  type MigrateOptions,
  type MigrateResult,
  type MigrateVendor,
} from './migrate';
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
export {
  analyzeBetterAuth,
  analyzeCalls,
  literalOf,
  propOf,
  type AnalyzeOptions,
  type CallAnalysis,
  type CallMatcher,
  type FoundCall,
  type BetterAuthAnalysis,
  type BetterAuthInstance,
  type SourceLoc,
  type StaticValue,
} from './better-auth-config/analyze';

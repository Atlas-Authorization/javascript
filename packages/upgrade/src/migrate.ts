import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import jscodeshift from 'jscodeshift';
import type { API } from 'jscodeshift';

import { TODO_PREFIX } from './mappings';
import { collectSourceFiles, type FileChange } from './runner';
import clerkToAtlas from './transforms/clerk-to-atlas';
import authjs from './vendors/authjs';
import auth0 from './vendors/auth0';
import betterAuth from './vendors/better-auth';
import { publicEnvKey, type EnvStyle, type ReportItem, type VendorTransform } from './vendors/engine';
import ironSession from './vendors/iron-session';
import lucia from './vendors/lucia';
import { genericOidcToAtlas, joseToAtlas, openidClientToAtlas } from './vendors/oidc';
import descope from './vendors/descope';
import kinde from './vendors/kinde';
import okta from './vendors/okta';
import passport from './vendors/passport';
import saml from './vendors/saml';
import supabase from './vendors/supabase';
import corbado, { env as corbadoEnv } from './vendors/corbado';
import frontegg, { env as fronteggEnv } from './vendors/frontegg';
import magic, { env as magicEnv } from './vendors/magic';
import propelauth, { env as propelauthEnv } from './vendors/propelauth';
import stytch, { env as stytchEnv } from './vendors/stytch';
import userfront, { env as userfrontEnv } from './vendors/userfront';
import workos, { env as workosEnv } from './vendors/workos';
import { OSS_IDP_ALIASES, OSS_IDP_ENV, OSS_IDP_PACKAGES, OSS_IDP_TRANSFORMS, OSS_IDP_VENDORS } from './vendors/oss-idps';
import firebase from './vendors/firebase';
import cognito from './vendors/cognito';
import azure from './vendors/azure';
import appwrite from './vendors/appwrite';
import pocketbase from './vendors/pocketbase';
import nhost from './vendors/nhost';

/** Every vendor `atlas migrate code --from <vendor>` understands. */
export const MIGRATE_VENDORS = [
  'clerk',
  'authjs',
  'supabase',
  'auth0',
  'better-auth',
  'okta',
  'kinde',
  'descope',
  'openid-client',
  'jose',
  'generic-oidc',
  'lucia',
  'passport',
  'iron-session',
  'firebase',
  'cognito',
  'azure-ad-b2c',
  'entra-external-id',
  'appwrite',
  'pocketbase',
  'nhost',
  ...OSS_IDP_VENDORS,
  'workos',
  'stytch',
  'frontegg',
  'propelauth',
  'magic',
  'userfront',
  'corbado',
  'saml',
] as const;

/**
 * Vendors whose users can be moved with `atlas import --from <vendor>` (hand-rolled
 * OIDC has no user store of its own; Lucia, Passport and iron-session keep users in
 * the app's own database, exported separately).
 */
export const IMPORTABLE_VENDORS: readonly MigrateVendor[] = ['clerk', 'authjs', 'supabase', 'auth0', 'better-auth'];
/** Vendors whose users move with `atlas migrate <vendor>` (export on this machine → sealed bundle → import). */
export const MIGRATE_EXPORT_VENDORS: readonly MigrateVendor[] = ['clerk', 'auth0', 'okta', 'kinde', 'descope'];
export type MigrateVendor = (typeof MIGRATE_VENDORS)[number];

/** Vendors whose users move with `atlas migrate export <vendor>` (the encrypted-bundle path). */
export const EXPORTABLE_VENDORS: readonly MigrateVendor[] = [
  'firebase',
  'supabase',
  'cognito',
  'azure-ad-b2c',
  'entra-external-id',
  'appwrite',
  'pocketbase',
  'nhost',
];
/** Vendors whose users move with `atlas migrate <vendor>` (the vendor-neutral migration framework). */
const FRAMEWORK_VENDORS: readonly MigrateVendor[] = ['workos', 'stytch', 'frontegg', 'propelauth', 'magic', 'userfront', 'corbado'];

/** Aliases accepted on the command line. */
const ALIASES: Record<string, MigrateVendor> = {
  clerk: 'clerk',
  authjs: 'authjs',
  'auth.js': 'authjs',
  nextauth: 'authjs',
  'next-auth': 'authjs',
  supabase: 'supabase',
  auth0: 'auth0',
  'better-auth': 'better-auth',
  betterauth: 'better-auth',
  okta: 'okta',
  'okta-cis': 'okta',
  'okta-workforce': 'okta',
  kinde: 'kinde',
  descope: 'descope',
  'openid-client': 'openid-client',
  openidclient: 'openid-client',
  jose: 'jose',
  'generic-oidc': 'generic-oidc',
  genericoidc: 'generic-oidc',
  oidc: 'generic-oidc',
  'hand-rolled-oidc': 'generic-oidc',
  lucia: 'lucia',
  'lucia-auth': 'lucia',
  passport: 'passport',
  passportjs: 'passport',
  'passport.js': 'passport',
  'express-session': 'passport',
  'iron-session': 'iron-session',
  ironsession: 'iron-session',
  'next-iron-session': 'iron-session',
  firebase: 'firebase',
  'firebase-auth': 'firebase',
  'identity-platform': 'firebase',
  'google-identity-platform': 'firebase',
  cognito: 'cognito',
  'aws-cognito': 'cognito',
  'amazon-cognito': 'cognito',
  amplify: 'cognito',
  'aws-amplify': 'cognito',
  'azure-ad-b2c': 'azure-ad-b2c',
  'azure-b2c': 'azure-ad-b2c',
  b2c: 'azure-ad-b2c',
  'entra-external-id': 'entra-external-id',
  'entra-id': 'entra-external-id',
  entra: 'entra-external-id',
  'external-id': 'entra-external-id',
  msal: 'entra-external-id',
  appwrite: 'appwrite',
  pocketbase: 'pocketbase',
  nhost: 'nhost',
  'hasura-auth': 'nhost',
  ...OSS_IDP_ALIASES,
  workos: 'workos',
  authkit: 'workos',
  'workos-authkit': 'workos',
  stytch: 'stytch',
  'stytch-b2b': 'stytch',
  frontegg: 'frontegg',
  propelauth: 'propelauth',
  'propel-auth': 'propelauth',
  magic: 'magic',
  'magic-link': 'magic',
  'magic.link': 'magic',
  magiclink: 'magic',
  userfront: 'userfront',
  corbado: 'corbado',
  saml: 'saml',
  'passport-saml': 'saml',
  samlify: 'saml',
  'node-saml': 'saml',
  'saml2-js': 'saml',
  onelogin: 'saml',
  ping: 'saml',
  pingfederate: 'saml',
};

export function resolveVendor(raw: string | undefined): MigrateVendor | undefined {
  return raw ? ALIASES[raw.trim().toLowerCase()] : undefined;
}

const TRANSFORMS: Record<Exclude<MigrateVendor, 'clerk'>, VendorTransform> = {
  authjs,
  supabase,
  auth0,
  'better-auth': betterAuth,
  okta,
  kinde,
  descope,
  'openid-client': openidClientToAtlas,
  jose: joseToAtlas,
  'generic-oidc': genericOidcToAtlas,
  lucia,
  passport,
  'iron-session': ironSession,
  firebase,
  cognito,
  'azure-ad-b2c': azure,
  'entra-external-id': azure,
  appwrite,
  pocketbase,
  nhost,
  ...OSS_IDP_TRANSFORMS,
  workos,
  stytch,
  frontegg,
  propelauth,
  magic,
  userfront,
  corbado,
  saml,
};

/** npm packages that belong to each vendor (removed once the manual items are done). */
const VENDOR_PACKAGES: Record<MigrateVendor, (name: string) => boolean> = {
  clerk: (n) => n.startsWith('@clerk/') || n === 'gatsby-plugin-clerk',
  authjs: (n) => n === 'next-auth' || n.startsWith('@auth/') || n.startsWith('@next-auth/'),
  // The Supabase client stays (it is the database client too); only the auth packages go.
  supabase: (n) => n.startsWith('@supabase/auth-helpers-') || n.startsWith('@supabase/auth-ui-'),
  auth0: (n) => n.startsWith('@auth0/') || n === 'auth0' || n === 'express-openid-connect' || n === 'express-oauth2-jwt-bearer',
  'better-auth': (n) => n === 'better-auth' || n.startsWith('@better-auth/'),
  okta: (n) => n.startsWith('@okta/'),
  kinde: (n) => n.startsWith('@kinde-oss/') || n.startsWith('@kinde/'),
  descope: (n) => n.startsWith('@descope/'),
  'openid-client': (n) => n === 'openid-client',
  // jose often signs and verifies other tokens too: it is never listed for removal.
  jose: () => false,
  'generic-oidc': (n) => n === 'openid-client',
  saml: (n) => ['passport-saml', '@node-saml/passport-saml', '@node-saml/node-saml', 'samlify', 'saml2-js', '@boxyhq/saml-jackson', 'onelogin'].includes(n),
  lucia: (n) => n === 'lucia' || n.startsWith('@lucia-auth/') || n === 'oslo' || n === 'arctic',
  passport: (n) =>
    n === 'passport' ||
    n.startsWith('passport-') ||
    n === '@node-saml/passport-saml' ||
    n.startsWith('@types/passport') ||
    n === 'express-session' ||
    n === '@types/express-session' ||
    n === 'cookie-session' ||
    n === 'connect-ensure-login' ||
    /^connect-(redis|mongo|mongodb-session|pg-simple|sqlite3|session-sequelize|session-knex|dynamodb|memcached)$/.test(n) ||
    n === 'memorystore' ||
    n === 'session-file-store',
  // sealData/unsealData may still use it: listed for removal once the report is worked through.
  'iron-session': (n) => n === 'iron-session' || n === 'next-iron-session',
  // Firebase, Amplify, Appwrite, PocketBase and Nhost keep serving data: only their auth-only packages go.
  firebase: (n) => n === 'react-firebase-hooks' || n === 'firebaseui' || n === 'react-firebaseui',
  cognito: (n) => n === 'amazon-cognito-identity-js' || n === 'aws-jwt-verify' || n === '@aws-amplify/adapter-nextjs',
  'azure-ad-b2c': (n) => n.startsWith('@azure/msal-') || n === 'passport-azure-ad',
  'entra-external-id': (n) => n.startsWith('@azure/msal-') || n === 'passport-azure-ad',
  appwrite: () => false,
  pocketbase: () => false,
  nhost: (n) => n === '@nhost/react' || n === '@nhost/nextjs' || n === '@nhost/vue',
  ...OSS_IDP_PACKAGES,
  workos: (n) => n.startsWith('@workos-inc/'),
  stytch: (n) => n === 'stytch' || n.startsWith('@stytch/'),
  frontegg: (n) => n.startsWith('@frontegg/'),
  propelauth: (n) => n.startsWith('@propelauth/'),
  magic: (n) => n === 'magic-sdk' || n.startsWith('@magic-sdk/') || n.startsWith('@magic-ext/'),
  userfront: (n) => n.startsWith('@userfront/'),
  corbado: (n) => n.startsWith('@corbado/'),
};

/** Social-provider credentials, which move into the Atlas dashboard. */
function providerEnv(k: string): string | null {
  return /^(GOOGLE|GITHUB|FACEBOOK|TWITTER|X|MICROSOFT|AZURE_AD|APPLE|DISCORD|LINKEDIN|GITLAB|SLACK|SPOTIFY|TWITCH)_(CLIENT_ID|CLIENT_SECRET|CALLBACK_URL|REDIRECT_URI)$/.test(k)
    ? 'remove after moving these provider credentials into the Atlas dashboard (Social connections)'
    : null;
}

/** MSAL settings for B2C / External ID: replaced by the Atlas keys. */
function msalEnv(k: string): string | null {
  return /^(NEXT_PUBLIC_|VITE_|REACT_APP_)?(AZURE_AD_B2C|AZURE_AD|AZURE_B2C|B2C|ENTRA(_EXTERNAL_ID)?|MSAL)_[A-Z0-9_]+$/.test(k)
    ? 'remove once nothing reads it (Atlas reads the ATLAS_* keys)'
    : null;
}

/** Generic OIDC settings: the issuer, client id and secret now come from your Atlas instance. */
function oidcEnv(k: string): string | null {
  if (/(^|_)(OIDC|OPENID|OAUTH|AUTH|SSO)_?(ISSUER|ISSUER_URL|DISCOVERY_URL|WELL_KNOWN)$/.test(k) || /^(OIDC|OPENID)_(ISSUER|DISCOVERY)/.test(k)) {
    return 'set to your Atlas issuer (GET /v1/instance → issuer)';
  }
  if (/^(OIDC|OPENID)_CLIENT_ID$/.test(k)) return 'set to the Atlas OAuth client_id';
  if (/^(OIDC|OPENID)_CLIENT_SECRET$/.test(k)) return 'set to the Atlas OAuth client secret (keep it server-side)';
  return null;
}

/** `.env` keys that belong to each vendor, with what replaces them. */
const VENDOR_ENV: Record<MigrateVendor, (key: string, style: EnvStyle) => string | null> = {
  clerk: (k, style) => {
    if (k.endsWith('CLERK_PUBLISHABLE_KEY')) return `replace with ${publicEnvKey(style, 'PUBLISHABLE_KEY')}`;
    if (k === 'CLERK_SECRET_KEY') return 'replace with ATLAS_SECRET_KEY';
    return /CLERK_/.test(k) ? 'remove (no Atlas counterpart)' : null;
  },
  authjs: (k) => {
    if (k === 'NEXTAUTH_SECRET' || k === 'AUTH_SECRET') return 'remove; set ATLAS_SECRET_KEY';
    if (k === 'NEXTAUTH_URL' || k === 'AUTH_URL' || k === 'NEXTAUTH_URL_INTERNAL' || k === 'AUTH_TRUST_HOST') return 'remove (not needed with Atlas)';
    if (/^AUTH_[A-Z0-9]+_(ID|SECRET|ISSUER)$/.test(k)) return 'remove after moving these provider credentials into the Atlas dashboard';
    return null;
  },
  supabase: (k) => (k === 'SUPABASE_JWT_SECRET' ? 'remove once nothing verifies Supabase tokens (Atlas tokens verify against ATLAS_JWKS_URL)' : null),
  auth0: (k, style) => {
    if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_)?AUTH0_DOMAIN$/.test(k)) return k.startsWith('AUTH0') ? 'replace with ATLAS_ISSUER' : `replace with ${publicEnvKey(style, 'FRONTEND_API')}`;
    if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_)AUTH0_CLIENT_ID$/.test(k)) return `replace with ${publicEnvKey(style, 'PUBLISHABLE_KEY')}`;
    if (k === 'AUTH0_ISSUER_BASE_URL' || k === 'ISSUER_BASE_URL') return 'replace with ATLAS_ISSUER';
    if (k === 'AUTH0_CLIENT_SECRET' || k === 'AUTH0_SECRET') return 'remove; set ATLAS_SECRET_KEY';
    if (/AUTH0_/.test(k) || k === 'APP_BASE_URL') return 'remove (not needed with Atlas)';
    return null;
  },
  'better-auth': (k) => (/BETTER_AUTH_/.test(k) ? 'remove (not needed with Atlas)' : null),
  okta: (k, style) => {
    if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_)OKTA_CLIENT_ID$/.test(k)) return `replace with ${publicEnvKey(style, 'PUBLISHABLE_KEY')}`;
    if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_)OKTA_(ISSUER|DOMAIN|ORG_URL|BASE_URL)$/.test(k)) return `replace with ${publicEnvKey(style, 'FRONTEND_API')}`;
    if (k === 'OKTA_ISSUER' || k === 'AUTH_OKTA_ISSUER') return 'replace with ATLAS_ISSUER';
    if (k === 'OKTA_CLIENT_SECRET' || k === 'AUTH_OKTA_SECRET' || k === 'OKTA_API_TOKEN') return 'remove; set ATLAS_SECRET_KEY';
    return /OKTA_/.test(k) ? 'remove (not needed with Atlas)' : null;
  },
  kinde: (k, style) => {
    if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_)KINDE_CLIENT_ID$/.test(k)) return `replace with ${publicEnvKey(style, 'PUBLISHABLE_KEY')}`;
    if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_)KINDE_DOMAIN$/.test(k)) return `replace with ${publicEnvKey(style, 'FRONTEND_API')}`;
    if (k === 'KINDE_ISSUER_URL' || k === 'KINDE_DOMAIN') return 'replace with ATLAS_ISSUER';
    if (k === 'KINDE_CLIENT_SECRET' || k === 'KINDE_M2M_CLIENT_SECRET') return 'remove; set ATLAS_SECRET_KEY';
    return /KINDE_/.test(k) ? 'remove (not needed with Atlas)' : null;
  },
  descope: (k, style) => {
    if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_)?DESCOPE_PROJECT_ID$/.test(k)) return `replace with ${publicEnvKey(style, 'PUBLISHABLE_KEY')}`;
    if (k === 'DESCOPE_MANAGEMENT_KEY') return 'remove; set ATLAS_SECRET_KEY';
    return /DESCOPE_/.test(k) ? 'remove (not needed with Atlas)' : null;
  },
  'openid-client': oidcEnv,
  jose: oidcEnv,
  'generic-oidc': oidcEnv,
  lucia: (k) => (/^LUCIA_/.test(k) ? 'remove (not needed with Atlas)' : providerEnv(k)),
  passport: (k) => {
    if (k === 'SESSION_SECRET' || k === 'COOKIE_SECRET' || k === 'EXPRESS_SESSION_SECRET') return 'remove with express-session (Atlas signs its own sessions)';
    if (k === 'JWT_SECRET' || k === 'JWT_PUBLIC_KEY') return 'remove once nothing else signs with it (Atlas tokens verify against ATLAS_JWKS_URL)';
    if (/^SAML_/.test(k)) return 'remove after moving these settings to the SAML enterprise SSO connection in the Atlas dashboard';
    return providerEnv(k);
  },
  'iron-session': (k) =>
    /^(SECRET_COOKIE_PASSWORD|IRON_SESSION_[A-Z0-9_]+|IRON_PASSWORD|SESSION_PASSWORD|COOKIE_PASSWORD)$/.test(k)
      ? 'remove unless sealData()/unsealData() still use it (Atlas signs its own sessions)'
      : null,
  firebase: (k) => (k === 'FIREBASE_AUTH_EMULATOR_HOST' ? 'remove (use a development Atlas instance instead of the Auth emulator)' : null),
  cognito: (k) =>
    /^(NEXT_PUBLIC_|VITE_|REACT_APP_)?(AWS_)?(COGNITO_|USER_POOL_)(ID|CLIENT_ID|WEB_CLIENT_ID|DOMAIN|REGION|USER_POOL_ID|USER_POOL_CLIENT_ID|IDENTITY_POOL_ID)$/.test(k)
      ? 'remove once nothing reads it (Atlas reads the ATLAS_* keys)'
      : null,
  'azure-ad-b2c': msalEnv,
  'entra-external-id': msalEnv,
  appwrite: () => null,
  pocketbase: () => null,
  nhost: (k) => (k === 'HASURA_GRAPHQL_JWT_SECRET' ? 'point it at the Atlas JWKS ({"type":"RS256","jwk_url":"<frontend API>/.well-known/jwks.json"}) with an Atlas JWT template for the Hasura claims' : null),
  ...OSS_IDP_ENV,
  workos: workosEnv,
  stytch: stytchEnv,
  frontegg: fronteggEnv,
  propelauth: propelauthEnv,
  magic: magicEnv,
  userfront: userfrontEnv,
  corbado: corbadoEnv,
  saml: (k) => (/^(SAML|SSO)_(ENTRY_POINT|ISSUER|CERT|IDP_CERT|CALLBACK_URL|PRIVATE_KEY)$/.test(k) ? 'remove after the IdP metadata is imported as an Atlas SSO connection' : null),
};

export interface MigrateOptions {
  from: MigrateVendor;
  /** When false (the default), nothing is written; `changes` still holds every diff. */
  write?: boolean;
}

export interface MigrateResult {
  vendor: MigrateVendor;
  envStyle: EnvStyle;
  filesScanned: number;
  filesChanged: number;
  rewrites: number;
  todos: number;
  changes: FileChange[];
  /** What the codemod could not rewrite, with file:line, sorted. */
  manual: ReportItem[];
  /** npm packages to add / remove. */
  packages: { add: string[]; remove: string[] };
  /** Env vars the migrated code reads (values come from the Atlas dashboard). */
  envToSet: string[];
}

/** Find the nearest package.json at or above `start`. */
function findPackageJson(start: string): string | undefined {
  let dir = statSync(start).isDirectory() ? start : dirname(start);
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readDeps(pkgPath: string | undefined): Record<string, string> {
  if (!pkgPath) return {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, Record<string, string> | undefined>;
    return { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  } catch {
    return {};
  }
}

/** How the project reads public env vars: Next (`NEXT_PUBLIC_`), Vite, CRA, else plain. */
export function detectEnvStyle(deps: Record<string, string>): EnvStyle {
  if (deps.next) return 'next';
  if (deps.vite || deps['@vitejs/plugin-react'] || deps['@sveltejs/kit'] || deps['@remix-run/dev']) return 'vite';
  if (deps['react-scripts']) return 'cra';
  return 'node';
}

function makeApi(): API {
  const j = jscodeshift.withParser('tsx');
  return { j, jscodeshift: j, stats: () => undefined, report: () => undefined };
}

/** Top-level `.env*` files (never descending into node_modules). */
function envFiles(root: string): string[] {
  const dir = statSync(root).isDirectory() ? root : dirname(root);
  try {
    return readdirSync(dir)
      .filter((n) => n === '.env' || n.startsWith('.env.'))
      .map((n) => join(dir, n))
      .filter((p) => statSync(p).isFile());
  } catch {
    return [];
  }
}

const ATLAS_IMPORT = /from\s+['"](@atlasauth\/[a-z0-9-]+)(?:\/[a-z0-9-]+)?['"]/g;

/**
 * Run a vendor → Atlas code migration over `root` (a directory or one file).
 *
 * Always computes every change (so a caller can print a dry-run diff) and only
 * touches disk when `write` is true. Idempotent: a second run over migrated code
 * changes nothing and reports the same manual items.
 */
export function runMigration(root: string, options: MigrateOptions): MigrateResult {
  const absRoot = resolve(root);
  const deps = readDeps(findPackageJson(absRoot));
  const envStyle = detectEnvStyle(deps);
  const api = makeApi();
  const files = collectSourceFiles(absRoot);
  const changes: FileChange[] = [];
  const manual: ReportItem[] = [];
  const atlasPackages = new Set<string>();
  let rewrites = 0;
  let todos = 0;

  const display = (file: string) => relative(absRoot, file) || file;

  for (const file of files) {
    const before = readFileSync(file, 'utf8');
    const shown = display(file);
    let after: string | undefined;
    try {
      if (options.from === 'clerk') {
        after = clerkToAtlas({ path: file, source: before }, api, {
          onCount: (kind) => (kind === 'todo' ? todos++ : rewrites++),
        });
        // The Clerk transform leaves markers only; turn them into report lines.
        (after ?? before).split('\n').forEach((line, i) => {
          const at = line.indexOf(TODO_PREFIX);
          if (at >= 0) manual.push({ file: shown, line: i + 1, message: line.slice(at + TODO_PREFIX.length).trim() });
        });
      } else {
        after = TRANSFORMS[options.from]({ path: file, source: before }, api, {
          envStyle,
          displayPath: shown,
          onReport: (item) => manual.push(item),
          onCount: (kind) => (kind === 'todo' ? todos++ : rewrites++),
        });
      }
    } catch (err) {
      manual.push({ file: shown, line: 0, message: `could not parse this file (${(err as Error).message.split('\n')[0]}); migrate it by hand` });
      continue;
    }
    const finalText = after ?? before;
    for (const m of finalText.matchAll(ATLAS_IMPORT)) atlasPackages.add(m[1]!);
    if (after !== undefined && after !== before) {
      changes.push({ path: shown, before, after });
      if (options.write) writeFileSync(file, after, 'utf8');
    }
  }

  // .env files: report vendor keys and what replaces them (values never read out).
  for (const envFile of envFiles(absRoot)) {
    const shown = display(envFile);
    readFileSync(envFile, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
        if (!key) return;
        const note = VENDOR_ENV[options.from](key, envStyle);
        if (note) manual.push({ file: shown, line: i + 1, message: `${key}: ${note}` });
      });
  }

  const remove = Object.keys(deps).filter(VENDOR_PACKAGES[options.from]).sort();
  const add = [...atlasPackages].filter((p) => !deps[p]).sort();
  const envToSet = [publicEnvKey(envStyle, 'PUBLISHABLE_KEY'), publicEnvKey(envStyle, 'FRONTEND_API')];
  if (atlasPackages.has('@atlasauth/nextjs') || envStyle === 'next') envToSet.push('ATLAS_SECRET_KEY', 'ATLAS_JWKS_URL', 'ATLAS_ISSUER');
  else if (atlasPackages.has('@atlasauth/express')) envToSet.push('ATLAS_JWKS_URL', 'ATLAS_ISSUER');

  manual.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

  return {
    vendor: options.from,
    envStyle,
    filesScanned: files.length,
    filesChanged: changes.length,
    rewrites,
    todos,
    changes,
    manual,
    packages: { add, remove },
    envToSet,
  };
}

/** Human-readable summary lines for a migration result (shared by both CLIs). */
export function formatMigration(result: MigrateResult, opts: { written: boolean; command?: string }): string[] {
  const lines: string[] = [];
  lines.push(`${opts.command ?? 'atlas migrate code'} --from ${result.vendor}`);
  lines.push(`  files scanned:   ${result.filesScanned}`);
  lines.push(`  files changed:   ${result.filesChanged}${opts.written ? '' : ' (dry run: nothing written)'}`);
  lines.push(`  rewrites:        ${result.rewrites}`);
  if (result.manual.length > 0) {
    lines.push('');
    lines.push(`Needs a manual look (${result.manual.length}), also marked in code with "TODO(atlas-migrate)":`);
    for (const item of result.manual) lines.push(`  ${item.file}${item.line ? `:${item.line}` : ''}  ${item.message}`);
  }
  lines.push('');
  lines.push('Next steps:');
  if (result.packages.add.length > 0) lines.push(`  npm install ${result.packages.add.join(' ')}`);
  lines.push(`  Set ${result.envToSet.join(', ')} (values from the Atlas dashboard, API keys page).`);
  if (result.packages.remove.length > 0) {
    lines.push(`  When the items above are done: npm uninstall ${result.packages.remove.join(' ')}`);
  }
  if (MIGRATE_EXPORT_VENDORS.includes(result.vendor)) {
    lines.push(`  Move your users: atlas migrate ${result.vendor} export, then atlas migrate ${result.vendor} import`);
  } else if (EXPORTABLE_VENDORS.includes(result.vendor)) {
    lines.push(`  Move your users: atlas migrate export ${result.vendor} (encrypted bundle), then import it from the dashboard (Users → Migrate) or the CLI`);
  } else if (IMPORTABLE_VENDORS.includes(result.vendor) && result.vendor !== 'clerk') {
    lines.push(`  Move your users: atlas import --from ${result.vendor} <export-file> --dry-run`);
  } else if (FRAMEWORK_VENDORS.includes(result.vendor)) {
    lines.push(`  Move your users, config and sessions: atlas migrate ${result.vendor} --dry-run`);
  }
  if (!opts.written && result.filesChanged > 0) lines.push('  Re-run with --yes to apply the changes.');
  return lines;
}

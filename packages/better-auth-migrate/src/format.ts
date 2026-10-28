/**
 * The Atlas Better Auth bundle: what the exporter writes and Atlas reads.
 *
 * Plaintext layer (never written to disk): newline-delimited JSON entries.
 *   1. one `manifest` entry,
 *   2. any number of `record` entries, each one row of one Better Auth model,
 *      in {@link MODEL_ORDER} (rows a later model references come first),
 *   3. one `end` entry carrying the per-model counts, so a reader can prove it
 *      saw every row the exporter wrote.
 *
 * Transport layer (what lands on disk and travels to Atlas): see transport.ts.
 * The plaintext is cut into chunks and each chunk is sealed with AES-256-GCM
 * under a key only the Atlas instance can derive.
 */

/** The bundle format identifier, checked by the reader. */
export const BUNDLE_FORMAT = 'atlas-better-auth-bundle';
/** Bump on an incompatible change to the entries below. */
export const BUNDLE_FORMAT_VERSION = 1;

/**
 * Every Better Auth model the exporter knows, by its logical name (the key
 * Better Auth's schema uses, whatever table name the app maps it to), in the
 * order they are written. A model a later one points at comes first:
 * organizations before members, users before accounts, SSO providers before the
 * accounts that sign in through them.
 */
export const MODEL_ORDER = [
  'organization',
  'organizationRole',
  'user',
  'ssoProvider',
  'account',
  'twoFactor',
  'passkey',
  'member',
  'team',
  'teamMember',
  'invitation',
  'apikey',
  'oauthClient',
  'oauthApplication',
  'oauthConsent',
  'oauthAccessToken',
  'oauthRefreshToken',
  'subscription',
  'jwks',
  'session',
  'verification',
] as const;

export type BetterAuthModel = (typeof MODEL_ORDER)[number];

export function isKnownModel(model: string): model is BetterAuthModel {
  return (MODEL_ORDER as readonly string[]).includes(model);
}

/** What the exporter learned about the source app, written first. */
export interface BundleManifest {
  type: 'manifest';
  format: typeof BUNDLE_FORMAT;
  formatVersion: number;
  exportedAt: string;
  exporter: { name: string; version: string };
  betterAuth: {
    /** Better Auth's own version string, when the instance reports one. */
    version: string | null;
    baseURL: string | null;
    basePath: string | null;
  };
  /** Plugin ids present on the source instance (`two-factor`, `passkey`, …). */
  plugins: string[];
  /** Models present in the source schema, logical name → table/collection name. */
  models: Record<string, string>;
  /** The WebAuthn relying-party id passkeys were registered against. */
  rpId: string | null;
  /** The social providers configured on the source instance. */
  socialProviders: string[];
  /** Settings the importer needs to interpret the rows. */
  settings: {
    twoFactor?: { digits: number; period: number; issuer: string | null };
    apiKey?: { hashing: 'sha256' | 'none' };
    oauthProvider?: { clientSecretStorage: string; clientSecretPrefix: string | null };
    /** True when sessions live only in secondary storage (Redis) and could not be read. */
    sessionsInSecondaryStorage?: boolean;
    /** True when OAuth access/refresh tokens were included (decrypted) in account rows. */
    oauthTokensIncluded?: boolean;
  };
  /** Things the exporter could not do, in plain words. */
  warnings: string[];
}

/** One row of one model. `data` uses Better Auth's logical field names. */
export interface BundleRecord {
  type: 'record';
  model: BetterAuthModel;
  data: Record<string, unknown>;
}

/** The last entry: how many rows of each model were written. */
export interface BundleEnd {
  type: 'end';
  counts: Record<string, number>;
  /** Rows the exporter left out on purpose (expired sessions, …), with why. */
  omitted: Record<string, { count: number; reason: string }>;
}

export type BundleEntry = BundleManifest | BundleRecord | BundleEnd;

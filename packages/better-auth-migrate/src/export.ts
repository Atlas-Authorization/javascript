import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import {
  BUNDLE_FORMAT,
  BUNDLE_FORMAT_VERSION,
  MODEL_ORDER,
  type BetterAuthModel,
  type BundleManifest,
} from './format';
import { base32Encode, betterAuthDecrypt, looksEncrypted, type BetterAuthSecret } from './ba-crypto';
import { BundleSealer, parseImportPublicKey, type ImportPublicKey } from './transport';
import { PACKAGE_VERSION } from './version';

/**
 * The slice of a Better Auth instance the exporter reads. It is structural on
 * purpose: the exporter goes through the app's OWN database adapter
 * (`auth.$context` → `adapter.findMany`), so it works with every adapter Better
 * Auth supports (Prisma, Drizzle, Kysely, MongoDB, memory, custom) and with
 * custom table and field names, without depending on a Better Auth version.
 */
export interface BetterAuthLike {
  $context: Promise<BetterAuthContextLike> | BetterAuthContextLike;
  options?: Record<string, unknown>;
}

export interface BetterAuthContextLike {
  adapter: {
    findMany<T = Record<string, unknown>>(data: {
      model: string;
      where?: Array<{ field: string; value: unknown; operator?: string; connector?: 'AND' | 'OR' }>;
      limit?: number;
      sortBy?: { field: string; direction: 'asc' | 'desc' };
      offset?: number;
    }): Promise<T[]>;
    count?(data: { model: string; where?: unknown[] }): Promise<number>;
  };
  /** Logical model name → `{ modelName, fields }`. */
  tables?: Record<string, { modelName?: string; fields?: Record<string, unknown> }>;
  secret?: string;
  secretConfig?: BetterAuthSecret;
  baseURL?: string;
  version?: string;
  options?: {
    baseURL?: unknown;
    basePath?: string;
    plugins?: Array<{ id?: string; options?: Record<string, unknown> } | null | undefined>;
    socialProviders?: Record<string, unknown>;
    account?: { encryptOAuthTokens?: boolean };
    secondaryStorage?: unknown;
    session?: { storeSessionInDatabase?: boolean };
    [k: string]: unknown;
  };
}

/** Where the sealed bundle goes: a file path, or a line sink you provide. */
export type BundleSink = string | { write(line: string): void | Promise<void>; close?(): void | Promise<void> };

export interface ExportBetterAuthOptions {
  /** A file path (written atomically: `<out>.partial`, renamed when complete), or a line sink. */
  out: BundleSink;
  /**
   * The Atlas instance's import public key: `{ kid, public_key }` from
   * `GET /v1/better_auth_imports/public_key`, or the `kid:key` string the
   * dashboard and CLI print. The bundle opens only for that instance.
   */
  publicKey: ImportPublicKey | { kid: string; public_key: string } | string;
  /** Rows per adapter page (keyset-paginated by id). Default 500. */
  pageSize?: number;
  /** Export only these models (default: every model present). */
  models?: BetterAuthModel[];
  /** Include live sessions (hashed) for the session bridge. Default true. */
  sessions?: boolean;
  /** Include OAuth access/refresh/id tokens on account rows (decrypted when Better Auth encrypts them). Default false. */
  oauthTokens?: boolean;
  /** Include verification rows (email-verification / reset tokens). Default false: they expire within minutes. */
  verifications?: boolean;
  /**
   * The secret Better Auth encrypts with. Defaults to the instance's own
   * (`ctx.secretConfig`, i.e. BETTER_AUTH_SECRET / `secrets`).
   */
  secret?: BetterAuthSecret;
  /** How API keys are stored. 'auto' (default) reads it from the rows; 'none' = `disableKeyHashing`. */
  apiKeyHashing?: 'auto' | 'sha256' | 'none';
  /**
   * How OAuth client secrets are stored ('hashed' | 'encrypted' | 'plain').
   * Default: the oauth-provider plugin's `storeClientSecret` (hashed unless the JWT
   * plugin is disabled), 'plain' for the legacy oidc-provider `oauthApplication`.
   */
  oauthClientSecretStorage?: 'hashed' | 'encrypted' | 'plain';
  /** Decrypt function for a custom `storeBackupCodes: { encrypt, decrypt }`. */
  decryptBackupCodes?: (stored: string) => string | Promise<string>;
  /** Called after each page. */
  onProgress?: (progress: { model: string; exported: number }) => void;
  /** Clock override (tests). */
  now?: () => Date;
}

export interface ExportBetterAuthResult {
  /** The file written, when `out` was a path. */
  path: string | null;
  manifest: BundleManifest;
  counts: Record<string, number>;
  omitted: Record<string, { count: number; reason: string }>;
  /** Sealed chunks written. */
  chunks: number;
  /** Bytes of sealed output (header + chunks + newlines). */
  bytes: number;
  /** SHA-256 (hex) of the sealed output, the value Atlas reports back after upload. */
  sha256: string;
}

function plugin(ctx: BetterAuthContextLike, id: string) {
  return (ctx.options?.plugins ?? []).find((p) => p && p.id === id) ?? null;
}

function jsonish(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

/** Dates to ISO strings; everything else JSON-safe (bigint → number/string). */
function normalise(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    if (v instanceof Date) out[k] = Number.isNaN(v.getTime()) ? null : v.toISOString();
    else if (typeof v === 'bigint') out[k] = Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
    else if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { toHexString?: unknown }).toHexString === 'function') {
      out[k] = String(v); // a MongoDB ObjectId that slipped through
    } else out[k] = v;
  }
  return out;
}

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const sha256B64Url = (s: string) => createHash('sha256').update(s, 'utf8').digest('base64url');

/** Every row of one model, read through the app's adapter, keyset-paginated by id. */
async function* pages(
  ctx: BetterAuthContextLike,
  model: string,
  pageSize: number,
): AsyncGenerator<Record<string, unknown>[]> {
  let last: unknown = undefined;
  for (;;) {
    const rows = await ctx.adapter.findMany<Record<string, unknown>>({
      model,
      ...(last !== undefined ? { where: [{ field: 'id', operator: 'gt', value: last }] } : {}),
      sortBy: { field: 'id', direction: 'asc' },
      limit: pageSize,
    });
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < pageSize) return;
    const next = rows[rows.length - 1]!.id;
    if (next === undefined || next === last) return;
    last = next;
  }
}

class FileSink {
  private readonly stream;
  private readonly partial: string;
  constructor(private readonly path: string) {
    this.partial = `${path}.partial`;
    this.stream = createWriteStream(this.partial, { encoding: 'utf8', mode: 0o600 });
  }
  write(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.write(`${line}\n`, (err) => (err ? reject(err) : resolve()));
    });
  }
  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.stream.end((err?: Error | null) => (err ? reject(err) : resolve())));
    await rename(this.partial, this.path);
  }
  async abort(): Promise<void> {
    await new Promise<void>((resolve) => this.stream.end(() => resolve()));
    await unlink(this.partial).catch(() => undefined);
  }
}

/**
 * Export a Better Auth instance into a sealed Atlas bundle.
 *
 * ```ts
 * import { auth } from './auth';
 * import { exportBetterAuth } from '@atlasauth/better-auth-migrate';
 *
 * await exportBetterAuth(auth, {
 *   out: 'better-auth.atlas-bundle',
 *   publicKey: process.env.ATLAS_IMPORT_KEY!, // from GET /v1/better_auth_imports/public_key
 * });
 * ```
 *
 * Every model present in the app's schema is read page by page through its own
 * adapter. Secrets Better Auth encrypts with BETTER_AUTH_SECRET (two-factor
 * secrets and backup codes, encrypted OAuth tokens and client secrets) are
 * decrypted in memory and sealed straight into the bundle; plaintext never
 * touches disk. Session tokens are reduced to their SHA-256 before they leave.
 */
export async function exportBetterAuth(
  auth: BetterAuthLike,
  options: ExportBetterAuthOptions,
): Promise<ExportBetterAuthResult> {
  const ctx = await auth.$context;
  if (!ctx?.adapter || typeof ctx.adapter.findMany !== 'function') {
    throw new Error('exportBetterAuth needs a Better Auth instance (the value returned by betterAuth({...})).');
  }
  const recipient = parseImportPublicKey(options.publicKey);
  const now = options.now ?? (() => new Date());
  const pageSize = Math.max(1, Math.min(options.pageSize ?? 500, 5000));
  const secret: BetterAuthSecret | undefined = options.secret ?? ctx.secretConfig ?? ctx.secret;
  const includeSessions = options.sessions !== false;
  const warnings: string[] = [];

  const tables = ctx.tables ?? {};
  const present = (m: string) => (Object.keys(tables).length === 0 ? ['user', 'account', 'session', 'verification'].includes(m) : m in tables);
  const wanted = new Set<string>(options.models ?? MODEL_ORDER);
  const models = MODEL_ORDER.filter((m) => wanted.has(m) && present(m));

  const twoFactorPlugin = plugin(ctx, 'two-factor');
  const totp = (twoFactorPlugin?.options?.totpOptions ?? {}) as { digits?: number; period?: number };
  const backupStorage = ((twoFactorPlugin?.options?.backupCodeOptions as { storeBackupCodes?: unknown } | undefined)?.storeBackupCodes ?? 'encrypted') as unknown;
  const passkeyPlugin = plugin(ctx, 'passkey');
  const oauthProviderPlugin = plugin(ctx, 'oauth-provider');
  const oauthOpts = (oauthProviderPlugin?.options ?? {}) as { storeClientSecret?: unknown; disableJwtPlugin?: boolean; prefix?: { clientSecret?: string } };
  const oidcPlugin = plugin(ctx, 'oidc') ?? plugin(ctx, 'oidc-provider');
  const oidcOpts = (oidcPlugin?.options ?? {}) as { storeClientSecret?: unknown };
  const clientSecretStorage =
    options.oauthClientSecretStorage ??
    (typeof oauthOpts.storeClientSecret === 'string' ? oauthOpts.storeClientSecret : oauthOpts.disableJwtPlugin ? 'encrypted' : 'hashed');
  const legacyClientSecretStorage =
    options.oauthClientSecretStorage ?? (typeof oidcOpts.storeClientSecret === 'string' ? oidcOpts.storeClientSecret : 'plain');
  const encryptTokens = ctx.options?.account?.encryptOAuthTokens === true;
  const sessionsSecondaryOnly = Boolean(ctx.options?.secondaryStorage) && ctx.options?.session?.storeSessionInDatabase !== true;

  const baseURL = typeof ctx.baseURL === 'string' && ctx.baseURL ? ctx.baseURL : typeof ctx.options?.baseURL === 'string' ? (ctx.options.baseURL as string) : null;
  let rpId: string | null = typeof passkeyPlugin?.options?.rpID === 'string' ? (passkeyPlugin.options.rpID as string) : null;
  if (!rpId && passkeyPlugin) {
    try {
      rpId = baseURL ? new URL(baseURL).hostname : 'localhost';
    } catch {
      rpId = null;
    }
  }

  const decrypt = (value: string): string => {
    if (secret === undefined) throw new Error('no secret');
    return betterAuthDecrypt(secret, value);
  };

  const manifest: BundleManifest = {
    type: 'manifest',
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_FORMAT_VERSION,
    exportedAt: now().toISOString(),
    exporter: { name: '@atlasauth/better-auth-migrate', version: PACKAGE_VERSION },
    betterAuth: {
      version: typeof ctx.version === 'string' ? ctx.version : null,
      baseURL,
      basePath: typeof ctx.options?.basePath === 'string' ? ctx.options.basePath : null,
    },
    plugins: (ctx.options?.plugins ?? []).map((p) => p?.id).filter((x): x is string => typeof x === 'string'),
    models: Object.fromEntries(models.map((m) => [m, String(tables[m]?.modelName ?? m)])),
    rpId,
    socialProviders: Object.keys(ctx.options?.socialProviders ?? {}),
    settings: {
      ...(twoFactorPlugin
        ? {
            twoFactor: {
              digits: Number(totp.digits ?? 6),
              period: Number(totp.period ?? 30),
              issuer: typeof twoFactorPlugin.options?.issuer === 'string' ? (twoFactorPlugin.options.issuer as string) : null,
            },
          }
        : {}),
      ...(models.includes('apikey') ? { apiKey: { hashing: options.apiKeyHashing === 'none' ? 'none' : 'sha256' } } : {}),
      ...(oauthProviderPlugin || models.includes('oauthClient')
        ? { oauthProvider: { clientSecretStorage: String(clientSecretStorage), clientSecretPrefix: oauthOpts.prefix?.clientSecret ?? null } }
        : {}),
      ...(sessionsSecondaryOnly ? { sessionsInSecondaryStorage: true } : {}),
      ...(options.oauthTokens ? { oauthTokensIncluded: true } : {}),
    },
    warnings,
  };
  if (sessionsSecondaryOnly && includeSessions) {
    warnings.push('Sessions are stored in secondary storage (for example Redis) and are not in the database, so they were not exported. Signed-in users sign in once more after the cutover.');
  }

  // ── output ──────────────────────────────────────────────────────────────
  const hasher = createHash('sha256');
  let bytes = 0;
  const fileSink = typeof options.out === 'string' ? new FileSink(options.out) : null;
  const sink = fileSink ?? (options.out as Exclude<BundleSink, string>);
  const writeLine = async (line: string) => {
    hasher.update(`${line}\n`, 'utf8');
    bytes += Buffer.byteLength(line, 'utf8') + 1;
    await sink.write(line);
  };
  const sealer = new BundleSealer(recipient, writeLine);

  const counts: Record<string, number> = {};
  const omitted: Record<string, { count: number; reason: string }> = {};
  const omit = (model: string, reason: string) => {
    const o = (omitted[model] ??= { count: 0, reason });
    o.count += 1;
  };
  let decryptFailures = 0;

  try {
    await sealer.add(manifest);
    for (const model of models) {
      counts[model] = 0;
      if (model === 'verification' && !options.verifications) {
        const n = ctx.adapter.count ? await ctx.adapter.count({ model }).catch(() => 0) : 0;
        if (n > 0) omitted.verification = { count: n, reason: 'Verification tokens expire within minutes; pending verifications are re-sent from Atlas.' };
        continue;
      }
      if (model === 'oauthAccessToken' || model === 'oauthRefreshToken') {
        // Tokens Better Auth issued as a provider: Atlas cannot honour them (they
        // are opaque to it), so only their number is reported.
        const n = ctx.adapter.count ? await ctx.adapter.count({ model }).catch(() => 0) : 0;
        if (n > 0) omitted[model] = { count: n, reason: 'Access and refresh tokens issued by your Better Auth OAuth provider are not portable; clients get Atlas tokens on their next authorization.' };
        continue;
      }
      if (model === 'session' && (!includeSessions || sessionsSecondaryOnly)) continue;

      let exported = 0;
      for await (const page of pages(ctx, model, pageSize)) {
        for (const raw of page) {
          const row = normalise(raw);
          const data = await transform(model, row);
          if (!data) continue;
          await sealer.add({ type: 'record', model, data });
          exported += 1;
        }
        counts[model] = exported;
        options.onProgress?.({ model, exported });
      }
    }
    await sealer.add({ type: 'end', counts, omitted });
    const chunks = await sealer.finish();
    if (fileSink) await fileSink.close();
    else await sink.close?.();
    if (decryptFailures > 0) {
      warnings.push(`${decryptFailures} encrypted value(s) could not be decrypted with the configured secret and were left out (see the decryptError field on those rows).`);
    }
    return {
      path: typeof options.out === 'string' ? options.out : null,
      manifest,
      counts,
      omitted,
      chunks,
      bytes,
      sha256: hasher.digest('hex'),
    };
  } catch (err) {
    if (fileSink) await fileSink.abort();
    throw err;
  }

  // ── per-model transforms ──────────────────────────────────────────────────
  async function transform(model: string, row: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    switch (model) {
      case 'user': {
        for (const k of ['metadata']) if (k in row) row[k] = jsonish(row[k]);
        return row;
      }
      case 'account': {
        const tokenFields = ['accessToken', 'refreshToken', 'idToken'] as const;
        if (!options.oauthTokens) {
          for (const f of tokenFields) delete row[f];
        } else if (encryptTokens) {
          for (const f of tokenFields) {
            const v = row[f];
            if (typeof v === 'string' && v && looksEncrypted(v)) {
              try {
                row[f] = decrypt(v);
              } catch {
                delete row[f];
                row.decryptError = true;
                decryptFailures += 1;
              }
            }
          }
        }
        return row;
      }
      case 'session': {
        const token = typeof row.token === 'string' ? row.token : '';
        const expires = typeof row.expiresAt === 'string' ? Date.parse(row.expiresAt) : NaN;
        if (!token || (Number.isFinite(expires) && expires <= now().getTime())) {
          omit('session', 'Expired sessions are not exported.');
          return null;
        }
        delete row.token;
        row.tokenHash = sha256Hex(token);
        return row;
      }
      case 'twoFactor': {
        const out: Record<string, unknown> = { ...row };
        const s = typeof row.secret === 'string' ? row.secret : '';
        delete out.secret;
        delete out.backupCodes;
        try {
          const plain = s ? decrypt(s) : '';
          if (plain) {
            out.secret = plain;
            // Better Auth's TOTP keys HMAC with the secret's UTF-8 bytes and shows
            // authenticator apps their base32 — so this is the value users scanned.
            out.secretBase32 = base32Encode(Buffer.from(plain, 'utf8'));
          }
        } catch {
          out.decryptError = true;
          decryptFailures += 1;
        }
        const codes = typeof row.backupCodes === 'string' ? row.backupCodes : '';
        if (codes) {
          try {
            let json: string;
            if (options.decryptBackupCodes) json = await options.decryptBackupCodes(codes);
            else if (backupStorage === 'encrypted' || (backupStorage !== 'plain' && looksEncrypted(codes))) json = decrypt(codes);
            else json = codes;
            const parsed = JSON.parse(json) as unknown;
            if (Array.isArray(parsed)) out.backupCodes = parsed.filter((c) => typeof c === 'string');
          } catch {
            out.backupCodesDecryptError = true;
            decryptFailures += 1;
          }
        }
        return out;
      }
      case 'apikey': {
        const key = typeof row.key === 'string' ? row.key : '';
        delete row.key;
        const hashing =
          options.apiKeyHashing && options.apiKeyHashing !== 'auto'
            ? options.apiKeyHashing
            : /^[A-Za-z0-9_-]{43}$/.test(key)
              ? 'sha256'
              : 'none';
        // A key stored in the clear (`disableKeyHashing`) leaves as its hash,
        // in the same format the default hasher writes, so it verifies unchanged.
        row.keyHash = hashing === 'sha256' ? key : sha256B64Url(key);
        row.keyHashSource = hashing === 'sha256' ? 'stored' : 'derived';
        for (const k of ['permissions', 'metadata']) if (k in row) row[k] = jsonish(row[k]);
        // Some adapters return the metadata as a JSON string twice-encoded.
        if (typeof row.metadata === 'string') row.metadata = jsonish(row.metadata);
        return row;
      }
      case 'organization':
      case 'invitation':
      case 'member':
      case 'team':
      case 'teamMember':
      case 'subscription':
      case 'oauthConsent':
      case 'passkey': {
        if ('metadata' in row) row.metadata = jsonish(row.metadata);
        return row;
      }
      case 'organizationRole': {
        if ('permission' in row) row.permission = jsonish(row.permission);
        return row;
      }
      case 'ssoProvider': {
        row.oidcConfig = jsonish(row.oidcConfig);
        row.samlConfig = jsonish(row.samlConfig);
        return row;
      }
      case 'oauthClient':
      case 'oauthApplication': {
        const storage = model === 'oauthClient' ? clientSecretStorage : legacyClientSecretStorage;
        const stored = typeof row.clientSecret === 'string' ? row.clientSecret : '';
        delete row.clientSecret;
        if (stored) {
          if (storage === 'hashed') row.clientSecretHash = stored;
          else if (storage === 'encrypted') {
            try {
              row.clientSecret = decrypt(stored);
            } catch {
              row.decryptError = true;
              decryptFailures += 1;
            }
          } else if (storage === 'plain') row.clientSecret = stored;
          else row.clientSecretUnreadable = true; // a custom hash/encrypt function
        }
        row.clientSecretPrefix = model === 'oauthClient' ? (oauthOpts.prefix?.clientSecret ?? null) : null;
        for (const k of ['metadata', 'jwks']) if (k in row) row[k] = jsonish(row[k]);
        return row;
      }
      case 'jwks': {
        // Only the PUBLIC key travels: it is all Atlas needs to keep verifying the
        // JWTs your Better Auth instance already issued. The private key stays put.
        const pub = jsonish(row.publicKey);
        return {
          id: row.id,
          publicKey: pub,
          alg: row.alg ?? null,
          crv: row.crv ?? null,
          createdAt: row.createdAt ?? null,
          expiresAt: row.expiresAt ?? null,
        };
      }
      case 'verification':
        return row;
      default:
        return row;
    }
  }
}

/**
 * Keep a row in YOUR user table in step with the Atlas user signing in, on
 * first login and every login after: find by Atlas `sub`, else link an existing
 * row by a proven email, else create one. Race-safe when your `create` enforces
 * a unique `sub` (two first requests in parallel end on the same row).
 *
 * Linking by email follows the pre-account hijacking rule: a row is linked only
 * when BOTH sides proved the address — the token's `email_verified === true` and
 * your own `isLocalEmailVerified(row)` — and only when the row isn't already
 * bound to another Atlas user.
 */

/** The claims `syncLocalUser` reads (a verified `SessionClaims` fits). */
export interface SyncLocalUserClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  external_id?: string;
}

/** What `create` receives. */
export interface NewLocalUser {
  sub: string;
  email: string | undefined;
  email_verified: boolean;
  external_id: string | undefined;
}

/** The request that triggered the sync, passed through to `create` and `link` (for example to report a server-side sign-up). */
export interface SyncLocalUserContext {
  request?: { headers?: Headers | Record<string, string | string[] | undefined>; ip?: string };
}

export interface SyncLocalUserOptions<Row> {
  /** Your row bound to this Atlas user, or null. */
  findBySub(sub: string): Promise<Row | null | undefined>;
  /** Your row with this email, or null. Called only for a verified token email. */
  findByEmail(email: string): Promise<Row | null | undefined>;
  /** The row's Atlas sub, or null/empty when it isn't bound to an Atlas user yet. */
  subOf(row: Row): string | null | undefined;
  /**
   * Whether YOUR app proved the row's email. Required: linking a row whose
   * address was never proven lets whoever pre-registered it take the account.
   */
  isLocalEmailVerified(row: Row): boolean | Promise<boolean>;
  /** Bind the row to the Atlas sub; returns the updated row. */
  link(row: Row, sub: string, context: SyncLocalUserContext): Promise<Row>;
  /** Insert a new row. Must reject a second row for the same sub (a unique index). */
  create(user: NewLocalUser, context: SyncLocalUserContext): Promise<Row>;
  /** Whether `create` failed on a unique constraint. Default: Postgres 23505 or /duplicate|unique/i. */
  isDuplicateError?(error: unknown): boolean;
  /**
   * Also write the local row's id to the Atlas user as `external_id`, in the same flow (an idempotent
   * `PATCH /v1/users/{sub}` with retry), so the next session token carries it and no follow-up call is needed in
   * your app. Runs after the row is found, linked or created, and only while the token's `external_id` differs.
   * Needs `localIdOf`, and `atlas` (default: a client built from `ATLAS_SECRET_KEY` / `ATLAS_API_URL`).
   */
  writeExternalId?: boolean;
  /** Your row's id, as a string: what `writeExternalId` writes. */
  localIdOf?(row: Row): string;
  /** The management client used by `writeExternalId`. Default: `createAtlasClient` from the environment. */
  atlas?: ExternalIdWriter;
  /** `writeExternalId` retries: attempts (default 3) and the first backoff in ms (default 200, doubling). A 4xx other than 408/429 is never retried. */
  externalIdRetry?: { attempts?: number; delayMs?: number };
}

/** What `writeExternalId` needs from a management client: `createAtlasClient(...)` fits. */
export interface ExternalIdWriter {
  users: { setExternalId(id: string, externalId: string | null): Promise<unknown> };
}

export interface SyncLocalUserResult<Row> {
  user: Row;
  created: boolean;
  linked: boolean;
  /** `writeExternalId` only: true when this call wrote the `external_id` (false when the token already carried it). */
  externalIdWritten?: boolean;
}

/** `writeExternalId` could not be completed after its retries. The local row is in `result`; the next sign-in tries again. */
export class AtlasExternalIdWriteError extends Error {
  readonly code = 'atlas_external_id_write_failed';
  constructor(
    readonly result: SyncLocalUserResult<unknown>,
    override readonly cause: unknown,
  ) {
    super('syncLocalUser: could not write external_id to Atlas; it is retried on the next sign-in.');
    this.name = 'AtlasExternalIdWriteError';
  }
}

/** The email matches a row already bound to a different Atlas user. Never relinked. */
export class AtlasLinkConflictError extends Error {
  readonly code = 'atlas_link_conflict';
  constructor(
    readonly email: string,
    readonly existingSub: string,
    readonly sub: string,
  ) {
    super(`A local user with this email is already linked to another Atlas user.`);
    this.name = 'AtlasLinkConflictError';
  }
}

export function defaultIsDuplicateError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && /duplicate|unique/i.test(e.message);
}

export async function syncLocalUser<Row>(
  claims: SyncLocalUserClaims,
  options: SyncLocalUserOptions<Row>,
  context: SyncLocalUserContext = {},
): Promise<SyncLocalUserResult<Row>> {
  const result = await syncRow(claims, options, context);
  if (!options.writeExternalId) return result;
  if (!options.localIdOf) throw new TypeError('syncLocalUser: `writeExternalId` needs `localIdOf(row)`');
  const localId = String(options.localIdOf(result.user));
  if (localId === '' || claims.external_id === localId) return { ...result, externalIdWritten: false };
  const writer = options.atlas ?? (await envClient());
  const attempts = Math.max(1, options.externalIdRetry?.attempts ?? 3);
  let delay = options.externalIdRetry?.delayMs ?? 200;
  for (let i = 1; ; i++) {
    try {
      await writer.users.setExternalId(claims.sub, localId);
      return { ...result, externalIdWritten: true };
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status;
      const permanent = typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (permanent || i >= attempts) throw new AtlasExternalIdWriteError(result, error);
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

async function envClient(): Promise<ExternalIdWriter> {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  if (!env.ATLAS_SECRET_KEY) {
    throw new TypeError('syncLocalUser: `writeExternalId` needs the `atlas` option or ATLAS_SECRET_KEY in the environment');
  }
  const { createAtlasClient } = await import('./client');
  return createAtlasClient({ secretKey: env.ATLAS_SECRET_KEY, apiUrl: env.ATLAS_API_URL });
}

async function syncRow<Row>(
  claims: SyncLocalUserClaims,
  options: SyncLocalUserOptions<Row>,
  context: SyncLocalUserContext,
): Promise<SyncLocalUserResult<Row>> {
  const { sub } = claims;
  if (typeof sub !== 'string' || sub === '') throw new TypeError('syncLocalUser: claims.sub is required');

  const bound = await options.findBySub(sub);
  if (bound) return { user: bound, created: false, linked: false };

  const email = typeof claims.email === 'string' && claims.email !== '' ? claims.email : undefined;
  if (email && claims.email_verified === true) {
    const row = await options.findByEmail(email);
    if (row) {
      const existingSub = options.subOf(row);
      if (existingSub && existingSub !== sub) throw new AtlasLinkConflictError(email, existingSub, sub);
      if (existingSub === sub) return { user: row, created: false, linked: false };
      if (await options.isLocalEmailVerified(row)) {
        return { user: await options.link(row, sub, context), created: false, linked: true };
      }
      // An unproven local address: never link. Creating may then hit your email
      // unique index; that surfaces as the create error, not as a takeover.
    }
  }

  try {
    const user = await options.create({
      sub,
      email,
      email_verified: claims.email_verified === true,
      external_id: claims.external_id,
    }, context);
    return { user, created: true, linked: false };
  } catch (error) {
    if (!(options.isDuplicateError ?? defaultIsDuplicateError)(error)) throw error;
    // A parallel first login created it a moment ago.
    const winner = await options.findBySub(sub);
    if (winner) return { user: winner, created: false, linked: false };
    throw error;
  }
}

import {
  FrameworkExport,
  base64url,
  bool,
  col,
  selfDescribingHash,
  sha256Hex,
  splitName,
  text,
  time,
  timeMs,
  type Tables,
} from './tables';

/**
 * Auth.js / NextAuth (v4 and v5) → canonical records, from the adapter's tables.
 *
 * Every official adapter keeps the same four models under its own table and
 * column spelling — Prisma `User`/`Account`/`Session`/`Authenticator`, Drizzle
 * `user`/`account`/`session`/`authenticator`, `@auth/pg-adapter` and Kysely
 * `users`/`accounts`/`sessions`, TypeORM, Sequelize, the Supabase adapter's
 * `next_auth` schema, MongoDB's `users`/`accounts`/`sessions` collections — so
 * the mapper accepts each spelling (camelCase, snake_case, Mongo `_id`).
 *
 *   users          → user (email + emailVerified, name, image; a password column
 *                    the app's Credentials provider filled, when it is a format
 *                    Atlas verifies)
 *   accounts       → identity (oauth / oidc; tokens only with `oauthTokens`)
 *   authenticators → passkey (the WebAuthn provider; needs the RP id)
 *   sessions       → session (database strategy; sha256 of `sessionToken`)
 *
 * Not exported: `verification_token` rows (magic-link tokens live minutes), the
 * Credentials provider's `authorize` logic (it is app code: Atlas owns
 * passwords now), JWT-strategy sessions (they live only in the browser — the
 * bridge reads them with the app's AUTH_SECRET instead).
 */
export interface AuthJsExportOptions {
  /** The WebAuthn RP id the Passkey provider registered against (your domain). */
  rpId?: string;
  /** Include OAuth access / refresh tokens on identities. Default false. */
  oauthTokens?: boolean;
  /** Include live database sessions for the bridge. Default true. */
  sessions?: boolean;
  /** The users-table column holding a Credentials-provider password hash (auto-detected otherwise). */
  passwordColumn?: string;
  now?: Date;
}

export const AUTHJS_TABLES = {
  user: ['User', 'users', 'user', 'next_auth.users'],
  account: ['Account', 'accounts', 'account', 'next_auth.accounts'],
  session: ['Session', 'sessions', 'session', 'next_auth.sessions'],
  authenticator: ['Authenticator', 'authenticators', 'authenticator'],
} as const;

const PASSWORD_COLUMNS = ['password', 'passwordHash', 'password_hash', 'hashedPassword', 'hashed_password', 'encryptedPassword'];

export function exportAuthJs(tables: Tables, options: AuthJsExportOptions = {}): FrameworkExport {
  const out = new FrameworkExport();
  const now = (options.now ?? new Date()).getTime();
  const users = tables.find(...AUTHJS_TABLES.user);
  if (!users) {
    out.warn(`No users table found (looked for ${AUTHJS_TABLES.user.join(', ')}).`);
    return out;
  }

  const userIds = new Set<string>();
  let passwordsCarried = 0;
  let passwordsUnknown = 0;
  for (const row of users.rows) {
    const id = text(col(row, 'id', '_id'));
    const email = text(col(row, 'email'));
    if (!id) {
      out.omit('user', 'row without an id');
      continue;
    }
    const verifiedAt = col(row, 'emailVerified', 'email_verified');
    const name = text(col(row, 'name'));
    const digest = text(options.passwordColumn ? col(row, options.passwordColumn) : col(row, ...PASSWORD_COLUMNS));
    let password: { algorithm: string; hash: string } | undefined;
    if (digest) {
      const known = selfDescribingHash(digest);
      if (known) {
        password = known;
        passwordsCarried++;
      } else passwordsUnknown++;
    }
    if (!email) {
      out.omit('user', 'no email address (Auth.js users without one cannot sign in to Atlas by email)');
      continue;
    }
    userIds.add(id);
    out.add('user', {
      id,
      emails: [{ email: email.toLowerCase(), verified: Boolean(verifiedAt) && verifiedAt !== false && verifiedAt !== 'false', primary: true }],
      name,
      ...splitName(name),
      image_url: text(col(row, 'image')),
      password,
      created_at: time(col(row, 'createdAt', 'created_at')),
    });
  }
  if (passwordsCarried) out.warn(`${passwordsCarried} Credentials-provider password hash(es) carried over; they verify on first sign-in and are upgraded to Argon2id.`);
  if (passwordsUnknown) {
    out.warn(
      `${passwordsUnknown} password value(s) are not a hash format Atlas verifies (bcrypt, Argon2, scrypt salt:key, PBKDF2): those users reset their password, or use lazy migration against your old /api/auth/callback/credentials.`,
    );
  }

  const providers = new Set<string>();
  for (const row of tables.rows(...AUTHJS_TABLES.account)) {
    const userId = text(col(row, 'userId', 'user_id'));
    const provider = text(col(row, 'provider'));
    const subject = text(col(row, 'providerAccountId', 'provider_account_id'));
    const type = text(col(row, 'type')) ?? 'oauth';
    if (!userId || !provider || !subject || !userIds.has(userId)) {
      out.omit('identity', 'account row without a known user, provider or providerAccountId');
      continue;
    }
    if (type === 'email' || type === 'credentials' || type === 'webauthn') continue;
    providers.add(provider);
    const expiresAt = col(row, 'expires_at', 'expiresAt');
    out.add('identity', {
      user_id: userId,
      provider,
      provider_user_id: subject,
      kind: type === 'oidc' ? 'oidc' : 'oauth',
      ...(options.oauthTokens
        ? {
            access_token: text(col(row, 'access_token', 'accessToken')),
            refresh_token: text(col(row, 'refresh_token', 'refreshToken')),
            // Auth.js stores expires_at in epoch SECONDS.
            expires_at: expiresAt !== undefined ? time(Number(expiresAt) * (Number(expiresAt) < 1e11 ? 1000 : 1)) : undefined,
          }
        : {}),
      scopes: text(col(row, 'scope'))?.split(/[\s,]+/).filter(Boolean),
    });
  }
  out.manifest.providers = [...providers].sort();

  const authenticators = tables.rows(...AUTHJS_TABLES.authenticator);
  if (authenticators.length && !options.rpId) {
    out.omit('passkey', 'no RP id given (--rp-id): a passkey only works on the domain it was registered for', authenticators.length);
  } else {
    for (const row of authenticators) {
      const userId = text(col(row, 'userId', 'user_id'));
      const credentialId = base64url(col(row, 'credentialID', 'credential_id', 'credentialId'));
      const publicKey = base64url(col(row, 'credentialPublicKey', 'credential_public_key'));
      if (!userId || !userIds.has(userId) || !credentialId || !publicKey) {
        out.omit('passkey', 'authenticator row without a known user, credential id or public key');
        continue;
      }
      const transports = text(col(row, 'transports'));
      out.add('passkey', {
        user_id: userId,
        credential_id: credentialId,
        public_key: publicKey,
        sign_count: Number(col(row, 'counter') ?? 0) || 0,
        rp_id: options.rpId!,
        transports: transports ? transports.split(/[\s,]+/).filter(Boolean) : undefined,
        backed_up: bool(col(row, 'credentialBackedUp', 'credential_backed_up')),
      });
    }
    if (options.rpId) out.manifest.rpId = options.rpId;
  }

  if (options.sessions !== false) {
    for (const row of tables.rows(...AUTHJS_TABLES.session)) {
      const token = text(col(row, 'sessionToken', 'session_token'));
      const userId = text(col(row, 'userId', 'user_id'));
      const expires = timeMs(col(row, 'expires', 'expires_at', 'expiresAt'));
      if (!token || !userId || !userIds.has(userId) || expires === undefined) {
        out.omit('session', 'session row without a token, a known user or an expiry');
        continue;
      }
      if (expires <= now) {
        out.omit('session', 'expired');
        continue;
      }
      out.add('session', {
        id: text(col(row, 'id', '_id')) ?? sha256Hex(token).slice(0, 32),
        user_id: userId,
        token_hash: sha256Hex(token),
        expires_at: new Date(expires).toISOString(),
      });
    }
  }
  out.manifest.settings = { session_cookie: ['authjs.session-token', 'next-auth.session-token'] };
  return out;
}

import {
  FrameworkExport,
  bool,
  col,
  json,
  selfDescribingHash,
  sha256Hex,
  splitName,
  text,
  time,
  timeMs,
  type Row,
  type Tables,
} from './tables';

/**
 * Passport.js and iron-session leave the user store to the app: there is no
 * schema to recognise, only conventions. This mapper reads the app's users
 * table with column names you can override, and recognises the common shapes:
 *
 *   - a password column holding a self-describing hash (bcrypt / bcryptjs,
 *     argon2 / @node-rs/argon2, Django-style PBKDF2, oslo scrypt);
 *   - passport-local-mongoose's `salt` + `hash` fields (PBKDF2-SHA256, 25000
 *     iterations, 512-byte key — `sha1` for apps on its pre-v5 default);
 *   - provider id columns the Passport strategies' `verify` callbacks fill
 *     (`googleId`, `github_id`, `facebookId` …), or a separate identities table;
 *
 * and, for Passport, the express-session store the app used (connect-pg-simple,
 * connect-mongo, connect-redis via a JSON dump, connect-session-sequelize,
 * knex/typeorm stores): each live session's `passport.user` becomes a session
 * record keyed by sha256 of the session id, which the bridge reads out of the
 * `connect.sid` cookie.
 */
export interface AppUsersExportOptions {
  usersTable?: string;
  idColumn?: string;
  emailColumn?: string;
  emailVerifiedColumn?: string;
  usernameColumn?: string;
  nameColumn?: string;
  passwordColumn?: string;
  /** passport-local-mongoose's digest (`sha256`, or `sha1` before v5). */
  plmDigest?: 'sha1' | 'sha256' | 'sha512';
  plmIterations?: number;
  /** `provider=column` pairs for provider id columns on the users row. */
  identityColumns?: Record<string, string>;
  /** A separate identities table (`user_id`, `provider`, `provider_user_id` / `provider_id` / `uid`). */
  identitiesTable?: string;
  /** The session store table / collection (default: detected). */
  sessionsTable?: string;
  /** Where the user id sits in the session JSON (default `passport.user`, then `passport.user.id`). */
  sessionUserPath?: string;
  sessions?: boolean;
  now?: Date;
}

const DEFAULT_IDENTITY_COLUMNS: Record<string, string[]> = {
  google: ['googleId', 'google_id'],
  github: ['githubId', 'github_id'],
  facebook: ['facebookId', 'facebook_id'],
  twitter: ['twitterId', 'twitter_id'],
  microsoft: ['microsoftId', 'microsoft_id'],
  apple: ['appleId', 'apple_id'],
  discord: ['discordId', 'discord_id'],
  gitlab: ['gitlabId', 'gitlab_id'],
  linkedin: ['linkedinId', 'linkedin_id'],
  slack: ['slackId', 'slack_id'],
};

/** passlib adapted base64 (what Atlas's PHC PBKDF2 verifier reads). */
function ab64(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '.').replace(/=+$/, '');
}

export function exportAppUsers(tables: Tables, options: AppUsersExportOptions = {}): FrameworkExport {
  const out = new FrameworkExport();
  const now = (options.now ?? new Date()).getTime();
  const users = tables.find(...(options.usersTable ? [options.usersTable] : ['users', 'user', 'User', 'accounts']));
  if (!users) {
    out.warn('No users table found (looked for users, user, accounts; pass --users-table).');
    return out;
  }
  const ids = new Set<string>();
  const providers = new Set<string>();
  let plm = 0;
  let unknown = 0;
  for (const row of users.rows) {
    const id = text(options.idColumn ? col(row, options.idColumn) : col(row, 'id', '_id', 'uuid'));
    if (!id) {
      out.omit('user', 'row without an id');
      continue;
    }
    const email = text(options.emailColumn ? col(row, options.emailColumn) : col(row, 'email', 'emailAddress', 'email_address'))?.toLowerCase();
    const username = text(options.usernameColumn ? col(row, options.usernameColumn) : col(row, 'username', 'login'));
    if (!email && !username) {
      out.omit('user', 'no email or username');
      continue;
    }
    let password: { algorithm: string; hash: string } | undefined;
    const salt = text(col(row, 'salt'));
    const plmHash = text(col(row, 'hash'));
    if (!options.passwordColumn && salt && plmHash && /^([0-9a-f]{2})+$/i.test(plmHash)) {
      const digestName = options.plmDigest ?? 'sha256';
      const rounds = options.plmIterations ?? 25000;
      password = {
        algorithm: 'auto',
        hash: `$pbkdf2-${digestName}$${rounds}$${ab64(Buffer.from(salt, 'utf8'))}$${ab64(Buffer.from(plmHash, 'hex'))}`,
      };
      plm++;
    } else {
      const digest = text(
        options.passwordColumn
          ? col(row, options.passwordColumn)
          : col(row, 'password', 'passwordHash', 'password_hash', 'hashedPassword', 'hashed_password', 'encrypted_password'),
      );
      if (digest) {
        password = selfDescribingHash(digest) ?? undefined;
        if (!password) unknown++;
      }
    }
    const verified = options.emailVerifiedColumn
      ? bool(col(row, options.emailVerifiedColumn))
      : bool(col(row, 'emailVerified', 'email_verified', 'verified', 'isVerified', 'is_verified', 'confirmed'));
    const name = text(options.nameColumn ? col(row, options.nameColumn) : col(row, 'name', 'displayName', 'display_name', 'fullName', 'full_name'));
    ids.add(id);
    out.add('user', {
      id,
      emails: email ? [{ email, verified, primary: true }] : undefined,
      username,
      name,
      first_name: text(col(row, 'firstName', 'first_name', 'givenName', 'given_name')) ?? splitName(name).first_name,
      last_name: text(col(row, 'lastName', 'last_name', 'familyName', 'family_name')) ?? splitName(name).last_name,
      image_url: text(col(row, 'image', 'avatar', 'avatarUrl', 'avatar_url', 'picture')),
      password,
      created_at: time(col(row, 'createdAt', 'created_at', 'date_joined')),
    });
    const identityColumns: Record<string, string[]> = options.identityColumns
      ? Object.fromEntries(Object.entries(options.identityColumns).map(([p, c]) => [p, [c]]))
      : DEFAULT_IDENTITY_COLUMNS;
    for (const [provider, columns] of Object.entries(identityColumns)) {
      const subject = text(col(row, ...columns));
      if (!subject) continue;
      providers.add(provider);
      out.add('identity', { user_id: id, provider, provider_user_id: subject, kind: 'oauth' });
    }
  }
  if (plm) out.warn(`${plm} passport-local-mongoose password(s) carried over as PBKDF2 (${options.plmDigest ?? 'sha256'}).`);
  if (unknown) out.warn(`${unknown} password value(s) are not a format Atlas verifies: those users reset their password or migrate lazily.`);

  const identities = tables.find(...(options.identitiesTable ? [options.identitiesTable] : ['identities', 'user_identities', 'federated_credentials', 'oauth_accounts']));
  for (const row of identities?.rows ?? []) {
    const userId = text(col(row, 'user_id', 'userId'));
    const provider = text(col(row, 'provider'))?.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const subject = text(col(row, 'provider_user_id', 'providerUserId', 'subject', 'uid', 'provider_id'));
    if (!userId || !provider || !subject || !ids.has(userId)) {
      out.omit('identity', 'identity row without a known user, provider or subject');
      continue;
    }
    providers.add(provider);
    out.add('identity', { user_id: userId, provider, provider_user_id: subject, kind: 'oauth' });
  }
  out.manifest.providers = [...providers].sort();

  if (options.sessions !== false) exportExpressSessions(tables, out, ids, options, now);
  return out;
}

/** connect-* session stores → session records (Passport). */
function exportExpressSessions(tables: Tables, out: FrameworkExport, ids: Set<string>, options: AppUsersExportOptions, now: number) {
  const store = tables.find(...(options.sessionsTable ? [options.sessionsTable] : ['session', 'sessions', 'Sessions', 'redis_sessions']));
  if (!store) return;
  for (const row of store.rows) {
    // connect-redis dumps carry the key `sess:<sid>`.
    const redisKey = text(col(row, 'key'));
    const sid = text(col(row, 'sid', '_id', 'session_id', 'id')) ?? (redisKey?.startsWith('sess:') ? redisKey.slice(5) : undefined);
    const data = json(col(row, 'sess', 'session', 'data', 'value'));
    if (!sid || !data) {
      out.omit('session', 'session row without an id or session data');
      continue;
    }
    const userId = sessionUser(data, options.sessionUserPath);
    if (!userId) {
      out.omit('session', 'anonymous session (no passport.user)');
      continue;
    }
    if (!ids.has(userId)) {
      out.omit('session', 'session of a user not in the export');
      continue;
    }
    const cookie = json(data.cookie);
    const ttl = Number(col(row, 'ttl'));
    const expires =
      timeMs(col(row, 'expire', 'expires', 'expired', 'expires_at')) ??
      timeMs(cookie?.expires) ??
      (Number.isFinite(ttl) && ttl > 0 ? now + ttl * 1000 : undefined);
    if (expires === undefined) {
      out.omit('session', 'browser-session cookie with no expiry in the store');
      continue;
    }
    if (expires <= now) {
      out.omit('session', 'expired');
      continue;
    }
    out.add('session', { id: sha256Hex(sid).slice(0, 32), user_id: userId, token_hash: sha256Hex(sid), expires_at: new Date(expires).toISOString() });
  }
  out.manifest.settings = { ...(out.manifest.settings ?? {}), session_cookie: 'connect.sid' };
}

function sessionUser(data: Row, path?: string): string | undefined {
  const at = (p: string): unknown =>
    p.split('.').reduce<unknown>((cur, k) => (cur && typeof cur === 'object' ? (cur as Row)[k] : undefined), data);
  if (path) return text(at(path));
  return text(at('passport.user')) ?? text(at('passport.user.id')) ?? text(at('passport.user._id')) ?? text(at('userId'));
}

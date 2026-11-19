/**
 * `@atlasauth/backend/link` — bind the Atlas user signing in to a row in YOUR user table, in one
 * race-safe step. Pairs with the `beforeFirstSession` hook (`createLinkHook`), which writes the
 * resulting local id back to Atlas as the user's `external_id`.
 *
 * Linking by email follows the pre-account hijacking rule: a row is linked only when the token's
 * `email_verified` is `true`, only when the row is not yet bound to an Atlas user, and an internal
 * placeholder address (`@no-email.invalid`) is never an email.
 */
import { defaultIsDuplicateError } from '../sync-local-user';

/** The claims `resolve` reads (a verified `SessionClaims` fits). */
export interface UserLinkClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  external_id?: string;
}

export type UserLinkPolicy = 'verified_email_oldest' | 'strict';
export type UserLinkDialect = 'postgres' | 'mysql' | 'sqlite';

export interface UserLinkResult {
  /** The id of your row (the value of `idColumn`). */
  localId: string | number;
  /** The row was inserted by this call. */
  created: boolean;
  /** An existing row was bound to this Atlas user by this call. */
  linked: boolean;
}

export interface UserLink {
  readonly policy: UserLinkPolicy;
  resolve(claims: UserLinkClaims): Promise<UserLinkResult>;
}

export interface SqlUserLinkOptions {
  /** Any driver's `query(sql, params)` resolving `{ rows }` (mysql: also `affectedRows`). Placeholders are `$1` for postgres, `?` otherwise. */
  query(sql: string, params: unknown[]): Promise<{ rows: any[]; affectedRows?: number; rowCount?: number | null }>;
  dialect?: UserLinkDialect;
  table: string;
  idColumn: string;
  emailColumn: string;
  /** Where the Atlas user id is stored. Add a UNIQUE index on it: that index is what makes concurrent first logins end on one row. */
  subColumn: string;
  /**
   * `verified_email_oldest` (default): bind the oldest unbound row whose email matches a VERIFIED token email.
   * `strict`: never link by email; a sub with no row gets a new one.
   */
  policy?: UserLinkPolicy;
  /** Column used to pick the oldest row. Default `idColumn`. */
  orderColumn?: string;
  /** Extra columns for a new row (name, avatar, your own id). `sub` and `email` are filled in when you leave them out. */
  create?(claims: UserLinkClaims): Record<string, unknown>;
  /** Whether an insert failed on a unique constraint. Default: Postgres 23505, or /duplicate|unique/i. */
  isDuplicateError?(error: unknown): boolean;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const PLACEHOLDER_EMAIL = /@no-email\.invalid$/i;

export function sqlUserLink(o: SqlUserLinkOptions): UserLink {
  const dialect = o.dialect ?? 'postgres';
  const policy = o.policy ?? 'verified_email_oldest';
  const isDup = o.isDuplicateError ?? defaultIsDuplicateError;
  const q = (name: string): string => {
    if (!IDENT.test(name)) throw new Error(`sqlUserLink: "${name}" is not a plain table or column name.`);
    const tick = dialect === 'mysql' ? '`' : '"';
    return name.split('.').map((s) => tick + s + tick).join('.');
  };
  const T = q(o.table);
  const ID = q(o.idColumn);
  const EMAIL = q(o.emailColumn);
  const SUB = q(o.subColumn);
  const ORD = q(o.orderColumn ?? o.idColumn);
  const returning = dialect !== 'mysql';
  const builder = () => {
    const params: unknown[] = [];
    return { params, p: (v: unknown) => (params.push(v), dialect === 'postgres' ? `$${params.length}` : '?') };
  };

  async function findBySub(sub: string): Promise<string | number | undefined> {
    const { params, p } = builder();
    const { rows } = await o.query(`select ${ID} as local_id from ${T} where ${SUB} = ${p(sub)} limit 1`, params);
    return rows[0]?.local_id;
  }

  async function linkByEmail(sub: string, email: string): Promise<string | number | undefined> {
    const { params, p } = builder();
    if (!returning) {
      const res = await o.query(
        `update ${T} set ${SUB} = ${p(sub)} where lower(${EMAIL}) = lower(${p(email)}) and ${SUB} is null order by ${ORD} limit 1`,
        params,
      );
      return (res.affectedRows ?? res.rowCount ?? 0) > 0 ? findBySub(sub) : undefined;
    }
    // One statement: pick the oldest unbound row and bind it. A concurrent link loses on `sub is null` or the unique index.
    const { rows } = await o.query(
      `update ${T} set ${SUB} = ${p(sub)} where ${ID} = (select ${ID} from ${T} where lower(${EMAIL}) = lower(${p(email)}) and ${SUB} is null order by ${ORD} limit 1) and ${SUB} is null returning ${ID} as local_id`,
      params,
    );
    return rows[0]?.local_id;
  }

  async function insert(claims: UserLinkClaims, email: string | undefined): Promise<string | number> {
    const cols: Record<string, unknown> = { ...(o.create?.(claims) ?? {}) };
    if (!(o.subColumn in cols)) cols[o.subColumn] = claims.sub;
    if (!(o.emailColumn in cols)) cols[o.emailColumn] = email ?? null;
    const names = Object.keys(cols);
    const { params, p } = builder();
    const values = names.map((n) => p(cols[n]));
    const res = await o.query(
      `insert into ${T} (${names.map(q).join(', ')}) values (${values.join(', ')})${returning ? ` returning ${ID} as local_id` : ''}`,
      params,
    );
    const id = returning ? res.rows[0]?.local_id : await findBySub(String(cols[o.subColumn]));
    if (id === undefined) throw new Error('sqlUserLink: the insert returned no row id.');
    return id;
  }

  return {
    policy,
    async resolve(claims) {
      const email = claims.email && !PLACEHOLDER_EMAIL.test(claims.email) ? claims.email : undefined;
      for (let attempt = 0; ; attempt++) {
        const existing = await findBySub(claims.sub);
        if (existing !== undefined) return { localId: existing, created: false, linked: false };
        try {
          if (policy === 'verified_email_oldest' && email && claims.email_verified === true) {
            const linked = await linkByEmail(claims.sub, email);
            if (linked !== undefined) return { localId: linked, created: false, linked: true };
          }
          return { localId: await insert(claims, email), created: true, linked: false };
        } catch (e) {
          // Lost a race on the unique sub: the winner's row is there on the next pass.
          if (!isDup(e) || attempt >= 2) throw e;
        }
      }
    },
  };
}

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ParsedArgs } from '../args';
import { str } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import { wantsJson } from '../commands/shared';
import { AUTHJS_TABLES, PASSWORD_COLUMNS, exportAuthJs } from './export/frameworks/authjs';
import { Tables, col, readDumpDir, selfDescribingHash, tablesFromStream, text, timeMs } from './export/frameworks/tables';

/** What an Auth.js database holds, and the route that moves it with the least user pain. */
export interface AuthjsMigrationPlan {
  users: { total: number; withEmail: number; withoutEmail: number; verified: number };
  passwords: { carried: number; unreadable: number };
  accounts: { oauth: number; other: number; providers: string[] };
  sessions: { total: number; live: number };
  passkeys: number;
  routes: Array<{ id: 'import' | 'lazy_link' | 'session_bridge'; recommended: boolean; why: string; commands: string[] }>;
  notes: string[];
}

const truthy = (v: unknown) => Boolean(v) && v !== false && v !== 'false' && v !== 0 && v !== '0';

/** Count the Auth.js tables and pick the route(s). Pure: `dump` is where the commands read from. */
export function planAuthjs(tables: Tables, opts: { dump: string; now?: Date }): AuthjsMigrationPlan {
  const now = (opts.now ?? new Date()).getTime();
  const users = tables.rows(...AUTHJS_TABLES.user);
  let withEmail = 0;
  let verified = 0;
  let carried = 0;
  let unreadable = 0;
  for (const row of users) {
    if (text(col(row, 'email'))) withEmail++;
    if (truthy(col(row, 'emailVerified', 'email_verified'))) verified++;
    const digest = text(col(row, ...PASSWORD_COLUMNS));
    if (digest) (selfDescribingHash(digest) ? carried++ : unreadable++);
  }
  const accounts = tables.rows(...AUTHJS_TABLES.account);
  const providers = new Set<string>();
  let oauth = 0;
  for (const row of accounts) {
    const type = text(col(row, 'type')) ?? 'oauth';
    if (type === 'oauth' || type === 'oidc') {
      oauth++;
      const p = text(col(row, 'provider'));
      if (p) providers.add(p);
    }
  }
  const sessions = tables.rows(...AUTHJS_TABLES.session);
  const live = sessions.filter((r) => (timeMs(col(r, 'expires', 'expires_at', 'expiresAt')) ?? 0) > now).length;
  const passkeys = tables.rows(...AUTHJS_TABLES.authenticator).length;
  const sealed = exportAuthJs(tables, { now: opts.now });

  const d = opts.dump;
  const hasUsers = users.length > 0;
  const lazyNeeded = unreadable > 0;
  const routes: AuthjsMigrationPlan['routes'] = [
    {
      id: 'import',
      recommended: hasUsers,
      why: 'Moves every user with an email, their linked social accounts, passkeys and the password hashes Atlas can verify (bcrypt, Argon2, scrypt, PBKDF2). Users sign in on Atlas with what they had; nothing to re-enter.',
      commands: [`atlas migrate authjs export --set dump=${d}`, 'atlas migrate authjs import', 'atlas migrate authjs verify'],
    },
    {
      id: 'lazy_link',
      recommended: lazyNeeded,
      why: lazyNeeded
        ? `${unreadable} password value(s) are not a hash format Atlas verifies. Lazy migration checks those users' passwords against your old Credentials sign-in once, on their first Atlas sign-in, and links them to their imported account.`
        : 'Optional. Only needed for password values Atlas cannot verify; none were found.',
      commands: ['atlas migrate authjs lazy --set base-url=https://YOUR-APP/api/auth'],
    },
    {
      id: 'session_bridge',
      recommended: live > 0 || (hasUsers && sessions.length === 0),
      why:
        live > 0
          ? `${live} live database session(s): the bridge accepts them for a cutover window, so those users stay signed in.`
          : sessions.length === 0
            ? 'No session rows, so the app uses JWT sessions: the bridge opens the Auth.js cookie on your server (needs AUTH_SECRET) so nobody is signed out.'
            : 'Every session row has expired; a bridge only helps JWT sessions, which live in the browser.',
      commands: ['atlas migrate authjs bridge --bridge-days 30'],
    },
  ];

  return {
    users: { total: users.length, withEmail, withoutEmail: users.length - withEmail, verified },
    passwords: { carried, unreadable },
    accounts: { oauth, other: accounts.length - oauth, providers: [...providers].sort() },
    sessions: { total: sessions.length, live },
    passkeys,
    routes,
    notes: [
      ...sealed.warnings,
      ...(users.length - withEmail ? [`${users.length - withEmail} user(s) have no email address and are left out (they cannot sign in to Atlas by email).`] : []),
      ...(passkeys ? ['Passkeys import only with --set rp-id=<your domain> on the export step.'] : []),
    ],
  };
}

/** psql commands that write the tables `plan` reads, for a Postgres URL (this CLI has no database driver, so it never connects). */
export function dumpCommands(url: string, dir: string): string[] {
  const redacted = url.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');
  return [
    `# run these where the database is reachable; the URL stays in your shell (shown with its password hidden: ${redacted})`,
    `mkdir -p ${dir}`,
    ...['users', 'accounts', 'sessions', 'authenticators'].map(
      (t) => `psql "$DATABASE_URL" -c "\\copy (select * from \\"${t}\\") to '${dir}/${t}.csv' csv header"`,
    ),
    '# table names differ by adapter (Prisma: "User", "Account", "Session"; Drizzle / Kysely: user, account, session); then:',
    `atlas migrate plan --from authjs --set dump=${dir}`,
  ];
}

function readFileTables(path: string): Tables {
  const text = readFileSync(path, 'utf8');
  if (/^\s*\{\s*"table"\s*:/m.test(text)) return tablesFromStream(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(`${path}: expected JSON like { "users": [...], "accounts": [...], "sessions": [...] } or an NDJSON stream of {"table","row"} lines.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CliError(`${path}: expected a JSON object with one array per table (users, accounts, sessions, authenticators).`);
  const tables = new Tables();
  for (const [name, rows] of Object.entries(parsed)) if (Array.isArray(rows)) tables.set(name, rows as Record<string, unknown>[]);
  return tables;
}

const line = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `atlas migrate plan --from authjs [--set dump=<dir> | --file <export.json> | --db <url>]`. */
export async function migratePlan(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const from = str(args.values, 'from');
  if (from !== 'authjs' && from !== 'next-auth') {
    throw new CliError(from ? `migrate plan reads Auth.js databases only so far (--from authjs); got '${from}'.` : 'migrate plan needs --from authjs.');
  }
  const sets = (Array.isArray(args.values.set) ? args.values.set : []).map((s) => s.split(/=(.*)/s));
  const dumpSet = sets.find(([k]) => k === 'dump')?.[1];
  const file = str(args.values, 'file');
  const db = str(args.values, 'db');

  let tables: Tables;
  let dump = dumpSet ?? './dump';
  if (dumpSet) {
    const dir = resolve(dumpSet);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new CliError(`Dump folder not found: ${dir}.`);
    tables = readDumpDir(dir);
  } else if (file) {
    const path = resolve(file);
    if (!existsSync(path)) throw new CliError(`File not found: ${path}.`);
    tables = readFileTables(path);
  } else if (db) {
    // shortcut: no database driver in this CLI; print the export instead of connecting. Add one if direct reads are wanted.
    for (const l of dumpCommands(db, dump)) ctx.io.out(l);
    ctx.io.out('');
    ctx.io.out('--db does not connect: the CLI carries no database driver, so your credentials never leave your machine. Run the commands above, then plan from the dump (or pass --file <export.json>).');
    return 1;
  } else {
    throw new CliError('migrate plan needs your Auth.js tables: --set dump=<folder of table files>, --file <export.json>, or --db <url> to print the commands that make them.');
  }
  if (!tables.find(...AUTHJS_TABLES.user)) {
    throw new CliError(`No users table found (looked for ${AUTHJS_TABLES.user.join(', ')}). Name each table file like the table.`);
  }

  const plan = planAuthjs(tables, { dump });
  if (wantsJson(args.values)) {
    printJson(ctx.io, { object: 'migration_plan', vendor: 'authjs', ...plan });
    return 0;
  }
  ctx.io.out('Auth.js database');
  ctx.io.out(`  users       ${plan.users.total} (${plan.users.withEmail} with an email, ${plan.users.verified} verified${plan.users.withoutEmail ? `, ${plan.users.withoutEmail} without an email` : ''})`);
  ctx.io.out(`  passwords   ${plan.passwords.carried} Atlas can verify, ${plan.passwords.unreadable} it cannot`);
  ctx.io.out(`  accounts    ${line(plan.accounts.oauth, 'social account')}${plan.accounts.providers.length ? ` (${plan.accounts.providers.join(', ')})` : ''}`);
  ctx.io.out(`  sessions    ${plan.sessions.total} (${plan.sessions.live} still live)`);
  ctx.io.out(`  passkeys    ${plan.passkeys}`);
  ctx.io.out('');
  ctx.io.out('Routes');
  for (const r of plan.routes) {
    ctx.io.out(`  ${r.recommended ? '*' : '-'} ${r.id.replace('_', ' ')}${r.recommended ? ' (recommended)' : ''}`);
    ctx.io.out(`      ${r.why}`);
    for (const c of r.commands) ctx.io.out(`      $ ${c}`);
  }
  for (const n of plan.notes) ctx.io.out(`note: ${n}`);
  ctx.io.out('');
  ctx.io.out('Walk every step without changing anything first: atlas migrate authjs --dry-run --set dump=' + dump);
  return 0;
}

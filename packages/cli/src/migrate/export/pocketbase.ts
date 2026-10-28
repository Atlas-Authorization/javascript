import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { UserRecord } from '@atlasauth/migrate';
import { parseCsv } from '../../import/csv';
import { RecordSet, compact, isObj, str, type Obj } from './record-set';

/**
 * `atlas migrate export pocketbase` — a PocketBase app's auth collections.
 *
 * PocketBase's REST API never returns a password hash or a token key (they
 * are stripped from every record, superusers included), so the export reads
 * the SQLite database: `pb_data/data.db` directly through Node's built-in
 * `node:sqlite` (read-only; stop the server or copy the file with its -wal
 * and -shm first), or a dump directory the owner made with `sqlite3 -json`
 * (one `<table>.json` per table: `_collections`, each auth collection, and
 * `_externalAuths`). Nothing connects to a running PocketBase.
 *
 * What moves: every auth collection's records (v0.23+ `password`, ≤0.22
 * `passwordHash`, both Go bcrypt), email + verified, username, name, avatar
 * (as a file URL when the PocketBase URL is given), custom fields as public
 * metadata, and OAuth2 links from `_externalAuths`. Superusers (`_superusers`,
 * or ≤0.22 `_admins`) stay behind unless asked for. `_mfas` and `_otps` hold
 * one-time sign-in state, not enrolments: nothing to carry. Tokens are HS256
 * signed with a per-record key, so the bridge asks PocketBase about them
 * (`pocketbase` bridge preset) instead of importing sessions.
 */

export interface PocketBaseTables {
  /** `_collections` rows (`id, name, type, options, fields` or ≤0.22 `schema`). */
  collections: Obj[];
  /** Rows by table name. */
  tables: Map<string, Obj[]>;
}

export interface PocketBaseExportOptions {
  /** Auth collections to export (default: every auth collection except `_superusers`). */
  collections?: string[];
  includeSuperusers?: boolean;
  /** The public PocketBase URL, to turn avatar file names into URLs. */
  url?: string;
  /** Shown in the dashboard as where the data came from (a file path, never a credential). */
  origin?: string;
}

/** Fields every auth record has that are not metadata. */
const SYSTEM_FIELDS = new Set([
  'id', 'email', 'emailVisibility', 'verified', 'password', 'passwordHash', 'tokenKey', 'username', 'name', 'avatar', 'created', 'updated',
  'lastResetSentAt', 'lastVerificationSentAt', 'lastLoginAlertSentAt',
]);

export function exportPocketBase(db: PocketBaseTables, opts: PocketBaseExportOptions = {}): RecordSet {
  const set = new RecordSet();
  const auth = db.collections.filter((c) => str(c.type) === 'auth');
  const wanted = opts.collections?.length ? new Set(opts.collections) : null;
  const chosen = auth.filter((c) => {
    const name = str(c.name) ?? '';
    if (wanted) return wanted.has(name);
    return name !== '_superusers' || opts.includeSuperusers === true;
  });
  if (wanted) for (const name of wanted) if (!auth.some((c) => str(c.name) === name)) set.warn(`"${name}" is not an auth collection in this database and was skipped.`);
  if (!auth.length) set.warn('No auth collection found in _collections: is this a PocketBase data.db (or a dump of it)?');
  if (db.tables.has('_admins') && opts.includeSuperusers) set.warn('PocketBase ≤0.22 admins (_admins) are not exported: create them again as Atlas instance admins.');

  const userIds = new Set<string>();
  const multiple = chosen.length > 1;
  for (const c of chosen) {
    const name = str(c.name)!;
    const collectionId = str(c.id) ?? name;
    const rows = db.tables.get(name) ?? db.tables.get(name.toLowerCase()) ?? [];
    if (!rows.length) set.warn(`The auth collection "${name}" has no rows in the export (was its table dumped?).`);
    for (const r of rows) {
      const id = str(r.id);
      if (!id) continue;
      if (userIds.has(id)) {
        set.omit('user', 'record id already exported from another auth collection');
        continue;
      }
      const user = mapRecord(r, { collection: name, collectionId, url: opts.url, tag: multiple || name !== 'users' });
      if (!user) {
        set.omit('user', 'record without an email or username');
        continue;
      }
      userIds.add(id);
      set.add('user', compact(user));
    }
  }
  if (set.list('user').some((u) => !u.password)) set.warn('Some records have no password hash (OAuth2- or OTP-only users): they keep signing in with those methods.');

  // OAuth2 links: v0.23+ collectionRef/recordRef, ≤0.22 collectionId/recordId.
  for (const e of db.tables.get('_externalauths') ?? db.tables.get('_externalAuths') ?? []) {
    const userId = str(e.recordRef) ?? str(e.recordId);
    const provider = str(e.provider);
    const providerId = str(e.providerId);
    if (!userId || !provider || !providerId || !userIds.has(userId)) continue;
    set.add('identity', compact({ id: str(e.id), user_id: userId, provider, provider_user_id: providerId, kind: 'oauth' as const }), `${provider}:${providerId}`);
  }

  const providers = new Set(set.list('identity').map((i) => i.provider));
  set.manifest = { ...set.manifest, origin: opts.origin ?? 'pocketbase data.db', providers: [...providers].sort() };
  set.warn('PocketBase auth tokens are signed per record and cannot be imported: enable the pocketbase bridge preset so signed-in users move without a new sign-in.');
  return set;
}

function mapRecord(r: Obj, ctx: { collection: string; collectionId: string; url?: string; tag: boolean }): UserRecord | null {
  const email = str(r.email)?.toLowerCase();
  const username = str(r.username);
  if (!email && !username) return null;
  const hash = str(r.password) ?? str(r.passwordHash);
  const avatar = str(r.avatar);
  const meta: Obj = {};
  for (const [k, v] of Object.entries(r)) {
    if (SYSTEM_FIELDS.has(k) || v === null || v === '' || v === undefined) continue;
    meta[k] = parseJsonish(v);
  }
  return {
    id: str(r.id)!,
    emails: email ? [{ email, verified: truthy(r.verified), primary: true }] : undefined,
    username,
    name: str(r.name),
    image_url: avatar && ctx.url ? `${ctx.url.replace(/\/+$/, '')}/api/files/${encodeURIComponent(ctx.collectionId)}/${encodeURIComponent(str(r.id)!)}/${encodeURIComponent(avatar)}` : undefined,
    password: hash && /^\$2[aby]\$\d{2}\$/.test(hash) ? { algorithm: 'auto', hash } : undefined,
    public_metadata: Object.keys(meta).length ? meta : undefined,
    private_metadata: ctx.tag ? { pocketbase_collection: ctx.collection } : undefined,
    created_at: pbTime(r.created),
  };
}

/** PocketBase stores `2024-01-02 03:04:05.123Z`; the bundle wants ISO-8601. */
export function pbTime(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  return /^\d{4}-\d{2}-\d{2} \d/.test(s) ? s.replace(' ', 'T') : s;
}

const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';

/** JSON / multi-select / relation fields come out of SQLite as JSON text. */
function parseJsonish(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return v;
    }
  }
  return v;
}

// ── readers ─────────────────────────────────────────────────────────────────

function tablesFrom(byName: Map<string, Obj[]>): PocketBaseTables {
  const collections = (byName.get('_collections') ?? []).map((c) => ({ ...c, options: parseJsonish(c.options), fields: parseJsonish(c.fields ?? c.schema) }));
  return { collections, tables: byName };
}

/**
 * A dump directory: one file per table (`_collections.json`, `users.json`,
 * `_externalAuths.json` …) as `sqlite3 -json` writes it (a JSON array), NDJSON,
 * or CSV with a header row.
 */
export function readPocketBaseDump(dir: string): PocketBaseTables {
  const byName = new Map<string, Obj[]>();
  for (const file of readdirSync(dir).sort()) {
    const path = join(dir, file);
    const ext = extname(file).toLowerCase();
    if (!statSync(path).isFile() || !['.json', '.ndjson', '.jsonl', '.csv'].includes(ext)) continue;
    const rows = parseTable(readFileSync(path, 'utf8'), ext);
    const name = basename(file, extname(file));
    byName.set(name, rows);
    if (name.toLowerCase() !== name) byName.set(name.toLowerCase(), rows);
  }
  return tablesFrom(byName);
}

export function parseTable(text: string, ext: string): Obj[] {
  if (ext === '.csv') return parseCsv(text) as Obj[];
  if (ext === '.ndjson' || ext === '.jsonl') {
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as unknown)
      .filter(isObj);
  }
  const t = text.trim();
  if (!t) return [];
  const parsed = JSON.parse(t) as unknown;
  if (Array.isArray(parsed)) return parsed.filter(isObj);
  if (isObj(parsed) && Array.isArray(parsed.rows)) return parsed.rows.filter(isObj);
  if (isObj(parsed) && Array.isArray(parsed.items)) return parsed.items.filter(isObj);
  return [];
}

interface SqliteDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

/**
 * `pb_data/data.db` through Node's built-in SQLite (Node 22.5+), opened
 * read-only. Reads `_collections`, every auth collection's table and
 * `_externalAuths` — nothing else.
 */
export async function readPocketBaseDb(path: string): Promise<PocketBaseTables> {
  const spec = 'node:sqlite';
  let mod: { DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => SqliteDb };
  try {
    mod = (await import(spec)) as typeof mod;
  } catch {
    throw new Error('This Node.js has no built-in SQLite (node:sqlite, Node 22.5+). Dump the tables with sqlite3 -json instead and pass the folder with --set pocketbase-dump=<dir>.');
  }
  const db = new mod.DatabaseSync(path, { readOnly: true });
  try {
    const all = (sql: string) => db.prepare(sql).all().filter(isObj);
    const has = new Set(all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => str(r.name)).filter((n): n is string => !!n));
    if (!has.has('_collections')) throw new Error(`${path} has no _collections table: it is not a PocketBase data.db.`);
    const byName = new Map<string, Obj[]>();
    const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
    byName.set('_collections', all('SELECT * FROM _collections'));
    for (const c of byName.get('_collections')!) {
      const name = str(c.name);
      if (name && str(c.type) === 'auth' && has.has(name)) byName.set(name, all(`SELECT * FROM ${q(name)}`));
    }
    if (has.has('_externalAuths')) byName.set('_externalAuths', all('SELECT * FROM _externalAuths'));
    if (has.has('_admins')) byName.set('_admins', []);
    return tablesFrom(byName);
  } finally {
    db.close();
  }
}

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { CANONICAL_MODEL_ORDER, type CanonicalModel, type CanonicalRecordData, type MigrationManifest, type Timestamp } from '@atlasauth/migrate';
import { parseCsv } from '../../../import/csv';

/**
 * The self-hosted frameworks (Auth.js, Lucia, Passport, iron-session, Devise,
 * Django) keep users in the APP's own database, so their exporters read table
 * dumps the owner makes with their usual tools — `psql \copy … csv`,
 * `mysqldump --tab`, `sqlite3 -json`, `mongoexport`, Prisma/Drizzle scripts,
 * `manage.py dumpdata`, the Rails runner script — rather than connecting to a
 * database. Nothing leaves the owner's machine unsealed, and no database
 * driver is needed.
 *
 * A dump directory holds one file per table, `<table>.json` (an array, or
 * `{ "rows": [...] }`), `<table>.ndjson` / `.jsonl`, or `<table>.csv`. Table
 * lookups are case-insensitive and accept the names every adapter uses
 * (`User`, `users`, `user`, `auth_user` …), so a mapper names the candidates.
 */

export type Row = Record<string, unknown>;

/** Rows by table name (lowercase). */
export class Tables {
  private readonly byName = new Map<string, Row[]>();

  constructor(tables: Record<string, Row[]> = {}) {
    for (const [name, rows] of Object.entries(tables)) this.set(name, rows);
  }

  set(name: string, rows: Row[]): void {
    this.byName.set(name.toLowerCase(), rows.map(normalizeRow));
  }

  /** The first table that exists among `names` (case-insensitive), with its name. */
  find(...names: string[]): { name: string; rows: Row[] } | undefined {
    for (const n of names) {
      const rows = this.byName.get(n.toLowerCase());
      if (rows) return { name: n, rows };
    }
    return undefined;
  }

  rows(...names: string[]): Row[] {
    return this.find(...names)?.rows ?? [];
  }

  names(): string[] {
    return [...this.byName.keys()];
  }
}

/** Read every table file in a dump directory. */
export function readDumpDir(dir: string): Tables {
  const tables = new Tables();
  for (const file of readdirSync(dir).sort()) {
    const path = join(dir, file);
    if (!statSync(path).isFile()) continue;
    const ext = extname(file).toLowerCase();
    if (!['.json', '.ndjson', '.jsonl', '.csv'].includes(ext)) continue;
    tables.set(basename(file, extname(file)), parseTableText(readFileSync(path, 'utf8'), ext));
  }
  return tables;
}

/**
 * Rows streamed as NDJSON `{"table": "<name>", "row": {…}}` lines — what the
 * Rails and Django export scripts print, piped into `--file -`.
 */
export function tablesFromStream(text: string, into: Tables = new Tables()): Tables {
  const grouped = new Map<string, Row[]>();
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith('{')) continue; // framework boot noise on stdout
    let entry: unknown;
    try {
      entry = JSON.parse(l);
    } catch {
      continue;
    }
    if (!isRow(entry) || typeof entry.table !== 'string' || !isRow(entry.row)) continue;
    const list = grouped.get(entry.table) ?? [];
    list.push(entry.row);
    grouped.set(entry.table, list);
  }
  for (const [name, rows] of grouped) into.set(name, [...(into.find(name)?.rows ?? []), ...rows]);
  return into;
}

/** Parse one table file's text by its extension. */
export function parseTableText(text: string, ext: string): Row[] {
  if (ext === '.csv') return parseCsv(text) as Row[];
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (ext === '.json') {
    const doc = JSON.parse(trimmed) as unknown;
    if (Array.isArray(doc)) return doc.filter(isRow);
    if (isRow(doc) && Array.isArray(doc.rows)) return doc.rows.filter(isRow);
    if (isRow(doc)) return [doc];
    return [];
  }
  return trimmed
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as unknown)
    .filter(isRow);
}

export function isRow(v: unknown): v is Row {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Unwrap MongoDB extended JSON (`{"$oid": …}`, `{"$date": …}`,
 * `{"$numberLong": …}`, `{"$binary": {"base64": …}}`) as mongoexport writes it,
 * so a Mongo dump reads like any other.
 */
function normalizeValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalizeValue);
  if (!isRow(v)) return v;
  const keys = Object.keys(v);
  if (keys.length === 1) {
    const k = keys[0]!;
    const inner = v[k];
    if (k === '$oid' && typeof inner === 'string') return inner;
    if (k === '$date') {
      if (typeof inner === 'string') return inner;
      if (isRow(inner) && typeof inner.$numberLong === 'string') return new Date(Number(inner.$numberLong)).toISOString();
      if (typeof inner === 'number') return new Date(inner).toISOString();
    }
    if ((k === '$numberLong' || k === '$numberInt' || k === '$numberDouble') && typeof inner === 'string') return Number(inner);
    if (k === '$binary' && isRow(inner) && typeof inner.base64 === 'string') return inner.base64;
  }
  const out: Row = {};
  for (const [key, value] of Object.entries(v)) out[key] = normalizeValue(value);
  return out;
}

function normalizeRow(row: Row): Row {
  return normalizeValue(row) as Row;
}

// ── column helpers ──────────────────────────────────────────────────────────

/** The first present, non-empty column among `names` (exact, then case-insensitive). */
export function col(row: Row, ...names: string[]): unknown {
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  const lower = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const k = lower.get(n.toLowerCase());
    if (k !== undefined) {
      const v = row[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  return undefined;
}

export function text(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() ? v.trim() : undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint') return v.toString();
  return undefined;
}

export function bool(v: unknown): boolean {
  return v === true || v === 1 || (typeof v === 'string' && ['true', 't', '1', 'yes'].includes(v.trim().toLowerCase()));
}

/**
 * A timestamp column as the bundle wants it: ISO strings pass, numbers are
 * epoch ms (or seconds when small), SQL `2024-01-02 03:04:05[+00]` strings are
 * made ISO. Undefined when absent or unparseable.
 */
export function time(v: unknown): Timestamp | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d+$/.test(s)) return time(Number(s));
    // SQL dumps write `2024-01-02 03:04:05.123+00` / `+0000`: make it ISO 8601.
    let iso = s.includes('T') ? s : s.replace(' ', 'T');
    if (iso.includes('T')) iso = iso.replace(/(T[\d:.]+[+-]\d\d)$/, '$1:00').replace(/(T[\d:.]+[+-]\d\d)(\d\d)$/, '$1:$2');
    const ms = Date.parse(!iso.includes('T') || /[zZ]$|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  }
  return undefined;
}

export function timeMs(v: unknown): number | undefined {
  const t = time(v);
  if (t === undefined) return undefined;
  return typeof t === 'number' ? t : Date.parse(t);
}

/** A JSON column (object, or a string holding one). */
export function json(v: unknown): Row | undefined {
  if (isRow(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(v) as unknown;
      return isRow(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Lowercase hex sha256 — the bundle's session `token_hash`. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Any base64 / base64url / `\x`-hex bytes column as base64url (passkey fields). */
export function base64url(v: unknown): string | undefined {
  const s = text(v);
  if (!s) return undefined;
  if (/^\\x[0-9a-f]+$/i.test(s)) return Buffer.from(s.slice(2), 'hex').toString('base64url');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return undefined;
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('base64url');
}

/**
 * The password-hash algorithm a stored digest self-describes, for a column
 * the app filled itself (Auth.js Credentials, Lucia, Passport): bcrypt and
 * Argon2 PHC strings, oslo/Better Auth `salt:key` scrypt, Lucia's own scrypt,
 * Django/passlib PBKDF2. `auto` lets Atlas's registry recognise it; null =
 * not a format Atlas can verify (the user resets or migrates lazily).
 */
export function selfDescribingHash(digest: string): { algorithm: string; hash: string } | null {
  const d = digest.trim();
  if (/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(d)) return { algorithm: 'bcrypt', hash: d };
  if (/^\$argon2(id|i|d)\$/.test(d)) return { algorithm: 'argon2', hash: d };
  if (/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(d)) return { algorithm: 'scrypt_better_auth', hash: d };
  if (/^(s2:)?[a-z0-9]{16}:[0-9a-f]{128}$/.test(d)) return { algorithm: 'scrypt_lucia', hash: d };
  if (/^(pbkdf2_sha(1|256|512)|bcrypt|bcrypt_sha256|argon2|scrypt)\$/.test(d)) return { algorithm: 'auto', hash: d };
  if (/^\$(pbkdf2-sha(1|256|512)|scrypt)\$/.test(d)) return { algorithm: 'auto', hash: d };
  return null;
}

// ── what a framework exporter returns ───────────────────────────────────────

/** Records by canonical model, plus what the exporter could not carry. */
export class FrameworkExport {
  private readonly rows = new Map<CanonicalModel, unknown[]>();
  readonly warnings: string[] = [];
  readonly omitted: Record<string, { count: number; reason: string }> = {};
  manifest: Partial<Pick<MigrationManifest, 'origin' | 'sourceVersion' | 'rpId' | 'providers' | 'settings'>> = {};

  add<M extends CanonicalModel>(model: M, data: CanonicalRecordData[M]): void {
    const list = this.rows.get(model) ?? [];
    list.push(stripUndefined(data));
    this.rows.set(model, list);
  }

  list<M extends CanonicalModel>(model: M): Array<CanonicalRecordData[M]> {
    return (this.rows.get(model) ?? []) as Array<CanonicalRecordData[M]>;
  }

  count(model: CanonicalModel): number {
    return this.rows.get(model)?.length ?? 0;
  }

  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  omit(model: string, reason: string, count = 1): void {
    const o = this.omitted[model] ?? { count: 0, reason };
    o.count += count;
    this.omitted[model] = o;
  }

  /** Every row as `[model, data]`, in the canonical order the bundle writer requires. */
  *entries(): Generator<[CanonicalModel, unknown]> {
    for (const model of CANONICAL_MODEL_ORDER) for (const data of this.rows.get(model) ?? []) yield [model, data];
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [model, list] of this.rows) out[model] = list.length;
    return out;
  }
}

function stripUndefined<T>(data: T): T {
  if (!isRow(data)) return data;
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (v === undefined || (Array.isArray(v) && v.length === 0)) delete data[k];
  }
  return data;
}

/** Split "Ada Lovelace" for exports that only keep a display name. */
export function splitName(name: string | undefined): { first_name?: string; last_name?: string } {
  if (!name) return {};
  const [first, ...rest] = name.trim().split(/\s+/);
  return { ...(first ? { first_name: first } : {}), ...(rest.length ? { last_name: rest.join(' ') } : {}) };
}

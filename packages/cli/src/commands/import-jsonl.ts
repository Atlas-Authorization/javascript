import { str, type ParsedArgs } from '../args';
import type { ConfigHttp } from '../config-http';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import { httpFor } from '../project';
import { resolveAuth, wantsJson } from './shared';

/**
 * `atlas import users.jsonl`: Atlas's own import shape, one user per line, mapped
 * onto `POST /v1/user_imports`. Idempotent by `external_id`: each row is looked up
 * first, so re-running a file changes nothing and a catch-up run only touches what
 * is new or changed. Output carries counts and external ids, never an email address
 * or a password digest.
 */

export interface JobResult {
  id: string;
  status: string;
  total: number;
  succeeded: number;
  failed: number;
  results?: Array<{ outcome: 'created' | 'updated' | 'matched' | 'failed' }> | null;
}

/** Send one batch and wait for it: a batch over the inline limit is queued. */
export async function sendImportBatch(ctx: RunContext, http: ConfigHttp, body: Record<string, unknown>): Promise<JobResult> {
  let job = await http.post<JobResult>('/v1/user_imports', body);
  while (job.status === 'pending' || job.status === 'processing') {
    await (ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(2000);
    job = await http.get<JobResult>(`/v1/jobs/${job.id}`);
  }
  return job;
}

/** Epoch seconds, epoch milliseconds or an ISO string as epoch ms; undefined when absent or unreadable. */
export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const n = Number(value);
  if (Number.isFinite(n)) return parseTimestamp(n);
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

/** `--since` as epoch ms. */
export function parseSince(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const t = parseTimestamp(raw);
  if (t === undefined) throw new CliError(`--since must be an ISO date or epoch time, got '${raw}'.`);
  return t;
}

/** `--password-policy`, checked. */
export function parsePasswordPolicy(raw: string | undefined): string | undefined {
  if (raw !== undefined && raw !== 'active' && raw !== 'until_email_verified') {
    throw new CliError(`--password-policy must be active or until_email_verified, got '${raw}'.`);
  }
  return raw;
}

/** `--on-conflict`, checked. */
export function parseOnConflict(raw: string | undefined, fallback: 'skip' | 'update'): 'skip' | 'update' {
  if (raw === undefined) return fallback;
  if (raw !== 'skip' && raw !== 'update') throw new CliError(`--on-conflict must be skip or update, got '${raw}'.`);
  return raw;
}

interface InputRow {
  external_id: string;
  email: string;
  email_verified?: boolean;
  password_digest?: string;
  algorithm?: string;
  password_salt?: string;
  first_name?: string;
  last_name?: string;
  oauth_identities?: Array<{ provider: string; provider_user_id: string }>;
  created_at?: string | number;
  updated_at?: string | number;
}

/** Parse the file. Errors name the line only: a line holds an email and maybe a digest. */
export function parseUsersJsonl(text: string): InputRow[] {
  const rows: InputRow[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    const line = i + 1;
    let row: InputRow;
    try {
      row = JSON.parse(raw) as InputRow;
    } catch {
      throw new CliError(`Line ${line} is not valid JSON.`);
    }
    if (row === null || typeof row !== 'object' || typeof row.external_id !== 'string' || !row.external_id.trim()) {
      throw new CliError(`Line ${line} has no external_id: re-running is only safe when every row has one.`);
    }
    if (typeof row.email !== 'string' || !row.email.trim()) throw new CliError(`Line ${line} has no email.`);
    if (seen.has(row.external_id)) throw new CliError(`Line ${line} repeats an external_id from an earlier line.`);
    seen.add(row.external_id);
    rows.push(row);
  });
  return rows;
}

function toImportRow(row: InputRow): Record<string, unknown> {
  const out: Record<string, unknown> = { email_address: row.email, external_id: row.external_id, email_verified: row.email_verified === true };
  if (row.password_digest) out.password_hash = row.password_digest;
  if (row.algorithm) out.password_hasher = row.algorithm;
  if (row.password_salt) out.password_salt = row.password_salt;
  if (row.first_name !== undefined) out.first_name = row.first_name;
  if (row.last_name !== undefined) out.last_name = row.last_name;
  if (row.created_at !== undefined) out.created_at = row.created_at;
  if (row.oauth_identities?.length) {
    out.external_accounts = row.oauth_identities.map((a) => ({ provider: a.provider, provider_user_id: a.provider_user_id }));
  }
  return out;
}

interface LiveUser {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  updated_at?: number;
  password_enabled?: boolean;
  email_addresses?: Array<{ id: string; email_address: string; verified?: boolean }>;
  external_accounts?: Array<{ provider: string; provider_user_id: string }>;
}

/** A small map with bounded concurrency: one lookup per row, without flooding the API. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const BATCH = 100;

export async function importJsonl(ctx: RunContext, args: ParsedArgs, file: string): Promise<number> {
  const v = args.values;
  const json = wantsJson(v);
  const dry = v['dry-run'] === true;
  const onConflict = parseOnConflict(str(v, 'on-conflict'), 'skip');
  const policy = parsePasswordPolicy(str(v, 'password-policy'));
  const since = parseSince(str(v, 'since'));
  const all = parseUsersJsonl(ctx.readFile(file));

  let skipped = 0;
  const rows = all.filter((r) => {
    const at = parseTimestamp(r.updated_at) ?? parseTimestamp(r.created_at);
    // A row with no date cannot be shown to be old, so it stays.
    const keep = since === undefined || at === undefined || at >= since;
    if (!keep) skipped += 1;
    return keep;
  });

  const auth = resolveAuth(ctx, v);
  const http = httpFor(ctx, { secretKey: auth.secretKey, apiUrl: auth.apiUrl });
  const live = await mapLimited(rows, 10, async (r) => {
    const res = await http.get<{ data?: LiveUser[] }>(`/v1/users?external_id=${encodeURIComponent(r.external_id)}&limit=1`);
    return res.data?.[0];
  });

  const creates: Record<string, unknown>[] = [];
  const upserts: Record<string, unknown>[] = [];
  const direct: Array<{ row: InputRow; user: LiveUser; verifyId?: string }> = [];
  const emailChanged: string[] = [];
  const passwordNotApplied: string[] = [];
  rows.forEach((row, i) => {
    const user = live[i];
    if (!user) {
      creates.push(toImportRow(row));
      return;
    }
    if (onConflict === 'skip') {
      skipped += 1;
      return;
    }
    const address = user.email_addresses?.find((e) => e.email_address.toLowerCase() === row.email.trim().toLowerCase());
    // The import matches on a verified email, so a changed address would make a second user.
    if (!address) {
      emailChanged.push(row.external_id);
      skipped += 1;
      return;
    }
    const namesDiffer = (row.first_name !== undefined && row.first_name !== user.first_name) || (row.last_name !== undefined && row.last_name !== user.last_name);
    const verifyNow = row.email_verified === true && address.verified !== true;
    const wantsPassword = Boolean(row.password_digest) && user.password_enabled === false;
    const missingIdentity = Boolean(
      user.external_accounts && row.oauth_identities?.some((a) => !user.external_accounts!.some((b) => b.provider === a.provider && b.provider_user_id === a.provider_user_id)),
    );
    const at = parseTimestamp(row.updated_at);
    const newer = at !== undefined && user.updated_at !== undefined && at > user.updated_at;
    if (!namesDiffer && !verifyNow && !wantsPassword && !missingIdentity && !newer) {
      skipped += 1;
      return;
    }
    if (address.verified === true) {
      upserts.push(toImportRow(row));
      return;
    }
    // The address is unverified, so the import would not find this user: update it by id.
    if (wantsPassword || missingIdentity) passwordNotApplied.push(row.external_id);
    direct.push({ row, user, ...(verifyNow ? { verifyId: address.id } : {}) });
  });

  const unverifiedWithPassword = rows.filter((r) => r.password_digest && r.email_verified !== true).length;
  const report = {
    created: creates.length,
    updated: upserts.length + direct.length,
    skipped,
    unverified_with_password: unverifiedWithPassword,
    failed: 0,
    jobs: [] as string[],
  };

  const notes = [
    ...(emailChanged.length ? [`${emailChanged.length} row(s) have a different email from the existing user and were left alone; change the address on the user first. external_id: ${emailChanged.join(', ')}`] : []),
    ...(passwordNotApplied.length ? [`${passwordNotApplied.length} row(s) hold a password or identity that cannot be added while the address is unverified. external_id: ${passwordNotApplied.join(', ')}`] : []),
  ];

  if (!dry) {
    // What was planned as created may still meet a verified email already here.
    report.created = 0;
    report.updated = 0;
    const send = async (batch: Record<string, unknown>[], upsert: boolean) => {
      const job = await sendImportBatch(ctx, http, { users: batch, upsert, ...(policy ? { password_policy: policy } : {}) });
      report.jobs.push(job.id);
      if (!job.results) {
        report.created += job.succeeded;
        report.failed += job.failed;
        return;
      }
      for (const r of job.results) {
        if (r.outcome === 'created') report.created += 1;
        else if (r.outcome === 'updated') report.updated += 1;
        else if (r.outcome === 'matched') report.skipped += 1;
        else report.failed += 1;
      }
    };
    for (let i = 0; i < creates.length; i += BATCH) await send(creates.slice(i, i + BATCH), onConflict === 'update');
    for (let i = 0; i < upserts.length; i += BATCH) await send(upserts.slice(i, i + BATCH), true);
    for (const { row, user, verifyId } of direct) {
      if (row.first_name !== undefined || row.last_name !== undefined) {
        await http.patch(`/v1/users/${encodeURIComponent(user.id)}`, {
          ...(row.first_name !== undefined ? { first_name: row.first_name } : {}),
          ...(row.last_name !== undefined ? { last_name: row.last_name } : {}),
        });
      }
      if (verifyId) await http.post(`/v1/users/${encodeURIComponent(user.id)}/email_addresses/${encodeURIComponent(verifyId)}/verify`, {});
      report.updated += 1;
    }
  }

  if (json) printJson(ctx.io, { dry_run: dry, ...report, notes });
  else {
    ctx.io.out(dry ? `Dry run of ${all.length} row(s). Nothing was sent.` : `Imported ${all.length} row(s).`);
    ctx.io.out(`  created: ${report.created}`);
    ctx.io.out(`  updated: ${report.updated}`);
    ctx.io.out(`  skipped: ${report.skipped}`);
    ctx.io.out(`  unverified with password: ${report.unverified_with_password}`);
    if (!dry) ctx.io.out(`  failed: ${report.failed}`);
    for (const n of notes) ctx.io.out(`  note: ${n}`);
    if (report.failed) ctx.io.out(`Per-row issues: GET /v1/jobs/<job-id>/errors for jobs ${report.jobs.join(', ')}`);
  }
  return report.failed > 0 ? 2 : 0;
}

/**
 * The relay agent's job handling: allow-list check, then run the LDAP steps or the HTTP request locally.
 * Transport-free (executors are injected) so it is testable without a directory or network.
 */

export interface Destination {
  host: string;
  port: number;
}

const DEFAULT_PORTS: Record<string, number> = { 'ldap:': 389, 'ldaps:': 636, 'http:': 80, 'https:': 443 };

export function destinationOf(url: string): Destination | null {
  try {
    const u = new URL(url);
    const port = u.port ? Number(u.port) : DEFAULT_PORTS[u.protocol];
    return port && u.hostname ? { host: u.hostname.toLowerCase().replace(/^\[|\]$/g, ''), port } : null;
  } catch {
    return null;
  }
}

/** `host`, `host:port`, `*.domain`, `*.domain:port`. A bare host allows any port; an empty list allows nothing. */
export function allowed(dest: Destination, list: readonly string[]): boolean {
  return list.some((entry) => {
    const m = /^(.+?)(?::(\d{1,5}))?$/.exec(entry.trim().toLowerCase());
    if (!m) return false;
    if (m[2] && Number(m[2]) !== dest.port) return false;
    return m[1]!.startsWith('*.') ? dest.host.endsWith(m[1]!.slice(1)) : dest.host === m[1];
  });
}

export interface LdapStep {
  op: 'bind' | 'search' | 'add' | 'modify' | 'delete';
  dn?: string;
  password?: string;
  baseDN?: string;
  filter?: string;
  pageSize?: number;
  /** add: the new entry's attributes. */
  attributes?: Record<string, string | string[]>;
  /** modify: attribute changes. A unicodePwd value is base64 of the UTF-16LE quoted password. */
  changes?: Array<{ operation: 'add' | 'replace' | 'delete'; attribute: string; values?: string[] }>;
  /** search: only these attributes. */
  returning?: string[];
}
export interface LdapEntry {
  dn: string;
  attributes: Record<string, string | string[] | undefined>;
}
export interface LdapSession {
  bind(dn: string, password: string): Promise<void>;
  search(baseDN: string, filter: string, pageSize?: number, returning?: string[]): Promise<LdapEntry[]>;
  add?(dn: string, attributes: Record<string, string | string[]>): Promise<void>;
  modify?(dn: string, changes: NonNullable<LdapStep['changes']>): Promise<void>;
  del?(dn: string): Promise<void>;
  unbind(): Promise<void>;
}
export interface HttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}
export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export type SqlDriver = 'postgres' | 'mysql' | 'mssql' | 'oracle';
export interface SqlJob {
  url: string;
  driver: SqlDriver;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  tls: boolean;
  statements: Array<{ sql: string; params: unknown[] }>;
}
export interface SqlResult {
  rows?: unknown[];
  rowCount?: number;
  insertId?: string | number | null;
}
export interface Job {
  id: string;
  kind: 'ldap' | 'http' | 'ldap_write' | 'sql';
  payload: { url: string; steps?: LdapStep[] } & Partial<HttpRequest> & Partial<SqlJob>;
}
export interface Executors {
  openLdap(url: string): LdapSession;
  http(req: HttpRequest): Promise<HttpResult>;
  sql?(job: SqlJob): Promise<SqlResult>;
}

/** What this agent is willing to do beyond reading. Both are off unless the operator turns them on. */
export interface Permissions {
  /** RELAY_ALLOW_WRITE=1: run ldap_write jobs (create, change and delete directory entries). */
  write?: boolean;
  /** RELAY_ALLOW_SQL=1: run sql jobs. */
  sql?: boolean;
}

const SQL_DRIVERS: SqlDriver[] = ['postgres', 'mysql', 'mssql', 'oracle'];

/**
 * Rewrite the `?` placeholders (outside quoted text) to the driver's own: `$1` (postgres), `@p1` (mssql),
 * `:1` (oracle); mysql keeps `?`. Statements are admin-authored templates; values are always bound, never spliced in.
 */
export function bindPlaceholders(sql: string, driver: SqlDriver): string {
  if (driver === 'mysql') return sql;
  let out = '';
  let n = 0;
  let quote: string | null = null;
  for (const ch of sql) {
    if (quote) {
      if (ch === quote) quote = null;
      out += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === '?') {
      n += 1;
      out += driver === 'postgres' ? `$${n}` : driver === 'mssql' ? `@p${n}` : `:${n}`;
    } else out += ch;
  }
  return out;
}

/** Run one job; returns the result body to post back, or throws (the message is reported to Atlas). */
export async function handleJob(job: Job, allow: readonly string[], ex: Executors, perms: Permissions = {}): Promise<unknown> {
  const dest = destinationOf(job.payload.url);
  if (!dest || !allowed(dest, allow)) throw new Error(`Destination ${dest ? `${dest.host}:${dest.port}` : 'unknown'} is not on this agent's allow-list.`);
  if (job.kind === 'sql') {
    if (!perms.sql) throw new Error('SQL jobs are disabled on this agent (start it with RELAY_ALLOW_SQL=1).');
    const p = job.payload as SqlJob;
    if (!SQL_DRIVERS.includes(p.driver)) throw new Error('Unknown SQL driver.');
    // The allow-list was checked against `url`; the connection must go to that same host and port.
    if (String(p.host).toLowerCase() !== dest.host || Number(p.port) !== dest.port) throw new Error('The SQL host does not match the job destination.');
    if (!Array.isArray(p.statements) || p.statements.length === 0 || p.statements.length > 8) throw new Error('An sql job needs 1-8 statements.');
    for (const st of p.statements) if (typeof st.sql !== 'string' || !Array.isArray(st.params) || st.params.length > 40) throw new Error('Malformed SQL statement.');
    if (!ex.sql) throw new Error('This agent has no SQL executor.');
    return ex.sql(p);
  }
  if (job.kind === 'ldap_write' && !perms.write) {
    throw new Error('Write jobs are disabled on this agent (start it with RELAY_ALLOW_WRITE=1).');
  }
  if (job.kind === 'ldap_write' && new URL(job.payload.url).protocol !== 'ldaps:') {
    throw new Error('Directory writes need ldaps:// so passwords are never sent in the clear.');
  }
  if (job.kind === 'http') {
    const p = job.payload as HttpRequest;
    if (!/^https?:$/.test(new URL(p.url).protocol)) throw new Error('Only http(s) targets are supported.');
    return ex.http(p);
  }
  const steps = job.payload.steps ?? [];
  const write = job.kind === 'ldap_write';
  if (steps.length === 0 || steps.length > (write ? 12 : 5)) throw new Error(`An ${job.kind} job needs 1-${write ? 12 : 5} steps.`);
  const session = ex.openLdap(job.payload.url);
  try {
    let entries: LdapEntry[] | undefined;
    for (const step of steps) {
      if (step.op === 'bind') await session.bind(step.dn ?? '', step.password ?? '');
      else if (step.op === 'search') entries = await session.search(step.baseDN ?? '', step.filter ?? '(objectClass=*)', step.pageSize, step.returning);
      else if (write && step.op === 'add' && session.add) await session.add(step.dn ?? '', step.attributes ?? {});
      else if (write && step.op === 'modify' && session.modify) await session.modify(step.dn ?? '', step.changes ?? []);
      else if (write && step.op === 'delete' && session.del) await session.del(step.dn ?? '');
      else throw new Error('Unknown ldap step.');
    }
    return entries ? { entries } : {};
  } finally {
    await session.unbind().catch(() => undefined);
  }
}

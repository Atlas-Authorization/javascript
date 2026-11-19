import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';
import { Tables } from './export/frameworks/tables';
import { dumpCommands, planAuthjs } from './authjs-plan';

const NOW = new Date('2026-06-01T00:00:00Z');
const BCRYPT = `$2b$10$${'a'.repeat(53)}`;

const tables = (extra: Record<string, Record<string, unknown>[]> = {}) =>
  new Tables({
    User: [
      { id: 'u1', email: 'a@example.com', emailVerified: '2026-01-01T00:00:00Z', password: BCRYPT },
      { id: 'u2', email: 'b@example.com', emailVerified: null, password: 'plain-text-not-a-hash' },
      { id: 'u3', email: null },
    ],
    Account: [
      { userId: 'u1', type: 'oauth', provider: 'github', providerAccountId: '1' },
      { userId: 'u2', type: 'credentials', provider: 'credentials', providerAccountId: 'u2' },
    ],
    ...extra,
  });

describe('planAuthjs', () => {
  it('counts users, passwords, accounts and sessions', () => {
    const p = planAuthjs(tables({ Session: [{ sessionToken: 't', userId: 'u1', expires: '2026-12-01T00:00:00Z' }, { sessionToken: 'o', userId: 'u1', expires: '2026-01-01T00:00:00Z' }] }), { dump: './dump', now: NOW });
    expect(p.users).toEqual({ total: 3, withEmail: 2, withoutEmail: 1, verified: 1 });
    expect(p.passwords).toEqual({ carried: 1, unreadable: 1 });
    expect(p.accounts).toEqual({ oauth: 1, other: 1, providers: ['github'] });
    expect(p.sessions).toEqual({ total: 2, live: 1 });
  });

  it('recommends import always, lazy link for unreadable passwords, the bridge for live or JWT sessions', () => {
    const withSessions = planAuthjs(tables({ Session: [{ sessionToken: 't', userId: 'u1', expires: '2026-12-01T00:00:00Z' }] }), { dump: './dump', now: NOW });
    const rec = (p: typeof withSessions) => p.routes.filter((r) => r.recommended).map((r) => r.id);
    expect(rec(withSessions)).toEqual(['import', 'lazy_link', 'session_bridge']);
    const jwt = planAuthjs(tables(), { dump: './dump', now: NOW });
    expect(jwt.routes.find((r) => r.id === 'session_bridge')!.why).toContain('JWT');
    const clean = planAuthjs(new Tables({ users: [{ id: 'x', email: 'x@example.com', password: BCRYPT }], sessions: [{ sessionToken: 'o', userId: 'x', expires: '2026-01-01T00:00:00Z' }] }), { dump: 'd', now: NOW });
    expect(rec(clean)).toEqual(['import']);
    expect(clean.routes[0]!.commands[0]).toBe('atlas migrate authjs export --set dump=d');
  });
});

describe('dumpCommands', () => {
  it('hides the password and never carries it into a command', () => {
    const out = dumpCommands('postgres://app:s3cret@db.example.com/app', './dump').join('\n');
    expect(out).not.toContain('s3cret');
    expect(out).toContain('postgres://app:***@db.example.com/app');
    expect(out).toContain('$DATABASE_URL');
  });
});

describe('atlas migrate plan --from authjs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-plan-'));
    mkdirSync(join(dir, 'dump'));
    writeFileSync(join(dir, 'dump', 'User.json'), JSON.stringify([{ id: 'u1', email: 'a@example.com', emailVerified: '2026-01-01T00:00:00Z' }]));
    writeFileSync(join(dir, 'export.json'), JSON.stringify({ users: [{ id: 'u1', email: 'a@example.com' }], accounts: [], sessions: [] }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = (io: ReturnType<typeof captureIO>): RunContext => ({
    io,
    env: {},
    config: new MemoryConfigStore(),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    readFile: (p) => readFileSync(p, 'utf8'),
  });

  it('reads a dump folder and prints the routes with exact commands', async () => {
    const io = captureIO();
    expect(await run(['migrate', 'plan', '--from', 'authjs', '--set', `dump=${join(dir, 'dump')}`], ctx(io))).toBe(0);
    expect(io.stdout()).toContain('users       1');
    expect(io.stdout()).toContain('atlas migrate authjs import');
  });

  it('reads a --file export and answers --json', async () => {
    const io = captureIO();
    expect(await run(['migrate', 'plan', '--from', 'authjs', '--file', join(dir, 'export.json'), '--json'], ctx(io))).toBe(0);
    expect(JSON.parse(io.stdout())).toMatchObject({ object: 'migration_plan', vendor: 'authjs', users: { total: 1 } });
  });

  it('--db prints the dump commands and says it does not connect', async () => {
    const io = captureIO();
    expect(await run(['migrate', 'plan', '--from', 'authjs', '--db', 'postgres://u:pw@h/db'], ctx(io))).toBe(1);
    expect(io.stdout()).toContain('--db does not connect');
    expect(io.stdout()).not.toContain(':pw@');
  });
});

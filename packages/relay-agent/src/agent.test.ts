import { describe, expect, it, vi } from 'vitest';
import { allowed, bindPlaceholders, destinationOf, handleJob, type Executors } from './agent';

const session = () => ({
  bind: vi.fn(async () => undefined),
  search: vi.fn(async () => [{ dn: 'uid=a', attributes: { mail: 'a@x.test' } }]),
  unbind: vi.fn(async () => undefined),
});
const exec = (s = session()): Executors & { s: ReturnType<typeof session> } => ({
  s,
  openLdap: () => s,
  http: async () => ({ status: 200, headers: {}, body: 'ok' }),
});

describe('relay agent', () => {
  it('matches the allow-list', () => {
    expect(allowed(destinationOf('ldaps://dc1.corp.test')!, ['*.corp.test:636'])).toBe(true);
    expect(allowed(destinationOf('ldaps://dc1.corp.test')!, ['dc1.corp.test:389'])).toBe(false);
    expect(allowed(destinationOf('ldaps://dc1.corp.test')!, [])).toBe(false);
  });
  it('runs bind then search on one session and unbinds', async () => {
    const ex = exec();
    const out = await handleJob(
      { id: 'j', kind: 'ldap', payload: { url: 'ldaps://dc1.corp.test', steps: [{ op: 'bind', dn: 'cn=svc', password: 'p' }, { op: 'search', baseDN: 'dc=corp', filter: '(uid=a)' }] } },
      ['dc1.corp.test'],
      ex,
    );
    expect(out).toEqual({ entries: [{ dn: 'uid=a', attributes: { mail: 'a@x.test' } }] });
    expect(ex.s.bind).toHaveBeenCalledWith('cn=svc', 'p');
    expect(ex.s.unbind).toHaveBeenCalled();
  });
  it('propagates a failed bind and still unbinds', async () => {
    const ex = exec();
    ex.s.bind.mockRejectedValueOnce(new Error('Invalid credentials'));
    await expect(handleJob({ id: 'j', kind: 'ldap', payload: { url: 'ldap://dc1.corp.test', steps: [{ op: 'bind', dn: 'x', password: 'y' }] } }, ['dc1.corp.test'], ex)).rejects.toThrow('Invalid credentials');
    expect(ex.s.unbind).toHaveBeenCalled();
  });
  it('refuses a destination off the allow-list without touching the network', async () => {
    const ex = exec();
    await expect(handleJob({ id: 'j', kind: 'http', payload: { url: 'http://169.254.169.254/', method: 'GET' } }, ['hr.corp.test'], ex)).rejects.toThrow('allow-list');
  });
  it('forwards an allowed http request', async () => {
    expect(await handleJob({ id: 'j', kind: 'http', payload: { url: 'https://hr.corp.test/api', method: 'GET' } }, ['hr.corp.test'], exec())).toMatchObject({ status: 200 });
  });
});

describe('relay agent write-back', () => {
  const writeSession = () => ({ ...session(), add: vi.fn(async () => undefined), modify: vi.fn(async () => undefined), del: vi.fn(async () => undefined) });
  const writeJob = (steps: any[], url = 'ldaps://dc1.corp.test:636') => ({ id: 'j', kind: 'ldap_write' as const, payload: { url, steps } });

  it('refuses directory writes unless the operator turned them on', async () => {
    await expect(handleJob(writeJob([{ op: 'bind', dn: 'x', password: 'y' }]), ['dc1.corp.test'], exec())).rejects.toThrow('RELAY_ALLOW_WRITE');
  });
  it('refuses a write over clear-text ldap://', async () => {
    await expect(handleJob(writeJob([{ op: 'bind', dn: 'x', password: 'y' }], 'ldap://dc1.corp.test'), ['dc1.corp.test'], exec(), { write: true })).rejects.toThrow('ldaps');
  });
  it('runs add, modify and delete on one session', async () => {
    const s = writeSession();
    const ex = { ...exec(s as never), openLdap: () => s as never };
    await handleJob(
      writeJob([
        { op: 'bind', dn: 'cn=svc', password: 'p' },
        { op: 'add', dn: 'cn=a,dc=corp', attributes: { cn: 'a' } },
        { op: 'modify', dn: 'cn=a,dc=corp', changes: [{ operation: 'replace', attribute: 'mail', values: ['a@x.test'] }] },
        { op: 'delete', dn: 'cn=a,dc=corp' },
      ]),
      ['dc1.corp.test'],
      ex,
      { write: true },
    );
    expect(s.add).toHaveBeenCalledWith('cn=a,dc=corp', { cn: 'a' });
    expect(s.modify).toHaveBeenCalled();
    expect(s.del).toHaveBeenCalledWith('cn=a,dc=corp');
    expect(s.unbind).toHaveBeenCalled();
  });
  it('a read-only ldap job cannot smuggle in a write step', async () => {
    await expect(handleJob({ id: 'j', kind: 'ldap', payload: { url: 'ldaps://dc1.corp.test', steps: [{ op: 'delete', dn: 'cn=a' }] } }, ['dc1.corp.test'], exec(), { write: true })).rejects.toThrow('Unknown ldap step');
  });
});

describe('relay agent sql', () => {
  const job = (over: Record<string, unknown> = {}) => ({
    id: 'j',
    kind: 'sql' as const,
    payload: { url: 'postgres://db.corp.test:5432', driver: 'postgres', host: 'db.corp.test', port: 5432, database: 'app', user: 'u', password: 'p', tls: true, statements: [{ sql: 'select 1', params: [] }], ...over },
  });
  const sqlEx = (): Executors => ({ ...exec(), sql: vi.fn(async () => ({ rows: [{ id: 7 }], rowCount: 1 })) });

  it('is off unless the operator turned it on', async () => {
    await expect(handleJob(job() as never, ['db.corp.test'], sqlEx())).rejects.toThrow('RELAY_ALLOW_SQL');
  });
  it('runs on an allowed host and returns the result', async () => {
    expect(await handleJob(job() as never, ['db.corp.test:5432'], sqlEx(), { sql: true })).toEqual({ rows: [{ id: 7 }], rowCount: 1 });
  });
  it('refuses a connection to a host other than the allow-listed destination', async () => {
    await expect(handleJob(job({ host: 'other.corp.test' }) as never, ['db.corp.test'], sqlEx(), { sql: true })).rejects.toThrow('does not match');
    await expect(handleJob(job({ port: 6543 }) as never, ['db.corp.test'], sqlEx(), { sql: true })).rejects.toThrow('does not match');
  });
  it('refuses a destination off the allow-list, an unknown driver and too many statements', async () => {
    await expect(handleJob(job() as never, ['hr.corp.test'], sqlEx(), { sql: true })).rejects.toThrow('allow-list');
    await expect(handleJob(job({ driver: 'sqlite' }) as never, ['db.corp.test'], sqlEx(), { sql: true })).rejects.toThrow('driver');
    await expect(handleJob(job({ statements: Array(9).fill({ sql: 'select 1', params: [] }) }) as never, ['db.corp.test'], sqlEx(), { sql: true })).rejects.toThrow('1-8');
  });
  it('rewrites ? placeholders per driver and leaves quoted text alone', () => {
    const q = "select '?' as a, name from t where id = ? and email = ?";
    expect(bindPlaceholders(q, 'postgres')).toBe("select '?' as a, name from t where id = $1 and email = $2");
    expect(bindPlaceholders(q, 'mssql')).toBe("select '?' as a, name from t where id = @p1 and email = @p2");
    expect(bindPlaceholders(q, 'oracle')).toBe("select '?' as a, name from t where id = :1 and email = :2");
    expect(bindPlaceholders(q, 'mysql')).toBe(q);
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO, type CaptureIO } from '../io';
import { run } from '../run';
import { parseTimestamp } from './import-jsonl';

/** An instance that keeps users and answers the import route the way the real one does. */
class Api implements ConfigHttp {
  users: Array<Record<string, any>> = [];
  bodies: Array<Record<string, any>> = [];
  patches: Array<{ path: string; body: unknown }> = [];
  verifies: string[] = [];

  async get<T>(path: string): Promise<T> {
    const id = new URL(path, 'https://x').searchParams.get('external_id');
    return { data: this.users.filter((u) => u.external_id === id) } as T;
  }
  async post<T>(path: string, body: unknown): Promise<T> {
    if (path.endsWith('/verify')) {
      this.verifies.push(path);
      return {} as T;
    }
    const b = body as { users: Array<Record<string, any>>; upsert: boolean };
    this.bodies.push(b);
    const results = b.users.map((row) => {
      const hit = this.users.find((u) => u.email_addresses.some((e: any) => e.verified && e.email_address === row.email_address));
      if (hit && !b.upsert) return { outcome: 'matched' };
      if (hit) {
        hit.external_id = row.external_id;
        hit.updated_at = Date.now();
        return { outcome: 'updated' };
      }
      this.users.push({
        id: `user_${this.users.length}`,
        external_id: row.external_id,
        updated_at: Date.now(),
        password_enabled: Boolean(row.password_hash),
        email_addresses: [{ id: `em_${this.users.length}`, email_address: row.email_address, verified: row.email_verified === true }],
      });
      return { outcome: 'created' };
    });
    return { id: `job_${this.bodies.length}`, status: 'completed', total: b.users.length, succeeded: b.users.length, failed: 0, results } as T;
  }
  async put<T>(): Promise<T> {
    return {} as T;
  }
  async patch<T>(path: string, body: unknown): Promise<T> {
    this.patches.push({ path, body });
    return {} as T;
  }
  async delete(): Promise<void> {}
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-cli-import-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = (io: CaptureIO, api: ConfigHttp): RunContext => ({
  io,
  env: {},
  config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
  prompt: { text: async () => '', secret: async () => '' },
  makeClient: () => ({}) as ManagementClient,
  makeHttp: () => api,
  readFile: (p) => readFileSync(p, 'utf8'),
});
const write = (rows: unknown[]) => {
  const p = join(dir, 'users.jsonl');
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
};
const report = async (api: Api, argv: string[]) => {
  const io = captureIO();
  const code = await run(['import', ...argv, '--json'], ctx(io, api));
  return { code, body: JSON.parse(io.stdout()) };
};

const ANN = { external_id: 'a1', email: 'ann@example.com', email_verified: true, password_digest: '$2b$10$digestdigest', algorithm: 'bcrypt', oauth_identities: [{ provider: 'google', provider_user_id: 'g1' }], created_at: '2026-01-01T00:00:00Z' };
const BOB = { external_id: 'b2', email: 'bob@example.com', email_verified: false, password_digest: '$2b$10$digestbob', created_at: '2026-06-01T00:00:00Z' };

describe('atlas import <users.jsonl>', () => {
  it('maps the fields onto the import route', async () => {
    const api = new Api();
    const { code, body } = await report(api, [write([ANN]), '--password-policy', 'until_email_verified']);
    expect(code).toBe(0);
    expect(body).toMatchObject({ created: 1, updated: 0, skipped: 0 });
    expect(api.bodies[0]).toMatchObject({
      upsert: false,
      password_policy: 'until_email_verified',
      users: [{ email_address: 'ann@example.com', external_id: 'a1', email_verified: true, password_hash: ANN.password_digest, password_hasher: 'bcrypt', external_accounts: [{ provider: 'google', provider_user_id: 'g1' }], created_at: ANN.created_at }],
    });
  });

  it('re-running the same file changes nothing, under skip and under update, unverified rows included', async () => {
    const api = new Api();
    const f = write([ANN, BOB]);
    expect((await report(api, [f])).body).toMatchObject({ created: 2, unverified_with_password: 1 });
    const sent = api.bodies.length;
    for (const mode of ['skip', 'update']) {
      expect((await report(api, [f, '--on-conflict', mode])).body).toMatchObject({ created: 0, updated: 0, skipped: 2 });
    }
    expect(api.bodies).toHaveLength(sent);
    expect(api.users).toHaveLength(2);
  });

  it('--on-conflict update applies a row changed after the first import; skip does not', async () => {
    const api = new Api();
    await report(api, [write([ANN])]);
    api.users[0]!.updated_at = Date.parse('2026-02-01T00:00:00Z');
    const changed = write([{ ...ANN, first_name: 'Ann', updated_at: '2026-03-01T00:00:00Z' }]);
    expect((await report(api, [changed])).body).toMatchObject({ updated: 0, skipped: 1 });
    expect((await report(api, [changed, '--on-conflict', 'update'])).body).toMatchObject({ updated: 1, skipped: 0 });
    expect(api.bodies.at(-1)).toMatchObject({ upsert: true });
  });

  it('an unverified existing user is updated by id, never through the import that would duplicate it', async () => {
    const api = new Api();
    await report(api, [write([BOB])]);
    const sent = api.bodies.length;
    const { body } = await report(api, [write([{ ...BOB, email_verified: true, first_name: 'Bob' }]), '--on-conflict', 'update']);
    expect(body).toMatchObject({ updated: 1 });
    expect(api.bodies).toHaveLength(sent);
    expect(api.patches[0]).toMatchObject({ path: '/v1/users/user_0', body: { first_name: 'Bob' } });
    expect(api.verifies).toEqual(['/v1/users/user_0/email_addresses/em_0/verify']);
  });

  it('a changed email is left alone and named by external id, not by address', async () => {
    const api = new Api();
    await report(api, [write([ANN])]);
    const sent = api.bodies.length;
    const { body } = await report(api, [write([{ ...ANN, email: 'new@example.com' }]), '--on-conflict', 'update']);
    expect(body).toMatchObject({ updated: 0, skipped: 1 });
    expect(JSON.stringify(body.notes)).toContain('a1');
    expect(JSON.stringify(body)).not.toContain('new@example.com');
    expect(api.bodies).toHaveLength(sent);
  });

  it('a verified email already here without this external id counts as skipped under skip', async () => {
    const api = new Api();
    api.users = [{ id: 'user_x', external_id: null, email_addresses: [{ id: 'e', email_address: 'ann@example.com', verified: true }] }];
    expect((await report(api, [write([ANN])])).body).toMatchObject({ created: 0, skipped: 1, failed: 0 });
  });

  it('--since keeps newer rows, by updated_at then created_at; a row with no date stays', async () => {
    const api = new Api();
    const f = write([ANN, BOB, { external_id: 'c3', email: 'c@example.com' }, { ...ANN, external_id: 'd4', email: 'd@example.com', updated_at: '2026-07-01T00:00:00Z' }]);
    const { body } = await report(api, [f, '--since', '2026-05-01T00:00:00Z']);
    expect(body).toMatchObject({ created: 3, skipped: 1 });
    expect(api.bodies[0]!.users.map((u: any) => u.external_id)).toEqual(['b2', 'c3', 'd4']);
  });

  it('--dry-run prints counts and no email address, and sends nothing', async () => {
    const api = new Api();
    const io = captureIO();
    expect(await run(['import', write([ANN, BOB]), '--dry-run'], ctx(io, api))).toBe(0);
    expect(io.stdout()).toContain('created: 2');
    expect(io.stdout()).toContain('unverified with password: 1');
    expect(io.stdout()).not.toContain('@example.com');
    expect(io.stdout()).not.toContain('digest');
    expect(api.bodies).toEqual([]);
  });

  it('refuses a bad file by line, without echoing it', async () => {
    const api = new Api();
    const p = join(dir, 'bad.jsonl');
    writeFileSync(p, `${JSON.stringify(ANN)}\n{not json ann@example.com\n`);
    const io = captureIO();
    expect(await run(['import', p], ctx(io, api))).toBe(1);
    expect(io.stderr()).toContain('Line 2');
    expect(io.stderr()).not.toContain('ann@example.com');

    for (const [rows, msg] of [[[{ email: 'x@example.com' }], 'no external_id'], [[{ external_id: 'x' }], 'no email'], [[ANN, ANN], 'repeats']] as const) {
      const e = captureIO();
      expect(await run(['import', write([...rows])], ctx(e, api))).toBe(1);
      expect(e.stderr()).toContain(msg);
    }
  });

  it('refuses bad flag values', async () => {
    const f = write([ANN]);
    for (const [flag, value] of [['--on-conflict', 'merge'], ['--password-policy', 'never'], ['--since', 'someday']] as const) {
      const io = captureIO();
      expect(await run(['import', f, flag, value], ctx(io, new Api()))).toBe(1);
      expect(io.stderr()).toContain(flag);
    }
  });

  it('with neither a file nor --from, says what it needs', async () => {
    const io = captureIO();
    expect(await run(['import'], ctx(io, new Api()))).toBe(1);
    expect(io.stderr()).toContain('users file');
  });

  it('vendor imports take the same flags', async () => {
    const api = new Api();
    const p = join(dir, 'clerk.json');
    writeFileSync(p, JSON.stringify([{ id: 'u1', email_addresses: [{ email_address: 'ann@example.com' }], created_at: 1_700_000_000_000 }, { id: 'u2', email_addresses: [{ email_address: 'bob@example.com' }], created_at: 1_800_000_000_000 }]));
    const io = captureIO();
    const code = await run(['import', '--from', 'clerk', p, '--on-conflict', 'skip', '--password-policy', 'until_email_verified', '--since', '1750000000000', '--state-file', join(dir, 's.json')], ctx(io, api));
    expect(code).toBe(0);
    expect(api.bodies[0]).toMatchObject({ upsert: false, password_policy: 'until_email_verified' });
    expect(api.bodies[0]!.users).toHaveLength(1);
  });
});

describe('parseTimestamp', () => {
  it('reads seconds, milliseconds and ISO; undefined otherwise', () => {
    expect(parseTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
    expect(parseTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(parseTimestamp('1700000000000')).toBe(1_700_000_000_000);
    expect(parseTimestamp('2026-01-01T00:00:00Z')).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(parseTimestamp('nope')).toBeUndefined();
    expect(parseTimestamp(undefined)).toBeUndefined();
  });
});

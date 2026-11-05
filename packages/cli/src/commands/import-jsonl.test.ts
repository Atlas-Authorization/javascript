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
  /** external_id -> the reason the API refuses that row's hash. */
  refused: Record<string, string> = {};
  /** external_id -> warnings the API returns on that row. */
  rowWarnings: Record<string, Array<{ code: string; message: string }>> = {};
  jobErrors: Array<Record<string, unknown>> = [];
  errorsUnreadable = false;

  async get<T>(path: string): Promise<T> {
    if (path.endsWith('/errors')) {
      if (this.errorsUnreadable) throw new Error('no jobs:read');
      return { object: 'list', data: this.jobErrors } as T;
    }
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
    let failed = 0;
    const results = b.users.map((row, index) => {
      const reason = this.refused[row.external_id];
      if (reason) {
        failed += 1;
        this.jobErrors.push({ index, email: row.email_address, code: 'unsupported_password_hash', message: reason });
        return { outcome: 'failed' };
      }
      const warnings = this.rowWarnings[row.external_id];
      if (warnings) return { outcome: 'created', warnings };
      const unverified = (b as Record<string, any>).password_policy && b.upsert
        ? this.users.find((u) => u.external_id === row.external_id && u.password_enabled && u.email_addresses.some((e: any) => !e.verified && e.email_address === row.email_address))
        : undefined;
      if (unverified) {
        unverified.held = true;
        return { outcome: 'updated' };
      }
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
    return { id: `job_${this.bodies.length}`, status: 'completed', total: b.users.length, succeeded: b.users.length - failed, failed, results } as T;
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

const KEY = 'ab'.repeat(32);
const HEX_HASH = `scrypt$16384$8$1$a1b2c3d4e5f60718$${KEY}`;
const HEX_ROW = { external_id: 'h1', email: 'hex@example.com', email_verified: true, password_digest: HEX_HASH, algorithm: 'scrypt_node' };

describe('atlas import: password hash parameters', () => {
  it('sends password_hash_params under password_hash_algorithm, the only way the API reads them', async () => {
    const api = new Api();
    const { code, body } = await report(api, [write([{ ...HEX_ROW, password_hash_params: { salt_encoding: 'hex' } }])]);
    expect(code).toBe(0);
    const sent = api.bodies[0]!.users[0];
    expect(sent).toMatchObject({ password_hash: HEX_HASH, password_hash_algorithm: 'scrypt_node', password_hash_params: { salt_encoding: 'hex' } });
    expect(sent).not.toHaveProperty('password_hasher');
    expect(body.warnings).toEqual([]);
  });

  it('with no algorithm, a Node scrypt string is named scrypt_node, as the API would read it', async () => {
    const api = new Api();
    const { algorithm: _a, ...row } = HEX_ROW;
    await report(api, [write([{ ...row, password_hash_params: { salt_encoding: 'hex' } }])]);
    expect(api.bodies[0]!.users[0]).toMatchObject({ password_hash_algorithm: 'scrypt_node' });
  });

  it('refuses parameters the API could not attach to anything, before sending', async () => {
    const api = new Api();
    const noDigest = { external_id: 'x', email: 'x@example.com', password_hash_params: { n: 16384 } };
    const noAlgorithm = { ...noDigest, password_digest: 'c2FsdA$aGFzaA' };
    const digitSalt = { ...noDigest, password_digest: `scrypt$16384$8$1$123456$${KEY}` };
    for (const [row, msg] of [[noDigest, 'no password_digest'], [noAlgorithm, 'no algorithm'], [digitSalt, 'no algorithm']] as const) {
      const io = captureIO();
      expect(await run(['import', write([row])], ctx(io, api))).toBe(1);
      expect(io.stderr()).toContain('Line 1');
      expect(io.stderr()).toContain(msg);
    }
    expect(api.bodies).toEqual([]);
  });

  it('a named scrypt format settles an all-digit salt; any other algorithm stays password_hasher', async () => {
    const api = new Api();
    await report(api, [write([{ ...HEX_ROW, password_digest: `scrypt$16384$8$1$123456$${KEY}` }, { ...ANN, external_id: 'a2', email: 'a2@example.com' }])]);
    const [digits, bcrypt] = api.bodies[0]!.users;
    expect(digits).toMatchObject({ password_hash_algorithm: 'scrypt_node' });
    expect(bcrypt).toMatchObject({ password_hasher: 'bcrypt' });
    expect(bcrypt).not.toHaveProperty('password_hash_algorithm');
  });

  it('warns about a hex-looking scrypt salt with no salt_encoding, by external id and without the hash', async () => {
    const api = new Api();
    for (const argv of [['--dry-run'], []]) {
      const { code, body } = await report(api, [write([HEX_ROW]), ...argv]);
      expect(code).toBe(0);
      expect(body.warnings).toMatchObject([{ code: 'ambiguous_scrypt_salt', count: 1, external_ids: ['h1'] }]);
      expect(JSON.stringify(body)).not.toContain('a1b2c3d4e5f60718');
      api.users = [];
    }
    const io = captureIO();
    expect(await run(['import', write([HEX_ROW])], ctx(io, new Api()))).toBe(0);
    expect(io.stdout()).toContain('warning: ambiguous_scrypt_salt: 1 row(s)');
    expect(io.stdout()).toContain('external_id: h1');
    expect(io.stdout()).not.toContain(KEY);
  });

  it('does not warn when the salt encoding is stated, the salt is not hex, or the digest is not scrypt', async () => {
    const rows = [
      { ...HEX_ROW, external_id: 's1', email: 's1@example.com', password_hash_params: { salt_encoding: 'utf8' } },
      { ...HEX_ROW, external_id: 's2', email: 's2@example.com', password_digest: `scrypt$16384$8$1$not-hex-salt$${KEY}` },
      { ...ANN, external_id: 's3', email: 's3@example.com', password_salt: 'a1b2c3d4e5f60718' },
    ];
    expect((await report(new Api(), [write(rows)])).body.warnings).toEqual([]);
  });

  it('warns about a hex-looking password_salt under a named scrypt too', async () => {
    const row = { ...HEX_ROW, password_digest: KEY, algorithm: 'scrypt', password_salt: 'a1b2c3d4e5f60718' };
    expect((await report(new Api(), [write([row])])).body.warnings).toMatchObject([{ code: 'ambiguous_scrypt_salt' }]);
  });

  it('names rows the API refuses as unsupported_password_hash, grouped by reason, with no email', async () => {
    const api = new Api();
    api.refused = { a1: 'password_hash: not self-describing.', b2: 'password_hash: not self-describing.' };
    const { code, body } = await report(api, [write([ANN, BOB])]);
    expect(code).toBe(2);
    expect(body).toMatchObject({ created: 0, failed: 2 });
    expect(body.warnings).toMatchObject([{ code: 'unsupported_password_hash', count: 2, external_ids: ['a1', 'b2'] }]);
    expect(body.warnings[0].message).toContain('not self-describing');
    expect(JSON.stringify(body)).not.toContain('@example.com');
    expect(JSON.stringify(body)).not.toContain('digest');
  });

  it('still reports the counts when the row errors cannot be read', async () => {
    const api = new Api();
    api.refused = { a1: 'nope' };
    api.errorsUnreadable = true;
    const { code, body } = await report(api, [write([ANN])]);
    expect(code).toBe(2);
    expect(body).toMatchObject({ failed: 1, warnings: [] });
  });
});

describe('atlas import: holds and what the report says about them', () => {
  const HOLD = ['--password-policy', 'until_email_verified', '--on-conflict', 'update'];

  it('sends an existing unverified row with a password to the import, which holds it; nothing is duplicated', async () => {
    const api = new Api();
    await report(api, [write([BOB])]);
    const { code, body } = await report(api, [write([BOB]), ...HOLD]);
    expect(code).toBe(0);
    expect(body).toMatchObject({ created: 0, updated: 1, skipped: 0 });
    expect(api.bodies[1]).toMatchObject({ upsert: true, password_policy: 'until_email_verified', users: [{ external_id: 'b2' }] });
    expect(api.users).toHaveLength(1);
    expect(api.users[0]!.held).toBe(true);
    expect(api.patches).toEqual([]);
  });

  it('names a verified row as not held, once, whether or not it needed sending', async () => {
    const api = new Api();
    await report(api, [write([ANN])]);
    const unchanged = await report(api, [write([ANN]), ...HOLD]);
    expect(unchanged.body.warnings).toMatchObject([{ code: 'password_policy_not_applied', count: 1, external_ids: ['a1'] }]);
    api.rowWarnings = { a1: [{ code: 'password_policy_not_applied', message: 'x' }] };
    const changed = await report(api, [write([{ ...ANN, first_name: 'Ann' }]), ...HOLD]);
    expect(changed.body.warnings).toMatchObject([{ code: 'password_policy_not_applied', count: 1, external_ids: ['a1'] }]);
  });

  it('notes that a skip left an existing unverified row as it was', async () => {
    const api = new Api();
    await report(api, [write([BOB])]);
    const { body } = await report(api, [write([BOB]), '--password-policy', 'until_email_verified']);
    expect(body).toMatchObject({ skipped: 1 });
    expect(body.notes.join()).toContain('--on-conflict update');
    expect(body.notes.join()).toContain('b2');
  });

  it('reports the API warning by external_id, and says what will happen, with no failed count or address', async () => {
    const api = new Api();
    api.rowWarnings = { b2: [{ code: 'unverified_without_hold', message: 'x' }] };
    const { code, body } = await report(api, [write([BOB])]);
    expect(code).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.warnings).toMatchObject([{ code: 'unverified_without_hold', external_ids: ['b2'] }]);
    expect(body.warnings[0].message).toContain('second account');
    expect(JSON.stringify(body)).not.toContain('@example.com');
  });

  it('a dry run predicts the warning for a row with a credential, not a credential-less or held one', async () => {
    const bare = { external_id: 'n1', email: 'n@example.com' };
    const linked = { external_id: 'o1', email: 'o@example.com', oauth_identities: [{ provider: 'google', provider_user_id: 'g' }] };
    const plain = await report(new Api(), [write([ANN, BOB, bare, linked]), '--dry-run']);
    expect(plain.body.warnings).toMatchObject([{ code: 'unverified_without_hold', count: 2, external_ids: ['b2', 'o1'] }]);
    const held = await report(new Api(), [write([ANN, BOB, bare, linked]), '--dry-run', '--password-policy', 'until_email_verified']);
    expect(held.body.warnings).toMatchObject([{ code: 'unverified_without_hold', count: 1, external_ids: ['o1'] }]);
  });
});

describe('atlas import: the headline', () => {
  const headline = async (api: Api, argv: string[]) => {
    const io = captureIO();
    const code = await run(['import', ...argv], ctx(io, api));
    return { code, first: io.stdout().split('\n')[0] };
  };

  it('counts rows actually created or updated, not rows in the file', async () => {
    const api = new Api();
    api.refused = { a1: 'password_hash: not self-describing.' };
    expect(await headline(api, [write([ANN])])).toEqual({ code: 2, first: 'Imported 0 of 1 row(s).' });
    const mixed = new Api();
    mixed.refused = { a1: 'nope', c3: 'nope' };
    expect((await headline(mixed, [write([ANN, BOB, { external_id: 'c3', email: 'c@example.com' }])])).first).toBe('Imported 1 of 3 row(s).');
  });

  it('a re-run says it imported nothing; a dry run says what it would do', async () => {
    const api = new Api();
    const f = write([ANN, BOB]);
    expect((await headline(api, [f, '--dry-run'])).first).toBe('Dry run: would import 2 of 2 row(s). Nothing was sent.');
    await headline(api, [f]);
    expect((await headline(api, [f])).first).toBe('Imported 0 of 2 row(s).');
    expect((await headline(api, [f, '--dry-run'])).first).toBe('Dry run: would import 0 of 2 row(s). Nothing was sent.');
  });
});

describe('atlas import: unknown password_hash_params keys', () => {
  it('refuses them before sending anything, naming the line, the key and its nearest match', async () => {
    const api = new Api();
    const io = captureIO();
    const typo = { ...HEX_ROW, password_hash_params: { salt_encodng: 'hex' } };
    expect(await run(['import', write([BOB, typo])], ctx(io, api))).toBe(1);
    expect(io.stderr()).toContain('Line 2');
    expect(io.stderr()).toContain('salt_encodng (did you mean salt_encoding?)');
    expect(io.stderr()).not.toContain('@example.com');
    expect(io.stderr()).not.toContain(HEX_HASH);
    expect(api.bodies).toEqual([]);
  });

  it('accepts the API\'s aliases and any case, as the API does', async () => {
    const row = { ...HEX_ROW, password_hash_params: { Salt_Encoding: 'hex', key_len: 64, cost: 16384 } };
    expect((await report(new Api(), [write([row])])).code).toBe(0);
  });
});

describe('atlas import: unknown row keys', () => {
  it('refuses them before sending anything, naming the line, each key and its nearest match', async () => {
    const api = new Api();
    const { password_digest: _p, email_verified: _e, ...rest } = ANN;
    const io = captureIO();
    expect(await run(['import', write([BOB, { ...rest, paswword_digest: 'x', emial_verified: true }])], ctx(io, api))).toBe(1);
    expect(io.stderr()).toContain('Line 2');
    expect(io.stderr()).toContain('paswword_digest (did you mean password_digest?)');
    expect(io.stderr()).toContain('emial_verified (did you mean email_verified?)');
    expect(io.stderr()).not.toContain('@example.com');
    expect(api.bodies).toEqual([]);
  });

  it('a misspelled required key is named as misspelled, not as missing', async () => {
    const io = captureIO();
    expect(await run(['import', write([{ externl_id: 'a', email: 'a@example.com' }])], ctx(io, new Api()))).toBe(1);
    expect(io.stderr()).toContain('externl_id (did you mean external_id?)');
  });

  it('a key nothing like a real one still fails, and the message lists what is allowed', async () => {
    const io = captureIO();
    expect(await run(['import', write([{ ...BOB, zzzzzzzzzzzz: 1 }])], ctx(io, new Api()))).toBe(1);
    expect(io.stderr()).toContain('zzzzzzzzzzzz');
    expect(io.stderr()).not.toContain('did you mean');
    expect(io.stderr()).toContain('password_hash_params');
  });

  it('accepts every key the importer reads', async () => {
    const row = { ...ANN, password_salt: 'plain', password_hash_params: { n: 16384 }, first_name: 'A', last_name: 'B', updated_at: '2026-02-01T00:00:00Z' };
    expect((await report(new Api(), [write([row])])).code).toBe(0);
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

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { MemoryConfigStore } from '../config';
import { captureIO } from '../io';
import { run } from '../run';
import { parseCsv } from './csv';
import { atlasProvider, mapExport, parseExport, summarize, type Vendor } from './vendors';

/**
 * `atlas import --from <vendor>`: every vendor's export format, mapped from a
 * fixture shaped like the real export, then the batch/dry-run/resume behaviour
 * driven through `run()` against an in-memory Atlas API.
 */

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const mapped = (vendor: Vendor, file: string, hashes?: string) =>
  mapExport(vendor, parseExport(fixture(file), file), hashes ? parseExport(fixture(hashes), hashes) : undefined);

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, embedded commas/newlines, CRLF and a BOM', () => {
    const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\r\n\r\n1,\n');
    expect(rows).toEqual([
      { a: 'x, y', b: 'say "hi"\nthere' },
      { a: '1', b: '' },
    ]);
  });
});

describe('vendor mappers', () => {
  it('auth0: identities, metadata, phone, skipped phone-only users, merged password export', () => {
    const { rows, warnings } = mapped('auth0', 'auth0-users.ndjson', 'auth0-hashes.ndjson');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      email_address: 'ada@example.com',
      email_verified: true,
      first_name: 'Ada',
      last_name: 'Lovelace',
      external_id: 'auth0|6123',
      public_metadata: { plan: 'pro' },
      unsafe_metadata: { theme: 'dark' },
      password_hash: expect.stringMatching(/^\$2b\$10\$/),
    });
    expect(rows[0]!.external_accounts).toBeUndefined();
    expect(rows[1]).toMatchObject({
      first_name: 'Grace',
      last_name: 'Brewster Hopper',
      external_accounts: [{ provider: 'google', provider_user_id: '1077' }],
      phone_numbers: [{ phone_number: '+14155550100', verified: true }],
    });
    expect(warnings.join(' ')).toMatch(/1 record\(s\) without an email/);
    expect(warnings.join(' ')).toMatch(/Merged 1 password hash/);
  });

  it('auth0 without the hash export says how to move passwords', () => {
    expect(mapped('auth0', 'auth0-users.ndjson').warnings.join(' ')).toMatch(/lazy migration/);
  });

  it('clerk CSV: digest + hasher, verified state from the verified columns', () => {
    const { rows } = mapped('clerk', 'clerk-users.csv');
    expect(rows[0]).toMatchObject({
      email_address: 'ada@example.com',
      email_verified: true,
      external_id: 'user_2a',
      password_hasher: 'bcrypt',
      phone_numbers: [{ phone_number: '+14155550100', verified: true }],
    });
    expect(rows[1]).toMatchObject({ email_address: 'grace@example.com', email_verified: false, first_name: 'Hopper, Jr' });
  });

  it('clerk JSON: social accounts, metadata bags and org memberships', () => {
    const { rows } = mapped('clerk', 'clerk-users.json');
    expect(rows[0]).toMatchObject({
      email_address: 'ann@example.com',
      created_at: 1600000000000,
      external_accounts: [{ provider: 'github', provider_user_id: '99' }],
      public_metadata: { role: 'editor' },
      unsafe_metadata: { nick: 'a' },
      organization_memberships: [{ organization_external_id: 'org_9', organization_slug: 'acme', organization_name: 'Acme', role: 'admin' }],
    });
    expect(rows[0]!.private_metadata).toBeUndefined();
  });

  it('supabase: bcrypt digest, confirmed state, E.164 phone, provider bookkeeping dropped', () => {
    const { rows } = mapped('supabase', 'supabase-users.json');
    expect(rows[0]).toMatchObject({
      email_verified: true,
      first_name: 'Ada',
      last_name: 'Lovelace',
      password_hash: expect.stringMatching(/^\$2a\$/),
      phone_numbers: [{ phone_number: '+14155550100', verified: false }],
      external_accounts: [{ provider: 'google', provider_user_id: '1188' }],
      public_metadata: { tier: 'gold' },
    });
  });

  it('firebase: hash + salt + hasher, social providers, disabled users noted', () => {
    const { rows, warnings } = mapped('firebase', 'firebase-users.json');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      external_id: 'fb1',
      created_at: 1500000000000,
      password_hasher: 'firebase_scrypt',
      password_salt: '42xEC+ixf3L2lw==',
      external_accounts: [{ provider: 'google', provider_user_id: 'g-77' }],
    });
    expect(warnings.join(' ')).toMatch(/disabled in Firebase/);
    expect(warnings.join(' ')).toMatch(/--hash-config/);
  });

  it('cognito: attributes, sub as external id, custom attributes as metadata', () => {
    const { rows, warnings } = mapped('cognito', 'cognito-users.json');
    expect(rows[0]).toMatchObject({ external_id: 'aaaa-1111', email_verified: true, first_name: 'Ada', public_metadata: { tenant: 't1' } });
    expect(warnings[0]).toMatch(/never exports password hashes/);
  });

  it('authjs: users joined to their OAuth accounts; email accounts are not identities', () => {
    const { rows } = mapped('authjs', 'authjs.json');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email_verified: true, external_accounts: [{ provider: 'github', provider_user_id: '4242' }] });
  });

  it('workos: memberships and OAuth identities joined by user, role slug', () => {
    const { rows } = mapped('workos', 'workos-users.json');
    expect(rows[0]).toMatchObject({
      external_id: 'user_01',
      organization_memberships: [{ organization_external_id: 'org_01', organization_name: 'Acme', role: 'admin' }],
      external_accounts: [{ provider: 'google', provider_user_id: '1077' }],
    });
  });

  it('better-auth: credential account hash, social account, org membership, 2FA re-enrol note', () => {
    const { rows, warnings } = mapped('better-auth', 'better-auth.json');
    expect(rows[0]).toMatchObject({
      password_hash: expect.stringMatching(/^0123456789abcdef0123456789abcdef:/),
      external_accounts: [{ provider: 'github', provider_user_id: '5150' }],
      organization_memberships: [{ organization_external_id: 'o1', organization_slug: 'acme', organization_name: 'Acme', role: 'owner' }],
    });
    expect(warnings.join(' ')).toMatch(/re-enrol/);
    expect(summarize(rows)).toMatchObject({ users: 1, with_password_hash: 1, organizations: 1 });
  });

  it('maps provider aliases', () => {
    expect(atlasProvider('google-oauth2')).toBe('google');
    expect(atlasProvider('oauth_discord')).toBe('discord');
    expect(atlasProvider('apple.com')).toBe('apple');
    expect(atlasProvider('github')).toBe('github');
  });
});

describe('atlas import (run)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-import-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  type Call = { method: string; path: string; body?: Record<string, unknown> };
  function ctx(calls: Call[], files: Record<string, string>, failAfter = Infinity): RunContext & { io: ReturnType<typeof captureIO> } {
    let posts = 0;
    const http: ConfigHttp = {
      get: async (p) => {
        calls.push({ method: 'GET', path: p });
        return { id: p.split('/').pop(), status: 'completed', total: 1, succeeded: 1, failed: 0 } as never;
      },
      post: async (p, b) => {
        calls.push({ method: 'POST', path: p, body: b as Record<string, unknown> });
        if (++posts > failAfter) throw new Error('network down');
        const users = (b as { users: unknown[] }).users;
        // The second batch goes through the async path to exercise polling.
        return { id: `job_${posts}`, status: posts === 2 ? 'pending' : 'completed', total: users.length, succeeded: users.length, failed: 0 } as never;
      },
      put: async () => ({}) as never,
      patch: async () => ({}) as never,
      delete: async () => undefined,
    };
    return {
      io: captureIO(),
      env: {},
      config: new MemoryConfigStore({
        active_profile: 'default',
        profiles: { default: { api_url: 'https://api.atlas.test', secret_key: 'sk_test_123456' } },
      }),
      prompt: { text: async () => '', secret: async () => '' },
      makeClient: () => ({}) as ManagementClient,
      makeHttp: () => http,
      readFile: (p) => files[p] ?? fixture(p.split('/').pop()!),
      sleep: async () => undefined,
    };
  }

  it('--dry-run summarises and sends nothing; samples never show a hash', async () => {
    const calls: Call[] = [];
    const c = ctx(calls, {});
    const code = await run(['import', '--from', 'auth0', 'auth0-users.ndjson', '--hashes', 'auth0-hashes.ndjson', '--dry-run', '--json'], c);
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    const out = JSON.parse(c.io.stdout());
    expect(out.summary).toMatchObject({ users: 2, with_password_hash: 1, with_social_accounts: 1 });
    expect(c.io.stdout()).not.toContain('$2b$10$');
  });

  it('sends batches with upsert + options, polls a queued batch, and records progress', async () => {
    const calls: Call[] = [];
    const state = join(dir, 'state.json');
    const c = ctx(calls, {});
    const code = await run(
      ['import', '--from', 'firebase', 'firebase-users.json', '--hash-config', 'firebase-hash-config.json', '--batch-size', '1', '--state-file', state, '--create-orgs'],
      c,
    );
    expect(code).toBe(0);
    const posts = calls.filter((x) => x.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body).toMatchObject({
      upsert: true,
      create_organizations: true,
      password_hash_config: { firebase: { base64_signer_key: expect.any(String), rounds: 8 } },
    });
    expect(calls.some((x) => x.method === 'GET' && x.path === '/v1/jobs/job_2')).toBe(true);
    expect(JSON.parse(readFileSync(state, 'utf8'))).toMatchObject({ next_index: 2, total: 2, succeeded: 2 });
  });

  it('refuses a Firebase import without the hash parameters', async () => {
    const code = await run(['import', '--from', 'firebase', 'firebase-users.json'], ctx([], {}));
    expect(code).not.toBe(0);
  });

  it('resumes after the last finished batch', async () => {
    const state = join(dir, 'state.json');
    const first: Call[] = [];
    const failing = ctx(first, {}, 1);
    expect(await run(['import', '--from', 'clerk', 'clerk-users.csv', '--batch-size', '1', '--state-file', state], failing)).not.toBe(0);
    expect(JSON.parse(readFileSync(state, 'utf8')).next_index).toBe(1);

    const second: Call[] = [];
    expect(await run(['import', '--from', 'clerk', 'clerk-users.csv', '--batch-size', '1', '--state-file', state], ctx(second, {}))).toBe(0);
    const sent = second.filter((x) => x.method === 'POST').map((x) => (x.body!.users as Array<{ email_address: string }>)[0]!.email_address);
    expect(sent).toEqual(['grace@example.com']);
  });

  it('a state file from another export is refused', async () => {
    const state = join(dir, 'state.json');
    await run(['import', '--from', 'clerk', 'clerk-users.csv', '--state-file', state], ctx([], {}));
    expect(await run(['import', '--from', 'clerk', 'clerk-users.json', '--state-file', state], ctx([], {}))).not.toBe(0);
  });

  it('rejects an unknown vendor', async () => {
    const c = ctx([], {});
    expect(await run(['import', '--from', 'okta', 'x.json'], c)).not.toBe(0);
    expect(c.io.stderr()).toMatch(/--from <auth0\|clerk/);
  });
});

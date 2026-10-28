import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealBox } from '@atlasauth/backend';
import { run } from '../run';
import { defaultContext } from '../context';
import { FileConfigStore } from '../config';
import { createConfigHttp } from '../config-http';

/**
 * `atlas admin id-accounts …` / `atlas admin developer-accounts …`: the staff
 * credential is the operator sign-in exchanged for Atlas's own account with the
 * provision scope; passwords arrive sealed and land in 0600 files; a stale
 * second factor triggers one fresh operator sign-in and a retry.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PASSWORD = 'Zx9-correct-horse-battery-staple';

function memIO() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

const account = (over: Record<string, unknown> = {}) => ({
  object: 'atlas_id_provisioned_account',
  id: 'aipa_1',
  sub: 'user_1',
  email: 'qa@partner.test',
  label: 'Partner',
  team: 'Partner',
  kind: 'provisioned',
  app_ids: ['oac_1'],
  apps: [{ id: 'oac_1', client_id: 'client_1', name: 'Partner app' }],
  any_app: false,
  two_factor_exempt: false,
  expires_at: Date.now() + 30 * 86_400_000,
  expired: false,
  developer_account_id: null,
  last_sign_in_at: null,
  ...over,
});

interface Seen {
  method: string;
  url: string;
  body: unknown;
  auth: string | null;
  recipient: string | null;
}

function harness(opts: { stepUpOnce?: boolean; operator?: boolean; staffAccount?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-cli-admin-'));
  const config = new FileConfigStore(join(dir, 'config.json'));
  config.save({
    active_profile: 'default',
    profiles: {
      default: {
        api_url: 'https://api.test',
        secret_key: '',
        ...(opts.operator === false ? {} : { operator: { access_token: 'op-old', expires_at: Date.now() + 3_600_000, issuer: 'https://atlasauth.test' } }),
        ...(opts.staffAccount ? { staff_account_id: opts.staffAccount } : {}),
      },
    },
  });
  const seen: Seen[] = [];
  const exchanges: URLSearchParams[] = [];
  let stepUps = opts.stepUpOnce ? 1 : 0;
  let deviceLogins = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/operator')) {
      return json({
        issuer: 'https://atlasauth.test',
        device_authorization_endpoint: 'https://atlasauth.test/oauth2/device_authorization',
        token_endpoint: 'https://atlasauth.test/oauth2/token',
        client_id: 'atlas-cli',
        scope: 'openid atlas:operator',
        token_exchange_endpoint: 'https://api.test/v1/oauth/token',
        token_exchange_audience: 'atlas',
        root_action_max_mfa_age_seconds: 300,
      });
    }
    if (url.endsWith('/oauth2/device_authorization')) {
      deviceLogins += 1;
      return json({ device_code: 'dc', user_code: 'WXYZ-1234', verification_uri: 'https://atlasauth.test/oauth2/device', verification_uri_complete: 'https://atlasauth.test/oauth2/device?user_code=WXYZ-1234', expires_in: 600, interval: 1 });
    }
    if (url.endsWith('/oauth2/token')) return json({ access_token: 'op-fresh', token_type: 'Bearer', expires_in: 3600 });
    if (url.endsWith('/v1/oauth/token')) {
      const p = new URLSearchParams(String(init?.body));
      exchanges.push(p);
      return json({ access_token: `at_staff_${p.get('subject_token')}`, token_type: 'Bearer', expires_in: 3600, scope: p.get('scope'), resource: p.get('resource') });
    }
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const recipient = headers.get('x-secret-recipient');
    seen.push({ method, url, body, auth: headers.get('authorization'), recipient });
    const path = new URL(url).pathname;
    const sealed = (password: string) => {
      const pub = new Uint8Array(Buffer.from(recipient!.slice('x25519:'.length), 'base64'));
      return Buffer.from(sealBox(password, pub)).toString('base64');
    };
    if (method !== 'GET' && stepUps > 0) {
      stepUps -= 1;
      return json({ errors: [{ code: 'STEP_UP_REQUIRED', message: 'This action needs a multi-factor sign-in within the last 5 minutes.' }] }, 403);
    }
    if (method === 'GET' && path === '/v1/admin/atlas_id/provisioned_accounts') {
      return json({ object: 'list', data: [account()], has_more: false, teams: [{ team: 'Partner', count: 1, expired: 0, limit: 25 }], team_cap: 25 });
    }
    if (method === 'POST' && path === '/v1/admin/atlas_id/provisioned_accounts') {
      return json(account({ ...(body.any_app ? { any_app: true, app_ids: [], apps: [] } : {}), sealed_password: sealed(body.password ?? 'Generated-Password-123456') }), 201);
    }
    if (method === 'POST' && path.endsWith('/extend')) return json(account({ expires_at: Date.now() + 40 * 86_400_000 }));
    if (method === 'POST' && path.endsWith('/password')) return json(account({ sealed_password: sealed('Rotated-Password-1234567') }));
    if (method === 'DELETE') return json({ object: 'atlas_id_provisioned_account', id: 'aipa_1', deleted: true });
    if (method === 'GET' && path === '/v1/admin/atlas_id/provisioned_accounts/aipa_dev') return json(account({ id: 'aipa_dev', kind: 'developer', developer_account_id: 'acct_dev' }));
    if (method === 'GET' && path === '/v1/admin/atlas_id/provisioned_accounts/aipa_1') return json(account());
    if (method === 'POST' && path === '/v1/admin/atlas_id/developer_accounts') {
      return json(account({ id: 'aipa_dev', kind: 'developer', app_ids: [], apps: [], application: { id: 'app_dev', name: 'Partner test app' }, sealed_password: sealed('Dev-Password-123456789') }), 201);
    }
    return json({ errors: [{ code: 'NOT_FOUND', message: 'Not found.' }] }, 404);
  }) as unknown as typeof fetch;
  const m = memIO();
  const ctx = defaultContext({
    io: m.io,
    config,
    fetch: fetchImpl,
    sleep: async () => undefined,
    env: { XDG_CONFIG_HOME: dir },
    makeHttp: (o) => createConfigHttp({ ...o, fetch: fetchImpl }),
    readFile: (p: string) => {
      if (p === 'pw.txt') return `ATLAS_ID_TEST_PASSWORD=${PASSWORD}\n`;
      throw new Error('ENOENT');
    },
  });
  return { ctx, m, seen, exchanges, config, dir, deviceLogins: () => deviceLogins };
}

describe('atlas admin id-accounts', () => {
  it('exchanges the operator sign-in for Atlas’s own account with the provision scope, and remembers the account', async () => {
    const h = harness();
    expect(await run(['admin', 'id-accounts', 'list', '--staff-account', 'acct_atlas'], h.ctx)).toBe(0);
    expect(h.exchanges[0]!.get('subject_token')).toBe('op-old');
    expect(h.exchanges[0]!.get('resource')).toBe('acct_atlas');
    expect(h.exchanges[0]!.get('scope')).toBe('platform:atlas_id_apps:provision');
    expect(h.seen[0]!.auth).toBe('Bearer at_staff_op-old');
    expect(h.m.out.join('\n')).toContain('qa@partner.test');
    expect(h.m.out.join('\n')).toContain('Partner: 1 of 25');
    expect(h.config.load().profiles.default!.staff_account_id).toBe('acct_atlas');
    // Next time the stored account is used.
    const again = harness({ staffAccount: 'acct_atlas' });
    expect(await run(['admin', 'id-accounts', 'list', '--team', 'Partner', '--json'], again.ctx)).toBe(0);
    expect(again.seen[0]!.url).toContain('team=Partner');
  });

  it('refuses without an operator sign-in or a staff account', async () => {
    const noOp = harness({ operator: false, staffAccount: 'acct_atlas' });
    expect(await run(['admin', 'id-accounts', 'list'], noOp.ctx)).not.toBe(0);
    expect(noOp.m.err.join('\n')).toContain("atlas login --device");
    const noAccount = harness();
    expect(await run(['admin', 'id-accounts', 'list'], noAccount.ctx)).not.toBe(0);
    expect(noAccount.m.err.join('\n')).toContain('--staff-account');
  });

  it('provisions for named apps: the password arrives sealed and goes to a 0600 file, never stdout', async () => {
    const h = harness({ staffAccount: 'acct_atlas' });
    const code = await run(
      ['admin', 'id-accounts', 'provision', '--email', 'qa@partner.test', '--team', 'Partner', '--app', 'oac_1,oac_2', '--days', '14', '--password-file', 'pw.txt'],
      h.ctx,
    );
    expect(code, h.m.err.join('\n')).toBe(0);
    const post = h.seen.find((s) => s.method === 'POST')!;
    expect(post.body).toMatchObject({ email: 'qa@partner.test', team: 'Partner', app_ids: ['oac_1', 'oac_2'], days: 14, password: PASSWORD, email_verified: true });
    expect(post.recipient).toMatch(/^x25519:/);
    const file = join(h.dir, 'atlasauth', 'staff-account-aipa_1.env');
    expect(readFileSync(file, 'utf8')).toContain(`ATLAS_ID_TEST_PASSWORD=${PASSWORD}`);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(h.m.out.join('\n')).not.toContain(PASSWORD);
  });

  it('provisions an any-app account, and validates the app choice', async () => {
    const h = harness({ staffAccount: 'acct_atlas' });
    expect(await run(['admin', 'id-accounts', 'provision', '--email', 'qa@partner.test', '--team', 'Partner', '--any-app', '--json'], h.ctx)).toBe(0);
    expect(h.seen.find((s) => s.method === 'POST')!.body).toMatchObject({ any_app: true });
    const printed = JSON.parse(h.m.out.join('\n'));
    expect(printed.sealed_password).toBeUndefined();
    expect(printed.secret_file).toContain('staff-account-aipa_1.env');
    const bad = harness({ staffAccount: 'acct_atlas' });
    expect(await run(['admin', 'id-accounts', 'provision', '--email', 'a@b.test', '--team', 'T'], bad.ctx)).not.toBe(0);
    expect(await run(['admin', 'id-accounts', 'provision', '--email', 'a@b.test', '--team', 'T', '--any-app', '--two-factor-exempt'], bad.ctx)).not.toBe(0);
    expect(bad.seen.filter((s) => s.method === 'POST')).toHaveLength(0);
  });

  it('extend, rotate and revoke hit the staff routes', async () => {
    const h = harness({ staffAccount: 'acct_atlas' });
    expect(await run(['admin', 'id-accounts', 'extend', 'aipa_1', '--days', '10'], h.ctx)).toBe(0);
    expect(await run(['admin', 'id-accounts', 'rotate', 'aipa_1'], h.ctx)).toBe(0);
    expect(await run(['admin', 'id-accounts', 'revoke', 'aipa_1'], h.ctx)).toBe(0);
    expect(h.seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      'POST /v1/admin/atlas_id/provisioned_accounts/aipa_1/extend',
      'POST /v1/admin/atlas_id/provisioned_accounts/aipa_1/password',
      'DELETE /v1/admin/atlas_id/provisioned_accounts/aipa_1',
    ]);
    expect(h.seen[0]!.body).toEqual({ days: 10 });
    expect(readFileSync(join(h.dir, 'atlasauth', 'staff-account-aipa_1.env'), 'utf8')).toContain('Rotated-Password-1234567');
    expect(h.m.out.join('\n')).not.toContain('Rotated-Password-1234567');
  });

  it('on STEP_UP_REQUIRED runs the operator sign-in again and retries once', async () => {
    const h = harness({ stepUpOnce: true, staffAccount: 'acct_atlas' });
    expect(await run(['admin', 'id-accounts', 'revoke', 'aipa_1'], h.ctx)).toBe(0);
    expect(h.deviceLogins()).toBe(1);
    expect(h.m.err.join('\n')).toContain('WXYZ-1234');
    const deletes = h.seen.filter((s) => s.method === 'DELETE');
    expect(deletes.map((d) => d.auth)).toEqual(['Bearer at_staff_op-old', 'Bearer at_staff_op-fresh']);
    expect(h.config.load().profiles.default!.operator!.access_token).toBe('op-fresh');
  });

  it('--no-step-up fails instead of signing in again', async () => {
    const h = harness({ stepUpOnce: true, staffAccount: 'acct_atlas' });
    expect(await run(['admin', 'id-accounts', 'revoke', 'aipa_1', '--no-step-up'], h.ctx)).not.toBe(0);
    expect(h.deviceLogins()).toBe(0);
    expect(h.m.err.join('\n')).toContain('second factor');
  });
});

describe('atlas admin developer-accounts', () => {
  it('provisions a developer account (password to a 0600 file) and revokes only developer accounts', async () => {
    const h = harness({ staffAccount: 'acct_atlas' });
    expect(await run(['admin', 'developer-accounts', 'provision', '--email', 'dev@partner.test', '--team', 'Partner', '--account-name', 'Partner (test)'], h.ctx)).toBe(0);
    expect(h.seen[0]!.body).toMatchObject({ email: 'dev@partner.test', team: 'Partner', account_name: 'Partner (test)' });
    expect(readFileSync(join(h.dir, 'atlasauth', 'staff-account-aipa_dev.env'), 'utf8')).toContain('Dev-Password-123456789');
    expect(h.m.out.join('\n')).toContain('Partner test app');

    expect(await run(['admin', 'developer-accounts', 'revoke', 'aipa_dev'], h.ctx)).toBe(0);
    expect(h.seen.some((s) => s.method === 'DELETE' && s.url.endsWith('/aipa_dev'))).toBe(true);
    // An id-account is not revoked through the developer group.
    expect(await run(['admin', 'developer-accounts', 'revoke', 'aipa_1'], h.ctx)).not.toBe(0);
    expect(h.seen.some((s) => s.method === 'DELETE' && s.url.endsWith('/aipa_1'))).toBe(false);
  });

  it('rejects an unknown group', async () => {
    const h = harness({ staffAccount: 'acct_atlas' });
    expect(await run(['admin', 'whatever'], h.ctx)).not.toBe(0);
  });
});

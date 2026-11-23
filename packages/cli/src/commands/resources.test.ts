import { describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';
import * as R from './resources';

type Call = { method: string; path: string; body?: unknown };

function ctx(calls: Call[], answers: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  const send = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return (answers[`${method} ${path}`] ?? {}) as never;
  };
  const http: ConfigHttp = {
    get: (p) => send('GET', p),
    post: (p, b) => send('POST', p, b),
    put: (p, b) => send('PUT', p, b),
    patch: (p, b) => send('PATCH', p, b),
    delete: async (p, b) => {
      await send('DELETE', p, b);
    },
  };
  const io = captureIO();
  const c: RunContext = {
    io,
    env: {},
    config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: () => http,
    readFile: (p) => files[p] ?? '',
  };
  return { c, io };
}

describe('resource commands', () => {
  it('invokes a workflow with a JSON body and encodes ids', async () => {
    const calls: Call[] = [];
    const { c } = ctx(calls);
    expect(await run(['workflows', 'run', 'wf/1', '--data', '{"input":{"a":1}}'], c)).toBe(0);
    expect(calls).toEqual([{ method: 'POST', path: '/v1/workflows/wf%2F1/invoke', body: { input: { a: 1 } } }]);
  });

  it('resumes a run using two ids', async () => {
    const calls: Call[] = [];
    const { c } = ctx(calls);
    await run(['workflows', 'resume', 'wf_1', 'run_2'], c);
    expect(calls[0]!.path).toBe('/v1/workflows/wf_1/runs/run_2/resume');
  });

  it('refuses a missing id and a non-object body', async () => {
    const calls: Call[] = [];
    const a = ctx(calls);
    expect(await run(['workflows', 'resume', 'wf_1'], a.c)).toBe(1);
    expect(a.io.stderr()).toContain('needs 2 id');
    const b = ctx(calls);
    expect(await run(['workflows', 'run', 'wf_1', '--data', '[1]'], b.c)).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('fails closed on destructive ops without --yes', async () => {
    const calls: Call[] = [];
    const a = ctx(calls);
    expect(await run(['device-sso', 'revoke', 'dsr_1'], a.c)).toBe(1);
    expect(calls).toHaveLength(0);
    expect(await run(['device-sso', 'revoke', 'dsr_1', '--yes'], a.c)).toBe(0);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/device_sso/registrations/dsr_1/revoke' });
  });

  it('prints a launch URL only when it is https', async () => {
    const calls: Call[] = [];
    const ok = ctx(calls, { 'GET /v1/cloud_access/targets/t1': { launch_url: 'https://idp.test/launch/t1' } });
    expect(await run(['cloud', 'login', 't1'], ok.c)).toBe(0);
    expect(ok.io.stdout()).toContain('https://idp.test/launch/t1');
    const bad = ctx(calls, { 'GET /v1/cloud_access/targets/t1': { launch_url: 'javascript:alert(1)' } });
    expect(await run(['cloud', 'login', 't1'], bad.c)).toBe(1);
  });

  it('renders a list as a table', async () => {
    const { c, io } = ctx([], { 'GET /v1/mcp_gateways': { data: [{ id: 'gw_1', name: 'Main' }] } });
    await run(['mcp', 'gateways'], c);
    expect(io.stdout()).toContain('gw_1');
  });

  it('routes keys data / keys op and users merge', async () => {
    const calls: Call[] = [];
    const { c } = ctx(calls);
    await run(['keys', 'data', 'status'], c);
    await run(['keys', 'op', 'rotate', '--data', '{"alg":"ES384"}', '--yes'], c);
    await run(['users', 'merge', 'user_a', 'user_b', '--dry-run'], c);
    expect(calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /v1/instance/data_key_provider',
      'POST /v1/instance/op_keys/rotate',
      'POST /v1/users/user_b/merge',
    ]);
    expect(calls[2]!.body).toEqual({ source_user_id: 'user_a', dry_run: true });
  });

  it('refuses a real merge without --yes', async () => {
    const calls: Call[] = [];
    const { c } = ctx(calls);
    expect(await run(['users', 'merge', 'a', 'b'], c)).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('maps the SAML, provisioning and catalog commands to their routes', async () => {
    const calls: Call[] = [];
    const a = ctx(calls);
    expect(await run(['saml-idp', 'import-metadata', '--data', '{"url":"https://idp.test/m"}'], a.c)).toBe(1);
    expect(await run(['saml-idp', 'import-metadata', '--data', '{"url":"https://idp.test/m"}', '--yes'], a.c)).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/saml_idp/service_providers/import_metadata' });
    expect(await run(['provisioning', 'failures', 'tgt_1'], a.c)).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: '/v1/scim_provisioning_targets/tgt_1/failures' });
    expect(await run(['provisioning', 'retry', 'tgt_1'], a.c)).toBe(1);
    expect(await run(['catalog', 'vote', 'req_1'], a.c)).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/app_catalog/requests/req_1/vote' });
    expect(await run(['catalog', 'requests'], a.c)).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: '/v1/app_catalog/requests' });
  });

  it('shreds the data key only when the typed instance id matches', async () => {
    const calls: Call[] = [];
    const a = ctx(calls, { 'GET /v1/instance': { id: 'ins_1' } });
    expect(await run(['keys', 'data', 'shred', '--confirm', 'ins_2'], a.c)).toBe(1);
    expect(await run(['keys', 'data', 'shred'], a.c)).toBe(1);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(await run(['keys', 'data', 'shred', '--confirm', 'ins_1'], a.c)).toBe(0);
    expect(calls.at(-1)).toEqual({ method: 'DELETE', path: '/v1/instance/data_key_provider', body: { confirm: 'shred' } });
  });
});

describe('surface resource commands', () => {
  // [argv, method, path, body]
  const cases: Array<[string[], string, string, unknown?]> = [
    [['compliance', 'downstream-run', 'dsr_1', 'con_1', '--yes'], 'POST', '/v1/data_subject_requests/dsr_1/downstream/con_1/run', {}],
    [['compliance', 'erasure-probe', 'con_1'], 'POST', '/v1/erasure_connectors/con_1/probe'],
    [['compliance', 'cookie-consents'], 'GET', '/v1/cookie_consents'],
    [['compliance', 'cookie-subject', 'sub 1'], 'GET', '/v1/cookie_consents/subjects/sub%201'],
    [['compliance', 'cookie-subject-erase', 'sub_1', '--yes'], 'DELETE', '/v1/cookie_consents/subjects/sub_1'],
    [['compliance', 'cookie-user-erase', 'user_1', '--yes'], 'DELETE', '/v1/users/user_1/cookie_consents'],
    [['compliance', 'i18n-reviews', 'loc_1'], 'GET', '/v1/localizations/loc_1/reviews'],
    [['connection-actions', 'types'], 'GET', '/v1/connection_actions/types'],
    [['connection-actions', 'rules', 'con_1'], 'GET', '/v1/connections/con_1/access_rules'],
    [['connection-actions', 'rules-set', 'con_1', '--yes', '--data', '{"rules":[]}'], 'PUT', '/v1/connections/con_1/access_rules', { rules: [] }],
    [['connection-actions', 'rules-clear', 'con_1', '--yes'], 'DELETE', '/v1/connections/con_1/access_rules'],
    [['connection-actions', 'register-client', '--data', '{"provider":"x"}'], 'POST', '/v1/connections/oauth_clients/register', { provider: 'x' }],
    [['billing', 'connect-accounts'], 'GET', '/v1/billing/connect/accounts'],
    [['billing', 'connect-account', 'acct_1'], 'GET', '/v1/billing/connect/accounts/acct_1'],
    [['billing', 'connect-account-create', '--yes', '--data', '{"country":"US"}'], 'POST', '/v1/billing/connect/accounts', { country: 'US' }],
    [['billing', 'connect-onboarding-link', 'acct_1'], 'POST', '/v1/billing/connect/accounts/acct_1/onboarding_link', {}],
    [['billing', 'connect-refresh', 'acct_1'], 'POST', '/v1/billing/connect/accounts/acct_1/refresh', {}],
    [['billing', 'connect-transfers'], 'GET', '/v1/billing/connect/transfers'],
    [['billing', 'connect-transfer', 'tr_1'], 'GET', '/v1/billing/connect/transfers/tr_1'],
    [['billing', 'connect-transfer-create', '--yes', '--data', '{"amount":5}'], 'POST', '/v1/billing/connect/transfers', { amount: 5 }],
    [['billing', 'store-link', '--yes', '--data', '{"store":"app_store"}'], 'POST', '/v1/billing/store_links', { store: 'app_store' }],
    [['audit', 'chain-verify'], 'POST', '/v1/audit/chain/verify', {}],
    [['provider-changes', 'list'], 'GET', '/v1/connection_provider_changes'],
    [['provider-changes', 'get', 'pc_1'], 'GET', '/v1/connection_provider_changes/pc_1'],
    [['provider-changes', 'acknowledge', 'pc_1', '--yes'], 'POST', '/v1/connection_provider_changes/pc_1/acknowledge', {}],
    [['provider-changes', 'resolve', 'pc_1', '--yes'], 'POST', '/v1/connection_provider_changes/pc_1/resolve', {}],
    [['flows', 'messages', 'flow_1'], 'GET', '/v1/flows/flow_1/messages'],
    [['flows', 'message-cancel', 'flow_1', 'msg_1', '--yes'], 'POST', '/v1/flows/flow_1/messages/msg_1/cancel', {}],
    [['flows', 'readout', 'flow_1', 'exp_1'], 'GET', '/v1/flows/flow_1/experiments/exp_1/readout'],
    [['referral-rewards', 'list'], 'GET', '/v1/referral_rewards'],
    [['referral-rewards', 'get', 'rw_1'], 'GET', '/v1/referral_rewards/rw_1'],
    [['referral-rewards', 'void', 'rw_1', '--yes'], 'POST', '/v1/referral_rewards/rw_1/void', {}],
    [['referral-rewards', 'run', '--yes', '--data', '{"dry_run":true}'], 'POST', '/v1/referral_rewards/run', { dry_run: true }],
    [['policies', 'audience', 'pol_1'], 'GET', '/v1/policies/pol_1/audience'],
    [['policies', 'set-audience', 'pol_1', '--yes', '--data', '{"audience":"everyone"}'], 'PUT', '/v1/policies/pol_1/audience', { audience: 'everyone' }],
    [['policies', 'translations', 'pol_1', 'v_1'], 'GET', '/v1/policies/pol_1/versions/v_1/translations'],
    [['policies', 'translation-set', 'pol_1', 'v_1', 'fr', '--yes', '--data', '{"title":"Conditions"}'], 'PUT', '/v1/policies/pol_1/versions/v_1/translations/fr', { title: 'Conditions' }],
    [['policies', 'translation-delete', 'pol_1', 'v_1', 'fr', '--yes'], 'DELETE', '/v1/policies/pol_1/versions/v_1/translations/fr'],
    [['region', 'show'], 'GET', '/v1/region'],
    [['region', 'set', '--yes', '--failover-region', 'eu', '--fapi-isolation', 'enforce'], 'PUT', '/v1/region', { failover_region: 'eu', fapi_isolation: 'enforce' }],
    [['region', 'pin', '--yes'], 'PUT', '/v1/region', { pin: true }],
    [['region', 'failover'], 'GET', '/v1/region/failover'],
    [['oauth-publishers', 'verify', 'opub_1'], 'POST', '/v1/oauth_publishers/opub_1/verify', {}],
    [['oauth-publishers', 'attach', 'opub_1', 'app_1', '--data', '{"allow_subject_change":true}'], 'PUT', '/v1/oauth_publishers/opub_1/clients/app_1', { allow_subject_change: true }],
    [['oauth-publishers', 'detach', 'opub_1', 'app_1', '--yes'], 'DELETE', '/v1/oauth_publishers/opub_1/clients/app_1'],
    [['age-assurance', 'list', 'user_1'], 'GET', '/v1/users/user_1/age_assurance'],
    [['age-assurance', 'record', 'user_1', '--yes', '--data', '{"method":"document"}'], 'POST', '/v1/users/user_1/age_assurance', { method: 'document' }],
    [['age-assurance', 'revoke', 'user_1', 'aa_1', '--yes'], 'POST', '/v1/users/user_1/age_assurance/aa_1/revoke', {}],
    [['approval-devices', 'list', 'user_1'], 'GET', '/v1/users/user_1/approval_devices'],
    [['approval-devices', 'trust', 'user_1', '--yes', '--data', '{"device_id":"d"}'], 'POST', '/v1/users/user_1/approval_devices/trust', { device_id: 'd' }],
    [['approval-devices', 'remove', 'user_1', 'dev_1', '--yes'], 'DELETE', '/v1/users/user_1/approval_devices/dev_1'],
  ];
  it.each(cases)('%j', async (argv, method, path, body) => {
    const calls: Call[] = [];
    const { c } = ctx(calls);
    expect(await run(argv, c)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe(method);
    expect(calls[0]!.path).toBe(path);
    if (body !== undefined) expect(calls[0]!.body).toEqual(body);
  });

  it('refuses a destructive subcommand without --yes and sends nothing', async () => {
    for (const argv of [['region', 'pin'], ['approval-devices', 'remove', 'u', 'd'], ['policies', 'translation-delete', 'p', 'v', 'fr'], ['connection-actions', 'rules-clear', 'c']]) {
      const calls: Call[] = [];
      const { c, io } = ctx(calls);
      expect(await run(argv, c)).toBe(1);
      expect(io.stderr()).toContain('--yes');
      expect(calls).toHaveLength(0);
    }
  });
});

describe('every op of the newer tables sends its route', () => {
  const tables: Record<string, [string, R.Ops]> = {
    pca: ['pca', R.PCA], 'pca-registry': ['pca-registry', R.PCA_REGISTRY], 'pca-grants': ['pca-grants', R.PCA_GRANTS], 'pca-approvers': ['pca-approvers', R.PCA_APPROVERS], 'pca-undo': ['pca-undo', R.PCA_UNDO],
    ssf: ['ssf', R.SSF], 'staging-copies': ['staging-copies', R.STAGING_COPIES], 'platform-apps': ['platform-apps', R.PLATFORM_APPS], 'oauth-device': ['oauth-device', R.OAUTH_DEVICE],
    analytics: ['analytics', R.ANALYTICS], machines: ['machines', R.MACHINES], 'webhook-dlq': ['webhook-dlq', R.WEBHOOK_DLQ], 'org-invitations': ['org-invitations', R.ORG_INVITATIONS],
    'message-links': ['message-links', R.MESSAGE_LINKS], permissions: ['permissions', R.PERMISSIONS], 'migration-sessions': ['migration-sessions', R.MIGRATION_SESSIONS],
    users: ['users', R.USER_SECURITY], sessions: ['sessions', R.SESSIONS_MORE],
    'api-keys': ['api-keys', R.API_KEYS_MORE], changes: ['changes', R.CHANGES_MORE], connections: ['connections', R.CONNECTIONS_MORE], grants: ['grants', R.GRANTS_MORE], messages: ['messages', R.MESSAGES_MORE], orgs: ['orgs', R.ORGS_MORE],
    billing: ['billing', R.BILLING], compliance: ['compliance', R.COMPLIANCE], flows: ['flows', R.FLOWS], agents: ['agents', R.AGENTS], machinesMore: ['machines', R.MACHINES], platformMore: ['platform-apps', R.PLATFORM_APPS],
    authz: ['authz', R.AUTHZ], 'atlas-id-apps': ['atlas-id-apps', R.ATLAS_ID_APPS], 'rate-limits': ['rate-limits', R.RATE_LIMITS], 'risk-signals': ['risk-signals', R.RISK_SIGNALS], suppressions: ['suppressions', R.SUPPRESSIONS], 'web-bot-auth': ['web-bot-auth', R.WEB_BOT_AUTH],
    'abuse-signals': ['abuse-signals', R.ABUSE_SIGNALS], 'approval-requests': ['approval-requests', R.APPROVAL_REQUESTS], entitlements: ['entitlements', R.ENTITLEMENTS], 'fga-sync': ['fga-sync', R.FGA_SYNC], impersonations: ['impersonations', R.IMPERSONATIONS], instance: ['instance', R.INSTANCE],
    'legal-holds': ['legal-holds', R.LEGAL_HOLDS], 'mfa-campaigns': ['mfa-campaigns', R.MFA_CAMPAIGNS], 'machine-trust-policies': ['machine-trust-policies', R.MACHINE_TRUST_POLICIES], 'org-templates': ['org-templates', R.ORG_TEMPLATES], 'risk-based-mfa': ['risk-based-mfa', R.RISK_BASED_MFA],
    'scim-tokens': ['scim-tokens', R.SCIM_TOKENS], 'sso-connections': ['sso-connections', R.SSO_CONNECTIONS], 'step-up': ['step-up', R.STEP_UP], 'messaging-providers': ['messaging-providers', R.MESSAGING_PROVIDERS], 'resource-role-assignments': ['resource-role-assignments', R.RESOURCE_ROLE_ASSIGNMENTS], 'resource-servers': ['resource-servers', R.RESOURCE_SERVERS],
  };
  const rows = Object.values(tables).flatMap(([cmd, ops]) => Object.entries(ops).map(([sub, op]) => [cmd, sub, op] as const));
  it.each(rows)('%s %s', async (cmd, sub, op) => {
    const calls: Call[] = [];
    const { c } = ctx(calls, { 'POST /v1/localizations/check': { ok: true, checked: 1 } });
    const need = (op.p.match(/\{\}/g) ?? []).length;
    const ids = Array.from({ length: need }, (_, i) => `id${i + 1}`);
    expect(await run([cmd, sub, ...ids, '--yes', ...(op.f?.includes('b') ? ['--data', '{"a":1}'] : [])], c)).toBe(0);
    let n = 0;
    expect(calls).toEqual([{ method: op.m, path: op.p.replace(/\{\}/g, () => ids[n++]!), ...(op.f?.includes('b') ? { body: { a: 1 } } : op.m === 'GET' || op.m === 'DELETE' ? {} : { body: {} }) }]);
  });

  it('maps a renamed query flag and a repeatable list flag', async () => {
    const calls: Call[] = [];
    const { c } = ctx(calls);
    await run(['pca-grants', 'list', '--principal', 'p1', '--starting-after', 'c9', '--limit', '5'], c);
    expect(calls[0]!.path).toBe('/v1/pca/grants?limit=5&principal=p1&cursor=c9');
  });
});


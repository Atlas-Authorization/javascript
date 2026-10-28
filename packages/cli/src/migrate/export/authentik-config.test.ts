import { describe, expect, it } from 'vitest';
import { AUTHENTIK_CONFIG_ENDPOINTS, fetchAuthentikConfig, snapshotFromBlueprint, timedeltaMs, translateAuthentikConfig } from './authentik-config';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';

/** A blueprint as `ak export_blueprint` and the authentik docs write them (tags included). */
const BLUEPRINT = `version: 1
metadata:
  name: acme-auth
entries:
  - model: authentik_policies_password.passwordpolicy
    identifiers:
      name: acme-password-policy
    attrs:
      length_min: 12
      amount_digits: 1
      amount_uppercase: 1
      amount_lowercase: 1
      amount_symbols: 1
      check_have_i_been_pwned: true
      check_zxcvbn: true
  - model: authentik_stages_user_login.userloginstage
    identifiers:
      name: acme-login
    attrs:
      session_duration: hours=8
      terminate_other_sessions: true
  - model: authentik_flows.flow
    identifiers:
      slug: acme-enrollment
    attrs:
      name: Enrollment
      designation: enrollment
  - model: authentik_flows.flow
    identifiers:
      slug: acme-authentication
    attrs:
      name: Sign in
      designation: authentication
  - model: authentik_stages_authenticator_totp.authenticatortotpstage
    identifiers:
      name: acme-totp
    attrs:
      digits: 6
  - model: authentik_stages_authenticator_validate.authenticatorvalidatestage
    identifiers:
      name: acme-validate
    attrs:
      not_configured_action: skip
  - model: authentik_stages_identification.identificationstage
    identifiers:
      name: acme-identification
    attrs:
      user_fields: [email, username]
      passwordless_flow: !Find [authentik_flows.flow, [slug, acme-passwordless]]
  - model: authentik_sources_oauth.oauthsource
    identifiers:
      slug: github
    attrs:
      name: GitHub
      provider_type: github
      consumer_key: !Env GITHUB_CLIENT_ID
      consumer_secret: !Env GITHUB_CLIENT_SECRET
      enabled: true
  - model: authentik_sources_oauth.oauthsource
    identifiers:
      slug: corp-keycloak
    attrs:
      name: Corp Keycloak
      provider_type: openidconnect
      consumer_key: authentik
      oidc_well_known_url: https://sso.corp.example/realms/main/.well-known/openid-configuration
  - model: authentik_sources_saml.samlsource
    identifiers:
      slug: partner-saml
    attrs:
      name: Partner
  - model: authentik_providers_oauth2.oauth2provider
    identifiers:
      name: grafana-provider
    attrs:
      client_id: grafana
      sub_mode: hashed_user_id
      redirect_uris:
        - matching_mode: strict
          url: https://grafana.example.com/login/generic_oauth
        - matching_mode: regex
          url: https://.*\\.example\\.com/cb
      signing_key: null
  - model: authentik_core.application
    identifiers:
      slug: grafana
    attrs:
      name: Grafana
      provider: !KeyOf grafana-provider
`;

const lineOf = (needle: string) => BLUEPRINT.split('\n').findIndex((l) => l.includes(needle)) + 1;

describe('timedeltaMs', () => {
  it('reads authentik timedelta strings', () => {
    expect(timedeltaMs('hours=8')).toBe(28_800_000);
    expect(timedeltaMs('days=1,hours=2')).toBe(93_600_000);
    expect(timedeltaMs('seconds=0')).toBe(0);
    expect(timedeltaMs('minutes=30; seconds=15')).toBe(1_815_000);
    expect(timedeltaMs('soon')).toBeUndefined();
    expect(timedeltaMs(undefined)).toBeUndefined();
  });
});

describe('translateAuthentikConfig (blueprint)', () => {
  const snap = snapshotFromBlueprint(BLUEPRINT, 'blueprints/acme.yaml', 'https://auth.example.com');
  const out = translateAuthentikConfig(snap);
  const auth = (out.documents.instance as { auth_config: Record<string, unknown> }).auth_config;
  const line = (area: string, setting: RegExp) => out.report.find((r) => r.area === area && setting.test(r.setting));

  it('reads every entry with its line', () => {
    expect(snap.entries).toHaveLength(12);
    expect(snap.origin).toBe('authentik blueprint blueprints/acme.yaml');
    expect(line('passwords', /passwordpolicy acme-password-policy\.length_min/)).toMatchObject({ status: 'mapped', file: 'blueprints/acme.yaml', line: lineOf('passwordpolicy') });
  });

  it('translates the password policy and flags what has no Atlas setting', () => {
    expect(auth.passwordPolicy).toEqual({ minLength: 12, requireNumber: true, requireUppercase: true, requireLowercase: true, requireSymbol: true });
    expect(line('passwords', /check_have_i_been_pwned/)?.status).toBe('manual');
    expect(line('passwords', /check_zxcvbn/)?.status).toBe('differs');
  });

  it('translates sessions, sign-up and passkeys', () => {
    expect(auth.session).toEqual({ absoluteMs: 28_800_000 });
    expect(line('sessions', /terminate_other_sessions/)?.status).toBe('manual');
    expect(auth.signUpMode).toBe('public');
    expect((auth.strategies as Record<string, unknown>).passkey).toBe(true);
  });

  it('translates second factors', () => {
    expect((auth.mfa as { factors: Record<string, unknown> }).factors).toEqual({ totp: true });
    expect(line('multi-factor', /not_configured_action/)?.note).toMatch(/skipped the check/);
  });

  it('maps a social source to a built-in provider with placeholders, never copying a tagged id or secret', () => {
    const github = (out.documents.oauth_providers as Array<Record<string, unknown>>).find((p) => p.provider === 'github')!;
    expect(github).toMatchObject({ client_id: '${GITHUB_CLIENT_ID}', client_secret: '${GITHUB_CLIENT_SECRET}', enabled: true });
    expect(out.env.map((e) => e.name)).toEqual(expect.arrayContaining(['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'CORP_KEYCLOAK_CLIENT_SECRET']));
    expect(out.mappings.providers).toMatchObject({ github: 'github', 'corp-keycloak': 'corp_keycloak' });
    expect(line('secrets', /consumer_secret/)?.note).toContain('GITHUB_CLIENT_SECRET');
    expect(JSON.stringify(out.documents)).not.toContain('@env');
  });

  it('turns an OIDC source into a custom provider with its discovery URL', () => {
    const custom = (out.documents.custom_oauth_providers as Array<Record<string, unknown>>)[0]!;
    expect(custom).toMatchObject({
      provider_key: 'corp_keycloak',
      protocol: 'oidc',
      client_id: 'authentik',
      client_secret: '${CORP_KEYCLOAK_CLIENT_SECRET}',
      discovery_url: 'https://sso.corp.example/realms/main/.well-known/openid-configuration',
    });
  });

  it('sends SAML sources to the data export and applications to the app', () => {
    expect(line('sources', /samlsource partner-saml/)?.atlas).toBe('sso_connections');
    expect(line('applications', /application grafana/)?.status).toBe('manual');
  });

  it('keeps exact redirect URIs, reports regex ones, and warns that an unsigned provider cannot be bridged', () => {
    expect(out.documents.redirect_urls).toEqual([{ url: 'https://grafana.example.com/login/generic_oauth' }]);
    expect(line('providers', /redirect_uris/)).toMatchObject({ status: 'differs' });
    expect(line('providers', /signing_key/)).toMatchObject({ status: 'manual' });
  });

  it('hands the bridge and lazy steps what it learned', () => {
    expect(out.bridge).toEqual({ preset: 'authentik', vars: { issuer: 'https://auth.example.com/application/o/grafana', client_id: 'grafana' } });
    expect(out.lazy).toEqual({ preset: 'authentik', config: { base_url: 'https://auth.example.com', flow_slug: 'acme-authentication', sub_mode: 'hashed_user_id' } });
  });

  it('leaves the bridge out without a URL, and reports several providers', () => {
    expect(translateAuthentikConfig(snapshotFromBlueprint(BLUEPRINT, 'a.yaml')).bridge).toBeUndefined();
    const two = BLUEPRINT.replace('  - model: authentik_core.application', '  - model: authentik_providers_oauth2.oauth2provider\n    identifiers:\n      name: other\n    attrs:\n      client_id: other\n  - model: authentik_core.application');
    const r = translateAuthentikConfig(snapshotFromBlueprint(two, 'a.yaml', 'https://auth.example.com'));
    expect(r.bridge).toBeUndefined();
    expect(r.report.some((x) => x.area === 'bridge' && /2 OAuth2 providers/.test(x.note))).toBe(true);
  });

  it('reports a second password policy instead of merging it, and does not close sign-up from a partial blueprint', () => {
    const extra = `${BLUEPRINT}  - model: authentik_policies_password.passwordpolicy\n    identifiers:\n      name: second\n    attrs:\n      length_min: 20\n`;
    const r = translateAuthentikConfig(snapshotFromBlueprint(extra, 'a.yaml'));
    expect(r.report.some((x) => x.status === 'differs' && /only the first/.test(x.note))).toBe(true);
    const bare = translateAuthentikConfig(snapshotFromBlueprint('version: 1\nentries: []\n', 'b.yaml'));
    expect(bare.documents.instance).toBeUndefined();
  });

  it('rejects a malformed blueprint with the line', () => {
    expect(() => snapshotFromBlueprint('entries:\n  - model: x\n   bad: indentation\n', 'c.yaml')).toThrow(/line/i);
  });
});

describe('fetchAuthentikConfig (API)', () => {
  const BASE = 'https://auth.example.com';
  const page = (results: unknown[]) => ({ pagination: { next: 0 }, results });
  const all = Object.fromEntries(AUTHENTIK_CONFIG_ENDPOINTS.map(([path]) => [`GET /api/v3${path}`, page([])]));

  it('lists the objects and translates them (complete read: no enrollment flow closes sign-up)', async () => {
    const v = fakeVendor(BASE, {
      ...all,
      'GET /api/v3/flows/instances/': page([{ pk: 'f1', slug: 'default-authentication-flow', designation: 'authentication' }]),
      'GET /api/v3/providers/oauth2/': page([{ pk: 3, name: 'app-provider', client_id: 'cid', sub_mode: 'user_username', signing_key: 'kp1', redirect_uris: [{ matching_mode: 'strict', url: 'https://app.example.com/cb' }] }]),
      'GET /api/v3/core/applications/': page([{ pk: 'a1', slug: 'app', name: 'App', provider: 3 }]),
    });
    const snap = await fetchAuthentikConfig({ baseUrl: `${BASE}/`, token: 'tok', fetchImpl: v.fetchImpl, sleep: noSleep });
    expect(snap).toMatchObject({ origin: 'authentik auth.example.com', baseUrl: BASE, complete: true });
    expect(v.calls.every((c) => c.headers.get('authorization') === 'Bearer tok' && !c.url.includes('tok'))).toBe(true);
    const out = translateAuthentikConfig(snap);
    expect((out.documents.instance as { auth_config: { signUpMode: string } }).auth_config.signUpMode).toBe('restricted');
    expect(out.documents.redirect_urls).toEqual([{ url: 'https://app.example.com/cb' }]);
    expect(out.bridge).toEqual({ preset: 'authentik', vars: { issuer: `${BASE}/application/o/app`, client_id: 'cid' } });
    expect(out.lazy?.config).toEqual({ base_url: BASE, flow_slug: 'default-authentication-flow', sub_mode: 'user_username' });
    expect(out.report.some((r) => r.status === 'manual' && r.area === 'providers')).toBe(false);
  });

  it('skips object types the token cannot read and does not then claim sign-up is closed', async () => {
    const v = fakeVendor(BASE, { 'GET /api/v3/policies/password/': page([{ pk: 'p', name: 'pw', length_min: 8 }]) });
    const snap = await fetchAuthentikConfig({ baseUrl: BASE, token: 't', fetchImpl: v.fetchImpl, sleep: noSleep });
    expect(snap.complete).toBe(false);
    const out = translateAuthentikConfig(snap);
    expect((out.documents.instance as { auth_config: Record<string, unknown> }).auth_config.signUpMode).toBeUndefined();
    expect((out.documents.instance as { auth_config: { passwordPolicy: { minLength: number } } }).auth_config.passwordPolicy.minLength).toBe(8);
  });

  it('flags a provider without a signing key', async () => {
    const v = fakeVendor(BASE, { ...all, 'GET /api/v3/providers/oauth2/': page([{ pk: 1, name: 'p', client_id: 'c', signing_key: null }]) });
    const out = translateAuthentikConfig(await fetchAuthentikConfig({ baseUrl: BASE, token: 't', fetchImpl: v.fetchImpl, sleep: noSleep }));
    expect(out.report.some((r) => r.setting.endsWith('.signing_key') && r.status === 'manual')).toBe(true);
  });

  it('stops when the token is refused', async () => {
    const v = fakeVendor(BASE, { 'GET /api/v3/policies/password/': { status: 401, body: { detail: 'Token invalid' } } });
    await expect(fetchAuthentikConfig({ baseUrl: BASE, token: 'bad', fetchImpl: v.fetchImpl, sleep: noSleep })).rejects.toThrow(/401/);
  });
});

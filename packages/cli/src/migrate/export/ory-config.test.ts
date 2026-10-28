import { describe, expect, it } from 'vitest';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';
import { fetchOryClients, fetchOrySchemas, goDurationMs, parseOryConfig, resolveOrySchemas, splitOryProject, translateOryConfig, type OryConfigSnapshot } from './ory-config';
import { VendorHttp } from './vendor-http';

const SCHEMA = {
  $id: 'https://example.com/customer.schema.json',
  type: 'object',
  properties: {
    traits: {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email', 'ory.sh/kratos': { credentials: { password: { identifier: true } }, verification: { via: 'email' } } },
        name: { type: 'object', properties: { first: { type: 'string' }, last: { type: 'string' } } },
        newsletter: { type: 'boolean' },
      },
      required: ['email', 'newsletter'],
    },
  },
};
const B64 = Buffer.from(JSON.stringify(SCHEMA)).toString('base64');

const KRATOS = `version: v1.3.0
dsn: memory
serve:
  public:
    base_url: https://auth.example.com/
    cors:
      enabled: true
      allowed_origins:
        - https://app.example.com
        - https://*.example.net
identity:
  default_schema_id: customer
  schemas:
    - id: customer
      url: base64://${B64}
selfservice:
  default_browser_return_url: https://app.example.com/
  allowed_return_urls:
    - https://app.example.com/dashboard
    - https://app.example.com/*
  flows:
    registration:
      enabled: true
      ui_url: https://app.example.com/registration
      after:
        hooks:
          - hook: session
        password:
          hooks:
            - hook: web_hook
              config:
                url: https://hooks.example.com/new-user
    login:
      after:
        hooks:
          - hook: require_verified_address
    verification:
      enabled: true
      use: code
    recovery:
      enabled: true
  methods:
    password:
      enabled: true
      config:
        min_password_length: 10
        haveibeenpwned_enabled: true
        max_breaches: 3
    code:
      enabled: true
    totp:
      enabled: true
    lookup_secret:
      enabled: true
    webauthn:
      enabled: true
      config:
        passwordless: true
        rp:
          id: example.com
    oidc:
      enabled: true
      config:
        providers:
          - id: google
            provider: google
            client_id: 1234.apps.googleusercontent.com
            client_secret: shhh
            mapper_url: file:///etc/config/kratos/oidc.google.jsonnet
            scope: [email, profile]
          - id: okta-corp
            provider: generic
            label: Corp SSO
            client_id: abc
            client_secret: shhh
            issuer_url: https://corp.okta.com
courier:
  smtp:
    connection_uri: smtps://user:pw@smtp.example.com:465
    from_address: no-reply@example.com
session:
  lifespan: 720h
  whoami:
    required_aal: highest_available
  cookie:
    name: ory_session_example
    domain: example.com
oauth2_provider:
  url: http://hydra:4445
hashers:
  algorithm: bcrypt
`;

const HYDRA = `urls:
  self:
    issuer: https://auth.example.com
  login: https://app.example.com/login
  consent: https://app.example.com/consent
ttl:
  access_token: 1h
strategies:
  access_token: opaque
oidc:
  subject_identifiers:
    supported_types:
      - pairwise
      - public
oauth2:
  pkce:
    enforced: true
`;

const CLIENTS = [
  {
    client_id: 'web',
    client_name: 'Web app',
    grant_types: ['authorization_code', 'refresh_token'],
    redirect_uris: ['https://app.example.com/callback'],
    scope: 'openid offline_access email',
    token_endpoint_auth_method: 'client_secret_basic',
    skip_consent: true,
    logo_uri: 'https://app.example.com/logo.png',
    audience: ['https://api.example.com'],
  },
  { client_id: 'spa', grant_types: ['authorization_code'], redirect_uris: ['https://spa.example.com/cb'], token_endpoint_auth_method: 'none' },
  { client_id: 'worker', client_name: 'Worker', grant_types: ['client_credentials'], scope: 'api:read', token_endpoint_auth_method: 'private_key_jwt', subject_type: 'pairwise' },
];

const lineOf = (text: string, needle: string) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

function snap(over: Partial<OryConfigSnapshot> = {}): OryConfigSnapshot {
  const kratos = parseOryConfig(KRATOS, 'kratos.yml');
  return { origin: 'kratos.yml', kratos, schemas: resolveOrySchemas(kratos, () => '{}'), clients: [], ...over };
}

describe('translateOryConfig (kratos.yml)', () => {
  const t = translateOryConfig(snap());
  const auth = (t.documents.instance as { auth_config: Record<string, unknown> }).auth_config;
  const entry = (setting: string) => t.report.find((r) => r.setting === setting)!;

  it('maps flows, methods, password policy and sessions onto auth_config', () => {
    expect(auth).toMatchObject({
      signUpMode: 'public',
      requireEmailVerification: true,
      strategies: { password: true, emailCode: true, passkey: true },
      mfa: { factors: { totp: true } },
      passwordPolicy: { minLength: 10, checkBreaches: true },
      session: { absoluteMs: 720 * 3_600_000 },
    });
    expect(entry('session.lifespan')).toMatchObject({ status: 'mapped', atlas: 'auth_config.session.absoluteMs' });
    expect(entry('selfservice.methods.password.config.max_breaches').status).toBe('differs');
  });

  it('cites the kratos.yml line of every YAML setting', () => {
    expect(entry('selfservice.methods.password.config.min_password_length')).toMatchObject({ file: 'kratos.yml', line: lineOf(KRATOS, 'min_password_length') });
    expect(entry('session.lifespan')).toMatchObject({ file: 'kratos.yml', line: lineOf(KRATOS, 'lifespan') });
  });

  it('turns return URLs into redirect URLs and CORS origins into allowed origins, refusing wildcards', () => {
    expect(t.documents.redirect_urls).toEqual([{ url: 'https://app.example.com/' }, { url: 'https://app.example.com/dashboard' }]);
    expect(t.report.some((r) => r.setting === 'selfservice.allowed_return_urls' && r.status === 'differs' && /\*/.test(r.note))).toBe(true);
    expect((t.documents.instance as { allowed_origins: string[] }).allowed_origins).toEqual(['https://app.example.com']);
    expect(entry('serve.public.cors.allowed_origins').status).toMatch(/mapped|differs/);
  });

  it('keeps the OAuth app of a built-in provider and builds a custom OIDC provider for the rest, never copying secrets', () => {
    expect(t.documents.oauth_providers).toEqual([
      {
        provider: 'google',
        enabled: true,
        allow_sign_in: true,
        allow_sign_up: true,
        client_id: '1234.apps.googleusercontent.com',
        client_secret: '${GOOGLE_CLIENT_SECRET}',
        scopes: ['email', 'profile'],
      },
    ]);
    expect(t.documents.custom_oauth_providers).toEqual([
      expect.objectContaining({
        provider_key: 'okta_corp',
        display_name: 'Corp SSO',
        protocol: 'oidc',
        issuer: 'https://corp.okta.com',
        discovery_url: 'https://corp.okta.com/.well-known/openid-configuration',
        client_id: 'abc',
        client_secret: '${OKTA_CORP_CLIENT_SECRET}',
      }),
    ]);
    expect(t.mappings.providers).toEqual({ google: 'google', 'okta-corp': 'okta_corp' });
    expect(t.env.map((e) => e.name).sort()).toEqual(['GOOGLE_CLIENT_SECRET', 'OKTA_CORP_CLIENT_SECRET']);
    expect(JSON.stringify(t)).not.toContain('shhh');
    expect(JSON.stringify(t)).not.toContain('user:pw');
  });

  it('reports web hooks, SMTP, the claims mapper and UI URLs as manual', () => {
    const manual = t.report.filter((r) => r.status === 'manual').map((r) => r.setting);
    expect(manual).toContain('selfservice.flows.registration.after.password.hooks.0');
    expect(manual).toContain('courier.smtp.connection_uri');
    expect(manual).toContain('selfservice.methods.oidc.config.providers.0.mapper_url');
    expect(manual).toContain('selfservice.flows.registration.ui_url');
  });

  it('reads the identity schema: mapped traits and custom traits', () => {
    expect(entry('identity schema customer traits.email')).toMatchObject({ status: 'mapped', note: expect.stringContaining('signs in via password') });
    expect(entry('identity schema customer traits.name')).toMatchObject({ status: 'mapped' });
    expect(entry('identity schema customer traits.newsletter')).toMatchObject({ status: 'differs', note: expect.stringContaining('unsafe_metadata.ory_traits.newsletter') });
  });

  it('notes the passkey relying-party id and the hashing algorithm', () => {
    expect(entry('selfservice.methods.webauthn.config.rp.id').note).toContain('--set ory-rp-id=example.com');
    expect(entry('hashers.algorithm').status).toBe('mapped');
  });

  it('learns the bridge and lazy settings from the public URL and cookie name', () => {
    expect(t.bridge).toEqual({ preset: 'ory_whoami', vars: { cookie_name: 'ory_session_example', base_url: 'https://auth.example.com' } });
    expect(t.lazy).toEqual({ preset: 'ory', config: { base_url: 'https://auth.example.com' } });
  });

  it('closes sign-up and requires a second factor when the config says so', () => {
    const closed = parseOryConfig('selfservice:\n  flows:\n    registration:\n      enabled: false\nsession:\n  whoami:\n    required_aal: aal2\n', 'kratos.yml');
    const out = translateOryConfig({ origin: 'x', kratos: closed, schemas: [], clients: [] });
    expect((out.documents.instance as { auth_config: Record<string, unknown> }).auth_config).toMatchObject({ signUpMode: 'restricted', mfaPolicy: 'required' });
  });
});

describe('translateOryConfig (Hydra)', () => {
  const hydra = parseOryConfig(HYDRA, 'hydra.yml');
  const t = translateOryConfig(snap({ hydra, clients: CLIENTS }));
  const entry = (setting: string) => t.report.find((r) => r.setting === setting)!;

  it('reports the issuer, lifetimes, pairwise subjects and the hosted login / consent apps', () => {
    expect(entry('urls.self.issuer')).toMatchObject({ status: 'differs', atlas: 'auth_config.legacyIssuers', file: 'hydra.yml' });
    expect(entry('ttl.access_token').status).toBe('differs');
    expect(entry('strategies.access_token').status).toBe('differs');
    expect(entry('oidc.subject_identifiers.supported_types').status).toBe('manual');
    expect(entry('urls.login').status).toBe('manual');
    expect(entry('oauth2.pkce.enforced').status).toBe('mapped');
  });

  it('turns Hydra clients into Atlas OAuth clients and reissues their secrets', () => {
    expect(t.documents.oauth_clients).toEqual([
      {
        name: 'Web app',
        redirect_uris: ['https://app.example.com/callback'],
        allowed_scopes: ['openid', 'offline_access', 'email'],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'client_secret_basic',
        logo_url: 'https://app.example.com/logo.png',
        first_party: true,
      },
      { name: 'spa', redirect_uris: ['https://spa.example.com/cb'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'none' },
      { name: 'Worker', allowed_scopes: ['api:read'], grant_types: ['client_credentials'], token_endpoint_auth_method: 'private_key_jwt' },
    ]);
    expect(entry('client_secret')).toMatchObject({ status: 'manual', note: expect.stringContaining('2 client(s) authenticate with a secret') });
    expect(entry('clients worker subject_type').status).toBe('manual');
    expect(entry('clients worker token_endpoint_auth_method').status).toBe('manual');
    expect(entry('clients web audience').atlas).toBe('resource_servers');
  });
});

describe('readers', () => {
  it('reads a JSON Kratos config and splits an Ory Network project', () => {
    const project = parseOryConfig(
      JSON.stringify({ slug: 'happy-moore-abc', services: { identity: { config: { session: { lifespan: '1h' } } }, oauth2: { config: { ttl: { access_token: '5m' } } } } }),
      'project.json',
    );
    const split = splitOryProject(project)!;
    expect(split.slug).toBe('happy-moore-abc');
    const t = translateOryConfig({ origin: 'project', kratos: split.kratos, hydra: split.hydra, schemas: [], clients: [], publicUrl: 'https://happy-moore-abc.projects.oryapis.com/' });
    expect(t.bridge?.vars).toEqual({ cookie_name: 'ory_session_happy-moore-abc', base_url: 'https://happy-moore-abc.projects.oryapis.com' });
    expect(t.report.find((r) => r.setting === 'ttl.access_token')).toBeDefined();
    expect(splitOryProject(parseOryConfig('{"session":{}}', 'k.json'))).toBeNull();
  });

  it('parses Go durations', () => {
    expect(goDurationMs('24h')).toBe(86_400_000);
    expect(goDurationMs('1h30m')).toBe(5_400_000);
    expect(goDurationMs('soon')).toBeUndefined();
    expect(goDurationMs(undefined)).toBeUndefined();
  });

  it('resolves base64:// and file:// schemas and warns about the rest', () => {
    const kratos = parseOryConfig(
      `identity:\n  schemas:\n    - id: a\n      url: base64://${B64}\n    - id: b\n      url: file:///etc/kratos/b.json\n    - id: c\n      url: https://example.com/c.json\n`,
      'kratos.yml',
    );
    const warnings: string[] = [];
    const read: string[] = [];
    const out = resolveOrySchemas(kratos, (path) => (read.push(path), JSON.stringify({ title: 'b' })), (m) => warnings.push(m));
    expect(out.map((s) => s.id)).toEqual(['a', 'b']);
    expect(read).toEqual(['/etc/kratos/b.json']);
    expect(warnings).toEqual(['Identity schema "c" is at https://example.com/c.json: pass its file, or give Kratos\' public URL so it is read from /schemas.']);
  });

  it('reads schemas from a running Kratos and clients from Hydra, following the Link header', async () => {
    const v = fakeVendor('https://auth.example.com', {
      'GET /schemas': [{ id: 'customer', schema: SCHEMA }, { id: 'bad' }],
      'GET /admin/clients?page_size=2': { status: 200, body: [CLIENTS[0], CLIENTS[1]], headers: { link: '</admin/clients?page_size=2&page_token=P2>; rel="next"' } },
      'GET /admin/clients?page_size=2&page_token=P2': [CLIENTS[2]],
    });
    const http = new VendorHttp({ vendor: 'Ory', baseUrl: 'https://auth.example.com', fetchImpl: v.fetchImpl, sleep: noSleep });
    expect((await fetchOrySchemas(http)).map((s) => s.id)).toEqual(['customer']);
    expect((await fetchOryClients(http, 2)).map((c) => c.client_id)).toEqual(['web', 'spa', 'worker']);
  });
});

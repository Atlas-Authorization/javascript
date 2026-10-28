import { describe, expect, it } from 'vitest';
import {
  PresetVariableError,
  cookieNameMatches,
  getMigrationBridgePreset,
  listMigrationBridgePresets,
  registerMigrationBridgePreset,
  resolveMigrationBridgePreset,
} from './migration-presets';

/** A plausible value for every variable a starter preset names. */
const SAMPLE: Record<string, string> = {
  issuer: 'https://idp.example.com',
  domain: 'acme.us.auth0.com',
  frontend_api: 'clerk.example.com',
  region: 'us-east-1',
  user_pool_id: 'us-east-1_AbCdEf',
  client_id: 'client_01ABCDEF',
  project_id: 'acme-prod',
  project_ref: 'abcdefghijklmnop',
  base_url: 'https://sso.example.com',
  realm: 'main',
  cookie_name: 'sid',
  auth_url: 'https://db.example.com/auth/v1',
  endpoint_url: 'https://cloud.appwrite.example/v1',
  url: 'https://pb.example.com',
  tenant: 'contoso',
  tenant_id: '11111111-2222-3333-4444-555555555555',
  policy: 'B2C_1_signin',
  collection: 'users',
  issuer_name: 'acme.com',
  environment_id: '0f9c8b7a-1234-4abc-9def-0123456789ab',
  subdomain: 'acme',
};

describe('bridge presets', () => {
  it('every preset resolves with its variables filled in', () => {
    const presets = listMigrationBridgePresets();
    expect(presets.length).toBeGreaterThanOrEqual(20);
    for (const p of presets) {
      const r = resolveMigrationBridgePreset(p.id, SAMPLE);
      expect(r.preset).toBe(p.id);
      const all = [r.issuer ?? '', r.keysUrl ?? '', ...(r.audience ?? []), ...r.cookies, ...r.clearCookies].join(' ');
      expect(all).not.toMatch(/\{[a-z_]+\}/);
      if (p.mode === 'jwt') {
        expect(r.issuer).toBeTruthy();
        expect(r.algorithms.length).toBeGreaterThan(0);
        expect(r.claims.subject).toBeTruthy();
        if (r.keysUrl) expect(r.keysUrl.startsWith('https://')).toBe(true);
      }
    }
  });

  it('fills the vendor templates', () => {
    const cognito = resolveMigrationBridgePreset('cognito', { region: 'eu-west-1', user_pool_id: 'eu-west-1_X', client_id: 'abc' });
    expect(cognito.issuer).toBe('https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_X');
    expect(cognito.keysUrl).toBe('https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_X/.well-known/jwks.json');
    expect(cognito.audience).toEqual(['abc']);
    expect(cognito.cookies).toEqual(['CognitoIdentityServiceProvider.abc.*.idToken']);
    const auth0 = resolveMigrationBridgePreset('auth0', { domain: 'https://acme.us.auth0.com/', client_id: 'client_01ABCDEF' });
    expect(auth0.issuer).toBe('https://acme.us.auth0.com/');
    expect(() => resolveMigrationBridgePreset('keycloak', { base_url: 'sso.example.com', realm: 'r' })).toThrow(/https URL/);
    expect(resolveMigrationBridgePreset('okta', { domain: 'x.okta.com' }).issuer).toBe('https://x.okta.com/oauth2/default');
    expect(resolveMigrationBridgePreset('better_auth').cookies).toEqual(['__Secure-better-auth.session_token', 'better-auth.session_token']);
    expect(resolveMigrationBridgePreset('better_auth', { cookie_prefix: 'myapp' }).cookies[1]).toBe('myapp.session_token');
    expect(resolveMigrationBridgePreset('clerk', SAMPLE).sharesAtlasCookie).toBe(true);
    expect(resolveMigrationBridgePreset('firebase_session_cookie', SAMPLE).keysFormat).toBe('x509');
  });

  it('refuses a missing or malformed variable and an unknown preset', () => {
    expect(() => resolveMigrationBridgePreset('cognito', { region: 'us-east-1' })).toThrow(PresetVariableError);
    try {
      resolveMigrationBridgePreset('cognito', { region: 'us-east-1', client_id: 'x' });
    } catch (e) {
      expect((e as PresetVariableError).variable).toBe('user_pool_id');
    }
    expect(() => resolveMigrationBridgePreset('nope')).toThrow(/Unknown bridge preset/);
  });

  it('refuses template injection through a variable', () => {
    for (const bad of ['evil.com/?x=', 'a b', 'acme.com#frag', '../../etc', 'x@evil.com', 'http://plain.example.com', '{domain}']) {
      expect(() => resolveMigrationBridgePreset('auth0', { domain: bad, client_id: 'client_01ABCDEF' }), bad).toThrow(PresetVariableError);
    }
  });

  it('registration: ids are checked and a duplicate needs replace', () => {
    expect(() => registerMigrationBridgePreset({ id: 'Bad-Id', label: 'x', mode: 'session_table', cookies: [] })).toThrow(/Invalid/);
    expect(() => registerMigrationBridgePreset({ id: 'auth0', label: 'x', mode: 'session_table', cookies: [] })).toThrow(/already/);
    expect(() => registerMigrationBridgePreset({ id: 'test_jwtless', label: 'x', mode: 'jwt', cookies: [] })).toThrow(/no jwt/);
    registerMigrationBridgePreset({ id: 'test_custom_sessions', label: 'x', mode: 'session_table', cookies: ['sid'] });
    expect(getMigrationBridgePreset('test_custom_sessions')?.cookies).toEqual(['sid']);
  });
});

describe('remote presets', () => {
  it('needs remote settings, fills variables and leaves {token} for the server', () => {
    expect(() => registerMigrationBridgePreset({ id: 'test_remote_bare', label: 'x', mode: 'remote', cookies: [] })).toThrow(/no remote/);
    registerMigrationBridgePreset({
      id: 'test_remote',
      label: 'Remote vendor',
      mode: 'remote',
      vars: { endpoint: 'API host', project: 'Project id' },
      remote: {
        url: 'https://{endpoint}/v1/account?project={project}',
        method: 'POST',
        headers: { authorization: 'Bearer {token}', 'x-project': '{project}' },
        body: '{"jwt":"{token}"}',
        subjectPath: 'record.id',
        emailPath: 'record.email',
      },
      cookies: ['remote_session_{project}'],
    });
    const r = resolveMigrationBridgePreset('test_remote', { endpoint: 'cloud.example.io', project: 'p1' });
    expect(r.mode).toBe('remote');
    expect(r.issuer).toBeNull();
    expect(r.cookies).toEqual(['remote_session_p1']);
    expect(r.remote).toEqual({
      url: 'https://cloud.example.io/v1/account?project=p1',
      method: 'POST',
      headers: { authorization: 'Bearer {token}', 'x-project': 'p1' },
      body: '{"jwt":"{token}"}',
      subjectPath: 'record.id',
      emailPath: 'record.email',
    });
    expect(() => resolveMigrationBridgePreset('test_remote', { endpoint: 'cloud.example.io' })).toThrow(PresetVariableError);
    expect(resolveMigrationBridgePreset('auth0', SAMPLE).remote).toBeNull();
  });
});

describe('cookieNameMatches', () => {
  it('matches exact names and * runs, escaping regex characters', () => {
    expect(cookieNameMatches('sid', 'sid')).toBe(true);
    expect(cookieNameMatches('sid', 'sid2')).toBe(false);
    expect(cookieNameMatches('CognitoIdentityServiceProvider.abc.*.idToken', 'CognitoIdentityServiceProvider.abc.jane@example.com.idToken')).toBe(true);
    expect(cookieNameMatches('CognitoIdentityServiceProvider.abc.*.idToken', 'CognitoIdentityServiceProvider.abc.jane.accessToken')).toBe(false);
    expect(cookieNameMatches('a.b*', 'aXb1')).toBe(false);
    expect(cookieNameMatches('ory_session_*', 'ory_session_abc')).toBe(true);
  });
});

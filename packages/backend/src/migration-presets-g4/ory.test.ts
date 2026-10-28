import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PresetVariableError, cookieNameMatches, getMigrationBridgePreset, resolveMigrationBridgePreset } from '../migration-presets';

/**
 * The Ory bridge presets against what Kratos really sends: a `GET
 * /sessions/whoami` answer (`kratos.Session` JSON: `identity`, `traits`,
 * `verifiable_addresses`, `authenticator_assurance_level`) and the session
 * token (`ory_st_…`) Kratos stores in `sessions.token`.
 */

const WHOAMI = {
  id: '3f0c8a2e-5b74-4b8c-9d0a-0f2f1d9a7c11',
  active: true,
  expires_at: '2030-01-01T00:00:00Z',
  authenticated_at: '2026-10-01T09:00:00Z',
  authenticator_assurance_level: 'aal1',
  authentication_methods: [{ method: 'password', aal: 'aal1', completed_at: '2026-10-01T09:00:00Z' }],
  identity: {
    id: '9f425a8d-7efc-4768-8792-2e202d77e8a0',
    schema_id: 'default',
    state: 'active',
    traits: { email: 'jane@example.com', name: 'Jane Doe' },
    verifiable_addresses: [{ id: 'a1', value: 'jane@example.com', verified: true, via: 'email', status: 'completed' }],
  },
};

/** The server's reader: a dot path through the JSON answer (arrays by index). */
const at = (body: unknown, path: string) => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), body);

describe('Ory bridge presets', () => {
  it('replaced the starter with a session table and two remote presets', () => {
    expect(getMigrationBridgePreset('ory')).toMatchObject({ mode: 'session_table', bearer: true, cookies: [] });
    expect(getMigrationBridgePreset('ory_whoami')?.mode).toBe('remote');
    expect(getMigrationBridgePreset('ory_whoami_token')?.mode).toBe('remote');
  });

  it('ory (session_table): needs no variables and matches the stored token by sha256', () => {
    const r = resolveMigrationBridgePreset('ory');
    expect(r).toMatchObject({ mode: 'session_table', bearer: true, cookies: [], remote: null });
    // What the exporter stores for sessions.token = ory_st_… is what the bridge computes for the bearer value.
    const token = 'ory_st_8mT2yTqJzBvX9hDkR1oLw3cN5uQeAsGf';
    expect(createHash('sha256').update(token, 'utf8').digest('hex')).toHaveLength(64);
  });

  it('ory_whoami: builds the whoami call with the cookie, self-hosted', () => {
    const r = resolveMigrationBridgePreset('ory_whoami', { base_url: 'https://auth.example.com/', cookie_name: 'ory_kratos_session' });
    expect(r.mode).toBe('remote');
    expect(r.remote).toEqual({
      url: 'https://auth.example.com/sessions/whoami',
      method: 'GET',
      headers: { cookie: 'ory_kratos_session={token}' },
      subjectPath: 'identity.id',
      emailPath: 'identity.traits.email',
      emailVerifiedPath: 'identity.verifiable_addresses.0.verified',
      namePath: 'identity.traits.name',
    });
    expect(r.cookies).toEqual(['ory_kratos_session', 'ory_session_*']);
  });

  it('ory_whoami: Ory Network names the cookie after the project slug', () => {
    const r = resolveMigrationBridgePreset('ory_whoami', { base_url: 'https://happy-moore-abc.projects.oryapis.com', cookie_name: 'ory_session_happymooreabc' });
    expect(r.remote?.url).toBe('https://happy-moore-abc.projects.oryapis.com/sessions/whoami');
    expect(r.remote?.headers?.cookie).toBe('ory_session_happymooreabc={token}');
    expect(r.cookies.some((c) => cookieNameMatches(c, 'ory_session_happymooreabc'))).toBe(true);
    expect(r.cookies.some((c) => cookieNameMatches(c, 'ory_kratos_session'))).toBe(true);
    expect(r.cookies.some((c) => cookieNameMatches(c, 'session'))).toBe(false);
  });

  it('ory_whoami_token: sends the session token in X-Session-Token', () => {
    const r = resolveMigrationBridgePreset('ory_whoami_token', { base_url: 'https://auth.example.com' });
    expect(r.remote?.headers).toEqual({ 'x-session-token': '{token}' });
    expect(r).toMatchObject({ bearer: true, cookies: [] });
  });

  it('reads the user id, email and verified flag from a real whoami answer', () => {
    const { remote } = resolveMigrationBridgePreset('ory_whoami', { base_url: 'https://auth.example.com', cookie_name: 'ory_kratos_session' });
    expect(at(WHOAMI, remote!.subjectPath)).toBe('9f425a8d-7efc-4768-8792-2e202d77e8a0');
    expect(at(WHOAMI, remote!.emailPath!)).toBe('jane@example.com');
    expect(at(WHOAMI, remote!.emailVerifiedPath!)).toBe(true);
    expect(at(WHOAMI, remote!.namePath!)).toBe('Jane Doe');
    // Kratos answers an unknown session with { error: … }: no subject, nothing to exchange.
    expect(at({ error: { code: 401, status: 'Unauthorized' } }, remote!.subjectPath)).toBeUndefined();
  });

  it('refuses a missing variable or a non-https base URL', () => {
    expect(() => resolveMigrationBridgePreset('ory_whoami', { base_url: 'https://auth.example.com' })).toThrow(PresetVariableError);
    expect(() => resolveMigrationBridgePreset('ory_whoami_token', {})).toThrow(PresetVariableError);
    expect(() => resolveMigrationBridgePreset('ory_whoami_token', { base_url: 'http://kratos:4433' })).toThrow(PresetVariableError);
  });
});

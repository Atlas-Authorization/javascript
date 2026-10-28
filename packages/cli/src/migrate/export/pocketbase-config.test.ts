import { describe, expect, it } from 'vitest';
import { parsePocketBaseSchema, translatePocketBaseConfig } from './pocketbase-config';

/** A v0.23 collections export (Settings → Export collections): options flattened onto each collection. */
const SCHEMA = `[
  {
    "id": "pbc_posts",
    "name": "posts",
    "type": "base",
    "fields": []
  },
  {
    "id": "_pb_users_auth_",
    "name": "users",
    "type": "auth",
    "system": false,
    "authRule": "verified = true",
    "manageRule": null,
    "authAlert": { "enabled": true },
    "oauth2": {
      "enabled": true,
      "mappedFields": { "id": "", "name": "name", "username": "", "avatarURL": "avatar" },
      "providers": [
        { "name": "google", "clientId": "123.apps.googleusercontent.com" },
        { "name": "oidc", "clientId": "corp-client" }
      ]
    },
    "passwordAuth": { "enabled": true, "identityFields": ["email", "username"] },
    "mfa": { "enabled": true, "duration": 1800, "rule": "" },
    "otp": { "enabled": true, "duration": 180, "length": 8 },
    "authToken": { "duration": 604800 },
    "fields": [
      { "name": "password", "type": "password", "min": 10, "hidden": true }
    ]
  }
]
`;

describe('translatePocketBaseConfig', () => {
  it('maps a v0.23 collections export with file:line', () => {
    const t = translatePocketBaseConfig({ collections: parsePocketBaseSchema(SCHEMA), file: { path: 'pb_schema.json', text: SCHEMA }, url: 'https://pb.example.com/' });
    const auth = (t.documents.instance as { auth_config: Record<string, unknown> }).auth_config;
    expect(auth.strategies).toEqual({ password: true, username: true, emailCode: true });
    expect(auth.passwordPolicy).toEqual({ minLength: 10 });
    expect(auth.session).toEqual({ absoluteMs: 604800_000 });
    expect(auth.mfaPolicy).toBe('required');

    const row = (setting: string) => t.report.find((r) => r.setting === setting);
    expect(row('passwordAuth.enabled')).toMatchObject({ status: 'mapped', file: 'pb_schema.json', line: 24 });
    expect(row('authRule')).toMatchObject({ status: 'manual', line: 13 });
    expect(row('authToken.duration')).toMatchObject({ status: 'mapped', line: 27 });
    expect(row('fields.password.min')).toMatchObject({ status: 'mapped', line: 29 });
    expect(row('otp.length')?.status).toBe('differs');
    expect(row('mfa.enabled')?.status).toBe('differs');
    expect(row('oauth2.providers.oidc')).toMatchObject({ status: 'manual', line: 21 });
    expect(row('manageRule')).toBeUndefined();

    expect((t.documents.oauth_providers as Array<Record<string, unknown>>)[0]).toMatchObject({ provider: 'google', client_id: '123.apps.googleusercontent.com' });
    expect(t.bridge).toEqual({ preset: 'pocketbase', vars: { collection: 'users', url: 'https://pb.example.com' } });
    expect(t.lazy).toEqual({ preset: 'pocketbase', config: { collection: 'users', url: 'https://pb.example.com' } });
  });

  it('maps ≤0.22 options read from _collections', () => {
    const t = translatePocketBaseConfig({
      collections: [
        {
          id: '_pb_users_auth_',
          name: 'users',
          type: 'auth',
          options: JSON.stringify({ allowEmailAuth: true, allowUsernameAuth: false, allowOAuth2Auth: true, minPasswordLength: 6, onlyVerified: true, onlyEmailDomains: ['acme.example'] }),
        },
      ],
    });
    const auth = (t.documents.instance as { auth_config: Record<string, unknown> }).auth_config;
    expect(auth.strategies).toEqual({ password: true });
    expect(auth.passwordPolicy).toEqual({ minLength: 8 });
    expect(auth.requireEmailVerification).toBe(true);
    expect(t.report.find((r) => r.setting === 'minPasswordLength')?.status).toBe('differs');
    expect(t.report.find((r) => r.setting === 'allowOAuth2Auth')?.status).toBe('manual');
    expect(t.report.find((r) => r.setting === 'onlyEmailDomains')?.status).toBe('manual');
    expect(t.report.every((r) => r.file === undefined)).toBe(true);
    expect(t.origin).toBe('pocketbase collection users');
  });

  it('reports a database without auth collections', () => {
    const t = translatePocketBaseConfig({ collections: [{ name: 'posts', type: 'base' }] });
    expect(t.report[0]).toMatchObject({ status: 'manual', setting: '_collections' });
  });

  it('flags several auth collections', () => {
    const t = translatePocketBaseConfig({ collections: [{ name: 'users', type: 'auth' }, { name: 'staff', type: 'auth' }, { name: '_superusers', type: 'auth' }] });
    expect(t.report.find((r) => r.setting === 'auth collections')).toMatchObject({ status: 'differs' });
  });
});

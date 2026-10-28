import { describe, expect, it } from 'vitest';
import { translateAppwriteConfig } from './appwrite-config';

/** `appwrite.json` as `appwrite pull settings` writes it, and a 1.6 project document. */
const FILE = `{
    "projectId": "acme-prod",
    "projectName": "Acme",
    "endpoint": "https://appwrite.acme.example/v1/",
    "settings": {
        "services": { "account": true, "teams": true },
        "auth": {
            "methods": {
                "jwt": true,
                "phone": false,
                "invites": true,
                "anonymous": true,
                "email-otp": true,
                "magic-url": false,
                "email-password": true
            },
            "security": {
                "duration": 31536000,
                "limit": 5000,
                "sessionsLimit": 10,
                "passwordHistory": 5,
                "passwordDictionary": true,
                "personalDataCheck": true,
                "sessionAlerts": true,
                "mockNumbers": [{ "phone": "+15550000000", "otp": "123456" }]
            }
        }
    }
}
`;

const PROJECT = {
  $id: 'acme-prod',
  name: 'Acme',
  authDuration: 86400,
  authEmailPassword: true,
  authMembershipsUserEmail: false,
  oAuthProviders: [
    { key: 'google', name: 'Google', appId: '123.apps.googleusercontent.com', secret: '', enabled: true },
    { key: 'github', name: 'GitHub', appId: 'Iv1.abc', secret: '', enabled: false },
    { key: 'zoho', name: 'Zoho', appId: 'zoho-app', secret: '', enabled: true },
  ],
};

describe('translateAppwriteConfig', () => {
  it('maps appwrite.json methods and security with file:line', () => {
    const t = translateAppwriteConfig({ file: { path: 'appwrite.json', text: FILE } });
    const auth = (t.documents.instance as { auth_config: Record<string, Record<string, unknown>> }).auth_config;
    expect(auth.strategies).toEqual({ password: true, emailCode: true, emailLink: false, phoneCode: false, anonymous: true });
    expect(auth.session).toEqual({ absoluteMs: 90 * 24 * 3600_000, maxConcurrentSessions: 10 });
    expect(auth.passwordPolicy).toEqual({ minLength: 8, historyCount: 5, checkBreaches: true, rejectIdentifierSubstring: true });

    const line = (setting: string) => t.report.find((r) => r.setting === setting);
    expect(line('settings.auth.security.duration')).toMatchObject({ status: 'differs', file: 'appwrite.json', line: 18 });
    expect(line('settings.auth.methods.email-password')).toMatchObject({ status: 'mapped', file: 'appwrite.json', line: 15 });
    expect(line('settings.auth.methods.jwt')).toMatchObject({ status: 'differs', line: 9 });
    expect(line('settings.auth.security.limit')).toMatchObject({ status: 'manual' });
    expect(line('settings.auth.security.mockNumbers')).toMatchObject({ status: 'manual', line: 25 });
    expect(line('oAuthProviders')?.status).toBe('manual');

    expect(t.origin).toBe('appwrite.json');
    expect(t.bridge).toEqual({ preset: 'appwrite', vars: { project_id: 'acme-prod', endpoint_url: 'https://appwrite.acme.example/v1' } });
    expect(t.lazy).toEqual({ preset: 'appwrite', config: { project_id: 'acme-prod', endpoint: 'https://appwrite.acme.example/v1' } });
  });

  it('reads OAuth providers and 1.x flags from the project document', () => {
    const t = translateAppwriteConfig({ project: PROJECT, endpoint: 'https://cloud.appwrite.io/v1' });
    const providers = t.documents.oauth_providers as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ provider: 'google', client_id: '123.apps.googleusercontent.com', client_secret: '${GOOGLE_CLIENT_SECRET}' });
    expect(t.env).toContainEqual({ name: 'GOOGLE_CLIENT_SECRET', for: 'google client secret' });
    expect(t.mappings.providers).toEqual({ google: 'google' });
    expect(t.report.find((r) => r.setting === 'oAuthProviders.zoho')?.status).toBe('manual');
    expect(t.report.find((r) => r.setting === 'oAuthProviders.github')).toBeUndefined();
    expect(t.report.find((r) => r.setting === 'authDuration')).toMatchObject({ status: 'mapped' });
    expect(t.report.find((r) => r.setting === 'authMembershipsUserEmail')?.status).toBe('manual');
    expect(t.bridge?.vars).toEqual({ project_id: 'acme-prod', endpoint_url: 'https://cloud.appwrite.io/v1' });
  });

  it('prefers the file over the project document for the same setting', () => {
    const t = translateAppwriteConfig({ file: { path: 'appwrite.json', text: FILE }, project: PROJECT });
    expect(t.report.filter((r) => r.setting.endsWith('duration') || r.setting === 'authDuration')).toHaveLength(1);
    expect(t.report.find((r) => r.setting === 'oAuthProviders')).toBeUndefined();
  });
});

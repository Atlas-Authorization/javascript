import { describe, expect, it } from 'vitest';
import type { ParsedArgs } from '../args';
import { MemoryConfigStore } from '../config';
import type { RunContext } from '../context';
import { devNative } from './dev-native';

// instanceCredential/httpFor read the secret key from the environment; the injected makeHttp serves canned answers.
function ctxWith(answers: Record<string, unknown>) {
  const out: string[] = [];
  const ctx = {
    config: new MemoryConfigStore({ active_profile: 'default', profiles: {} }),
    io: { out: (l: string) => out.push(l), err: () => {} },
    env: { ATLAS_SECRET_KEY: 'sk_test_x', ATLAS_API_URL: 'https://api.example.test' },
    makeHttp: () => ({ get: async (p: string) => { if (!(p in answers)) throw new Error('404'); return answers[p]; } }),
  } as unknown as RunContext;
  return { ctx, out };
}
const args = (values: Record<string, unknown> = {}) => ({ positionals: ['dev', 'native'], values }) as unknown as ParsedArgs;

describe('atlas dev native', () => {
  it('warns when no app is registered and prints the snippet and the Expo Go note', async () => {
    const { ctx, out } = ctxWith({ '/v1/instance': { environment: 'development', publishable_key: 'pk_test_1', frontend_api_host: 'fapi.example.test' }, '/v1/native_apps': { data: [] } });
    expect(await devNative(ctx, args())).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('pk_test_1');
    expect(text).toContain('https://fapi.example.test');
    expect(text).toContain('No native app is registered');
    expect(text).toContain("signInWithOAuth('discord')");
    expect(text).toContain('Expo Go');
  });

  it('lists each app with its callbacks and the provider asked for', async () => {
    const { ctx, out } = ctxWith({
      '/v1/instance': { environment: 'production', publishable_key: 'pk_live_1', frontend_api_host: 'fapi.example.test' },
      '/v1/native_apps': { data: [{ id: 'napp_1', platform: 'ios', bundle_id: 'com.example.app', team_id: 'TEAM123456', callback_urls: ['exampleapp://oauth-callback'] }] },
      '/v1/instance/preflight': { findings: [{ severity: 'warning', code: 'apple_sign_in_required', message: 'Apple is off.', fix: 'Enable it.' }] },
    });
    await devNative(ctx, args({ provider: 'github' }));
    const text = out.join('\n');
    expect(text).toContain('napp_1  ios  TEAM123456.com.example.app');
    expect(text).toContain('exampleapp://oauth-callback');
    expect(text).toContain('apple_sign_in_required');
    expect(text).toContain("signInWithOAuth('github')");
    expect(text).toContain('appId="napp_1"');
    expect(text).not.toContain('Expo Go');
  });

  it('says how each enabled provider signs in from an app and the URL to register', async () => {
    const { ctx, out } = ctxWith({
      '/v1/instance': { environment: 'production', publishable_key: 'pk_live_1', frontend_api_host: 'fapi.example.test' },
      '/v1/native_apps': { data: [] },
      '/v1/oauth_providers?configured=true': {
        data: [
          { provider: 'google', enabled: true, has_secret: false, hosted_id_token: { available: true, redirect_uri: 'https://fapi.example.test/v1/oauth/id_token_return/google' } },
          { provider: 'discord', enabled: true, has_secret: true, redirect_uri: 'https://fapi.example.test/v1/oauth/callback/discord', hosted_id_token: null },
          { provider: 'facebook', enabled: true, has_secret: false, hosted_id_token: null },
          { provider: 'github', enabled: false, has_secret: true },
        ],
      },
    });
    await devNative(ctx, args());
    const text = out.join('\n');
    expect(text).toContain('google  browser sign-in with the client ID only');
    expect(text).toContain('https://fapi.example.test/v1/oauth/id_token_return/google');
    expect(text).toContain('https://fapi.example.test/v1/oauth/callback/discord');
    expect(text).toContain('facebook  in-page or native SDK sign-in only');
    expect(text).not.toContain('github');
  });

  it('prints the fix when production refuses unregistered apps, and lists development apps', async () => {
    const { ctx, out } = ctxWith({
      '/v1/instance': { environment: 'production', publishable_key: 'pk_live_1', frontend_api_host: 'fapi.example.test' },
      '/v1/native_apps': { data: [{ id: 'napp_dev', platform: 'development', allowed_users: ['dev@example.com'], expires_at: 1000, callback_urls: ['exp://192.168.0.2:8081/--/cb'] }] },
    });
    await devNative(ctx, args());
    const text = out.join('\n');
    expect(text).toContain('Unregistered apps: refuse (default)');
    expect(text).toContain('napp_dev  EXPIRED');
    expect(text).toContain('dev@example.com');
    expect(text).toContain('PATCH /v1/native_apps/napp_dev');
    expect(text).toContain('"platform":"development"');
  });

  it('reports a configured policy and an active development app without the refuse fix', async () => {
    const { ctx, out } = ctxWith({
      '/v1/instance': { environment: 'production', publishable_key: 'pk_live_1', frontend_api_host: 'fapi.example.test', auth_config_resolved: { nativeApps: { unregistered: 'device_bound', unregisteredSession: { absoluteMs: 86400000, requireMfa: true } } } },
      '/v1/native_apps': { data: [{ id: 'napp_dev', platform: 'development', allowed_users: ['dev@example.com'], expires_at: Date.now() + 86400000, callback_urls: [] }] },
    });
    await devNative(ctx, args());
    const text = out.join('\n');
    expect(text).toContain('Unregistered apps: device_bound');
    expect(text).toContain('MFA required');
    expect(text).toContain('napp_dev  active');
    expect(text).not.toContain('are refused on this instance');
  });
});

import { describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../config-http';
import { NO_SIGNUP_METHOD_MESSAGE, signupUsabilityError, usableSignupMethods } from './signup-usable';

const fake = (routes: Record<string, unknown>): ConfigHttp => ({
  get: (async (path: string) => {
    if (!(path in routes)) throw new Error(`no route ${path}`);
    return routes[path];
  }) as ConfigHttp['get'],
  post: (async () => ({})) as ConfigHttp['post'],
  put: (async () => ({})) as ConfigHttp['put'],
  patch: (async () => ({})) as ConfigHttp['patch'],
  delete: async () => {},
});

const none = { emailProviderInFile: false };

describe('usableSignupMethods', () => {
  const base = { strategies: {}, inactive: new Set<string>(), signInWithAtlas: false, socialSignUp: false };
  it('counts a method that needs email only when email can be sent', () => {
    expect(usableSignupMethods({ ...base, strategies: { emailCode: true }, inactive: new Set(['email_code']) })).toEqual([]);
    expect(usableSignupMethods({ ...base, strategies: { emailCode: true }, emailConfigured: true })).toEqual(['email_code']);
    expect(usableSignupMethods({ ...base, strategies: { password: true }, emailConfigured: false })).toEqual([]);
  });
  it('counts Sign in with Atlas, a social provider and phone', () => {
    expect(usableSignupMethods({ ...base, signInWithAtlas: true })).toEqual(['sign_in_with_atlas']);
    expect(usableSignupMethods({ ...base, socialSignUp: true })).toEqual(['social']);
    expect(usableSignupMethods({ ...base, strategies: { phoneCode: true } })).toEqual(['phoneCode']);
  });
});

describe('signupUsabilityError', () => {
  it('stays silent, without reading the instance, when the file decides nothing', async () => {
    expect(await signupUsabilityError(fake({ '/v1/instance': { signup_usable: false } }), none)).toBeNull();
  });

  it('names the fix first: Sign in with Atlas', () => {
    expect(NO_SIGNUP_METHOD_MESSAGE).toContain('PATCH /v1/instance/sign_in_with_atlas {"enabled":true}');
  });

  it('computes from the merged file when the file turns every method off', async () => {
    const http = fake({
      '/v1/instance': { auth_config: { strategies: { password: true, emailCode: false } }, inactive_methods: [] },
      '/v1/messaging_providers/email': { configured: true },
      '/v1/instance/sign_in_with_atlas': { enabled: false },
      '/v1/oauth_providers': { data: [] },
    });
    const off = { instance: { auth_config: { strategies: { password: false } } }, emailProviderInFile: false };
    expect(await signupUsabilityError(http, off)).toBe(NO_SIGNUP_METHOD_MESSAGE);
    expect(await signupUsabilityError(http, { ...off, signInWithAtlas: { enabled: true } })).toBeNull();
  });

  it('falls back to live inactive_methods when the older server has no signup_usable', async () => {
    const http = fake({
      '/v1/instance': { auth_config: { strategies: { emailCode: true } }, inactive_methods: [{ method: 'email_code', reason: 'no_provider' }] },
      '/v1/messaging_providers/email': { configured: false },
      '/v1/instance/sign_in_with_atlas': { enabled: false },
      '/v1/oauth_providers': { data: [] },
    });
    expect(await signupUsabilityError(http, { instance: { auth_config: { strategies: { emailCode: true } } }, emailProviderInFile: false })).toBe(NO_SIGNUP_METHOD_MESSAGE);
  });

  it('never alarms when it cannot tell', async () => {
    expect(await signupUsabilityError(fake({}), none)).toBeNull();
    expect(await signupUsabilityError(fake({ '/v1/instance': {} }), none)).toBeNull();
  });
});

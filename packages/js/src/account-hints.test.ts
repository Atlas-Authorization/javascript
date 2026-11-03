import { describe, expect, it } from 'vitest';
import { FapiClient } from './fapi';
import { ACCOUNT_UX_DEFAULT, accountUxFrom } from './environment';
import { instanceSettingsFrom } from './instance-settings';
import { startSignUp } from './fapi';
import {
  checkUsernameAvailability,
  fetchLastSignInMethod,
  isLastUsed,
  lastUsedMethodLabel,
  prepareEmailSecondFactor,
  usernameMeetsRule,
} from './account-hints';

function scripted(route: (path: string, body: unknown) => { status?: number; body: unknown }) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ path, method: init?.method ?? 'GET', body });
    const res = route(path, body);
    return new Response(JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://f.example', fetchImpl }), calls };
}

const ACCOUNT = {
  username: { min_length: 4, max_length: 12, charset: 'alphanumeric_underscore', required_at_sign_up: true },
  last_sign_in_method: false,
  email_verification: 'both',
  password_reset: 'link',
};

describe('accountUxFrom', () => {
  it('reads the account block', () => {
    expect(accountUxFrom({ account: ACCOUNT })).toEqual({
      username: { minLength: 4, maxLength: 12, charset: 'alphanumeric_underscore', requiredAtSignUp: true },
      lastSignInMethod: false,
      emailVerification: 'both',
      passwordReset: 'link',
      emailSecondFactor: false,
      passkeySignUp: null,
    });
  });

  it('reads the passkey sign-up offer (an unknown email mode reads as required)', () => {
    expect(accountUxFrom({ account: { ...ACCOUNT, passkey_sign_up: { email: 'optional' } } }).passkeySignUp).toEqual({
      email: 'optional',
    });
    expect(accountUxFrom({ account: { ...ACCOUNT, passkey_sign_up: { email: 'fax' } } }).passkeySignUp).toEqual({
      email: 'required',
    });
    expect(accountUxFrom({ account: { ...ACCOUNT, passkey_sign_up: null } }).passkeySignUp).toBeNull();
  });

  it('reads an older server, or junk, as the defaults', () => {
    expect(accountUxFrom({})).toEqual(ACCOUNT_UX_DEFAULT);
    expect(accountUxFrom({ account: { username: 'x', email_verification: 'carrier-pigeon' } })).toEqual(
      ACCOUNT_UX_DEFAULT,
    );
  });
});

describe('instanceSettingsFrom with usernames on', () => {
  it('puts a username field first in the create-account form', () => {
    const s = instanceSettingsFrom({
      account: ACCOUNT,
      appearance: { signUpFields: [{ key: 'company', label: 'Company', type: 'text', required: false }] },
    });
    expect(s.signUpFields.map((f) => f.key)).toEqual(['username', 'company']);
    expect(s.signUpFields[0]).toMatchObject({ type: 'text', required: true });
  });

  it('adds nothing while usernames are off', () => {
    expect(instanceSettingsFrom({ account: { ...ACCOUNT, username: null } }).signUpFields).toEqual([]);
  });
});

describe('username helpers', () => {
  it('checks the rule locally', () => {
    const rule = { minLength: 3, maxLength: 5, charset: 'alphanumeric' as const, requiredAtSignUp: false };
    expect(usernameMeetsRule('abc', rule)).toBe(true);
    expect(usernameMeetsRule('ab', rule)).toBe(false);
    expect(usernameMeetsRule('a.bc', rule)).toBe(false);
    expect(usernameMeetsRule('a.bc', { ...rule, charset: 'default' })).toBe(true);
  });

  it('asks the server whether a username is free; null when it cannot say', async () => {
    const { client, calls } = scripted(() => ({
      body: { object: 'username_availability', username: 'ada', valid: true, available: false },
    }));
    expect(await checkUsernameAvailability(client, ' ada ')).toEqual({ username: 'ada', valid: true, available: false });
    expect(calls[0]).toMatchObject({ path: '/v1/client/usernames/availability', method: 'POST', body: { username: ' ada ' } });

    const off = scripted(() => ({ status: 422, body: { errors: [{ code: 'STRATEGY_DISABLED', message: 'off' }] } }));
    expect(await checkUsernameAvailability(off.client, 'ada')).toBeNull();
  });

  it('startSignUp sends the username', async () => {
    const { client, calls } = scripted(() => ({ body: { id: 'sua_1', status: 'needs_email_verification' } }));
    await startSignUp(client, { email: 'a@b.c', password: 'pw', username: 'ada' });
    expect(calls[0]!.body).toMatchObject({ email: 'a@b.c', username: 'ada' });
  });
});

describe('last sign-in method', () => {
  it('fetches the remembered method; null when none or unreachable', async () => {
    const { client, calls } = scripted(() => ({ body: { object: 'last_sign_in_method', method: 'oauth_github' } }));
    expect(await fetchLastSignInMethod(client)).toBe('oauth_github');
    expect(calls[0]).toMatchObject({ path: '/v1/client/last_sign_in_method', method: 'GET' });
    const none = scripted(() => ({ body: { object: 'last_sign_in_method', method: null } }));
    expect(await fetchLastSignInMethod(none.client)).toBeNull();
  });

  it('matches options, folding email code/link and provider flows together', () => {
    expect(isLastUsed('oauth_github', 'github')).toBe(true);
    expect(isLastUsed('oauth_github', 'google')).toBe(false);
    expect(isLastUsed('email_link', 'email_code')).toBe(true);
    expect(isLastUsed('password', 'password')).toBe(true);
    expect(isLastUsed('password', 'passkey')).toBe(false);
    expect(isLastUsed(null, 'password')).toBe(false);
  });
});

describe('lastUsedMethodLabel', () => {
  const t = (k: string) => `<${k}>`;
  it('labels first-party methods and leaves social ones to their buttons', () => {
    expect(lastUsedMethodLabel('password', t)).toBe('<signIn.passwordLabel>');
    expect(lastUsedMethodLabel('email_link', t)).toBe('<signIn.identifierLabel>');
    expect(lastUsedMethodLabel('passkey', t)).toBe('Passkey');
    expect(lastUsedMethodLabel('oauth_google', t)).toBeNull();
    expect(lastUsedMethodLabel(null, t)).toBeNull();
  });
});

describe('prepareEmailSecondFactor', () => {
  it('asks for an emailed second-factor code and returns the masked address', async () => {
    const { client, calls } = scripted(() => ({ status: 201, body: { object: 'second_factor_challenge', strategy: 'email_code', sent_to: 'a***@b.c' } }));
    expect(await prepareEmailSecondFactor(client, 'sia_1')).toEqual({ sentTo: 'a***@b.c' });
    expect(calls[0]).toMatchObject({ path: '/v1/client/sign_ins/sia_1/prepare_second_factor', body: { strategy: 'email_code' } });
  });

  it('throws the server refusal', async () => {
    const { client } = scripted(() => ({ status: 400, body: { errors: [{ code: 'VALIDATION', message: 'not offered' }] } }));
    await expect(prepareEmailSecondFactor(client, 'sia_1')).rejects.toMatchObject({ message: 'not offered', code: 'VALIDATION' });
  });
});

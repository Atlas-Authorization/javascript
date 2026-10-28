import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_UX_DEFAULT,
  EMAIL_DELIVERY_UNKNOWN,
  clientEnvironmentFrom,
  emailDeliveryFrom,
  fetchClientEnvironment,
  offeredFirstFactors,
} from './environment';
import { instanceSettingsFrom } from './instance-settings';
import { FapiClient } from './fapi';

const NO_EMAIL = { available: false, password_reset: false, password_sign_up: false };

describe('emailDeliveryFrom', () => {
  it('reads the object from an environment / appearance body or on its own', () => {
    expect(emailDeliveryFrom({ email_delivery: NO_EMAIL })).toEqual({
      available: false,
      passwordReset: false,
      passwordSignUp: false,
    });
    expect(emailDeliveryFrom({ available: false, password_reset: false, password_sign_up: true })).toEqual({
      available: false,
      passwordReset: false,
      passwordSignUp: true,
    });
  });

  it('reads an older server (no object, or missing fields) as available', () => {
    expect(emailDeliveryFrom({})).toEqual(EMAIL_DELIVERY_UNKNOWN);
    expect(emailDeliveryFrom(null)).toEqual(EMAIL_DELIVERY_UNKNOWN);
    expect(emailDeliveryFrom({ email_delivery: { available: false } })).toEqual({
      available: false,
      passwordReset: true,
      passwordSignUp: true,
    });
  });

  it('is part of the instance settings', () => {
    expect(instanceSettingsFrom({ email_delivery: NO_EMAIL }).emailDelivery.passwordReset).toBe(false);
    expect(instanceSettingsFrom({}).emailDelivery).toEqual(EMAIL_DELIVERY_UNKNOWN);
  });
});

describe('offeredFirstFactors', () => {
  it('drops email code / link only while email cannot be delivered', () => {
    const all = ['password', 'email_code', 'email_link', 'passkey'];
    expect(offeredFirstFactors(all, emailDeliveryFrom(NO_EMAIL))).toEqual(['password', 'passkey']);
    expect(offeredFirstFactors(all, EMAIL_DELIVERY_UNKNOWN)).toEqual(all);
    expect(offeredFirstFactors(all, null)).toEqual(all);
  });
});

describe('clientEnvironmentFrom / fetchClientEnvironment', () => {
  const body = {
    object: 'environment',
    first_factors: ['password', 'passkey', 3],
    strategies: { password: true, emailCode: false, oauthProviders: ['google'] },
    email_delivery: NO_EMAIL,
    social_providers: [
      { provider: 'google', native: true, mode: 'native', label: null, display_name: 'Google', icon: null, allow_sign_in: true, allow_sign_up: true, client_id: 'c' },
      { nope: true },
    ],
  };

  it('types the body', () => {
    const env = clientEnvironmentFrom(body);
    expect(env.firstFactors).toEqual(['password', 'passkey']);
    expect(env.strategies.emailCode).toBe(false);
    expect(env.emailDelivery.available).toBe(false);
    expect(env.socialProviders.map((p) => p.provider)).toEqual(['google']);
    expect(clientEnvironmentFrom(undefined)).toEqual({
      firstFactors: [],
      strategies: {},
      emailDelivery: EMAIL_DELIVERY_UNKNOWN,
      socialProviders: [],
      account: ACCOUNT_UX_DEFAULT,
    });
  });

  it('fetches GET /v1/client/environment, null on failure', async () => {
    const urls: string[] = [];
    const ok = new FapiClient({
      publishableKey: 'pk_test_x',
      baseUrl: 'https://fapi.example',
      fetchImpl: (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    expect((await fetchClientEnvironment(ok))?.emailDelivery.passwordSignUp).toBe(false);
    expect(urls).toEqual(['https://fapi.example/v1/client/environment']);

    const down = new FapiClient({
      publishableKey: 'pk_test_x',
      baseUrl: 'https://fapi.example',
      fetchImpl: (async () => Promise.reject(new TypeError('offline'))) as typeof fetch,
    });
    expect(await fetchClientEnvironment(down)).toBeNull();
  });
});

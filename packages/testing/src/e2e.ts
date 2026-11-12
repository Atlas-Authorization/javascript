/**
 * Playwright end-to-end fixtures for `@atlasauth/testing/e2e`.
 *
 * Throwaway users on a DEVELOPMENT instance (Backend API), sign-in through your
 * own pages with the testing token standing in for the captcha, TOTP codes from
 * a known secret, a WebAuthn virtual authenticator for passkeys, and automatic
 * cleanup: every user the fixture created is deleted when the test ends.
 *
 * `@playwright/test` is an optional peer: nothing here imports it. Pass
 * {@link atlasFixtures} to its `test.extend`.
 */
import { DEFAULT_API_URL } from '@atlasauth/backend';
import { setupAtlasTestingToken, type PlaywrightPage } from './playwright';
import { AtlasSignInError } from './sign-in-as';

export interface E2eConfig {
  /** A development instance secret key (`sk_test_...`). A production key is refused. */
  secretKey: string;
  /** The instance FAPI origin, to scope the testing-token interception. */
  frontendApiUrl?: string;
  /** @default `https://api.atlasauth.net` */
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  /** Base32 TOTP secret, when created with `mfa: 'totp'`. */
  totpSecret?: string;
}

export interface CreateTestUserOptions {
  email?: string;
  password?: string;
  firstName?: string;
  /** `'totp'` enrols an authenticator with a secret the test knows. */
  mfa?: 'totp';
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function base32Encode(buf: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return bits > 0 ? out + B32[(value << (5 - bits)) & 31] : out;
}

function base32Decode(s: string): Uint8Array {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/[\s=]/g, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new AtlasSignInError('Not a base32 TOTP secret.', 0);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

/** The current 6-digit TOTP code (RFC 6238, SHA-1, 30 s) for a base32 secret. */
export async function totpCode(secret: string, nowMs: number = Date.now()): Promise<string> {
  const counter = new DataView(new ArrayBuffer(8));
  counter.setBigUint64(0, BigInt(Math.floor(nowMs / 30_000)));
  const key = await globalThis.crypto.subtle.importKey('raw', base32Decode(secret) as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const h = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, counter));
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
}

function guard(config: E2eConfig): void {
  if (!config.secretKey) throw new AtlasSignInError('A secret key is required.', 0);
  if (config.secretKey.startsWith('sk_live_')) {
    throw new AtlasSignInError('The e2e fixtures only work on development instances; refusing a production secret key.', 0, 'production_refused');
  }
}

async function bapi(config: E2eConfig, method: string, path: string, body?: unknown): Promise<unknown> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl(`${(config.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '')}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.secretKey}`, 'content-type': 'application/json', accept: 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await res.json().catch(() => null)) as { errors?: Array<{ code?: string; message?: string }> } | null;
  if (!res.ok) {
    const err = data?.errors?.[0];
    throw new AtlasSignInError(`${method} ${path} failed (${res.status}${err?.code ? ` ${err.code}` : ''}): ${err?.message ?? 'unexpected response'}`, res.status, err?.code);
  }
  return data;
}

/** Create a throwaway verified user on a development instance. */
export async function createTestUser(config: E2eConfig, options: CreateTestUserOptions = {}): Promise<TestUser> {
  guard(config);
  const tag = hex(randomBytes(6));
  const email = options.email ?? `e2e+${tag}@example.com`;
  const password = options.password ?? `Pw-${b64url(randomBytes(12))}-9!`;
  const totpSecret = options.mfa === 'totp' ? base32Encode(randomBytes(20)) : undefined;
  const data = (await bapi(config, 'POST', '/v1/users', {
    email_address: email,
    password,
    email_verified: true,
    ...(options.firstName ? { first_name: options.firstName } : {}),
    ...(totpSecret ? { mfa: { totp: { secret_base32: totpSecret } } } : {}),
  })) as { id?: string } | null;
  if (typeof data?.id !== 'string') throw new AtlasSignInError('Create user returned no id.', 0);
  return { id: data.id, email, password, ...(totpSecret ? { totpSecret } : {}) };
}

/** Delete a user. Best effort by design: cleanup must not mask the test's own failure. */
export async function deleteTestUser(config: E2eConfig, userId: string): Promise<boolean> {
  try {
    await bapi(config, 'DELETE', `/v1/users/${encodeURIComponent(userId)}`);
    return true;
  } catch {
    return false;
  }
}

/** Structural subset of Playwright's `Page` used to drive a custom sign-in page. */
export interface E2ePage extends PlaywrightPage {
  goto(url: string): Promise<unknown>;
  getByLabel(label: string | RegExp): { fill(v: string): Promise<void> };
  getByRole(role: string, options?: { name?: string | RegExp }): { click(): Promise<void> };
  context(): { newCDPSession(page: unknown): Promise<{ send(method: string, params?: object): Promise<unknown> }> };
}

export interface SignInViaPageOptions {
  /** URL of your sign-in page. */
  url: string;
  user: TestUser;
  /** Accessible names on your page. */
  labels?: { email?: string | RegExp; password?: string | RegExp; code?: string | RegExp; submit?: string | RegExp };
}

/**
 * Sign in through YOUR custom page: email, password, submit, and the TOTP code
 * when the user has one. Install the testing token first (the `atlasPage`
 * fixture does) so the captcha is waived.
 */
export async function signInViaPage(page: E2ePage, options: SignInViaPageOptions): Promise<void> {
  const l = options.labels ?? {};
  await page.goto(options.url);
  await page.getByLabel(l.email ?? /email/i).fill(options.user.email);
  await page.getByLabel(l.password ?? /password/i).fill(options.user.password);
  await page.getByRole('button', { name: l.submit ?? /continue|sign in/i }).click();
  if (options.user.totpSecret) {
    await page.getByLabel(l.code ?? /code/i).fill(await totpCode(options.user.totpSecret));
    await page.getByRole('button', { name: l.submit ?? /continue|sign in|verify/i }).click();
  }
}

/**
 * Attach a CDP WebAuthn virtual authenticator (Chromium) so passkey register and
 * sign-in ceremonies complete with no hardware. Returns a remover.
 */
export async function addVirtualAuthenticator(page: E2ePage): Promise<() => Promise<void>> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = (await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })) as { authenticatorId: string };
  return async () => {
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    await cdp.send('WebAuthn.disable');
  };
}

export interface AtlasFixtures {
  /** Create a user; it is deleted when the test ends. */
  newUser(options?: CreateTestUserOptions): Promise<TestUser>;
  /** The page with the testing token installed. */
  atlasPage: E2ePage;
  /** Attach a virtual authenticator to `atlasPage`; removed when the test ends. */
  passkeyDevice(): Promise<void>;
}

/**
 * The Atlas fixtures `newUser`, `atlasPage` and `passkeyDevice`, for
 * `test.extend`.
 *
 * ```ts
 * import { test as base, expect } from '@playwright/test';
 * import { atlasFixtures, type AtlasFixtures } from '@atlasauth/testing/e2e';
 * export const test = base.extend<AtlasFixtures>(atlasFixtures({ secretKey: process.env.ATLAS_SECRET_KEY! }));
 * ```
 */
export function atlasFixtures(config: E2eConfig) {
  guard(config);
  return {
    // eslint-disable-next-line no-empty-pattern
    newUser: async ({}: object, use: (fn: AtlasFixtures['newUser']) => Promise<void>) => {
      const created: string[] = [];
      await use(async (options) => {
        const user = await createTestUser(config, options);
        created.push(user.id);
        return user;
      });
      await Promise.all(created.map((id) => deleteTestUser(config, id)));
    },
    atlasPage: async ({ page }: { page: E2ePage }, use: (p: E2ePage) => Promise<void>) => {
      await setupAtlasTestingToken({ page, secretKey: config.secretKey, frontendApiUrl: config.frontendApiUrl, apiUrl: config.apiUrl, fetchImpl: config.fetchImpl });
      await use(page);
    },
    passkeyDevice: async ({ atlasPage }: { atlasPage: E2ePage }, use: (fn: AtlasFixtures['passkeyDevice']) => Promise<void>) => {
      let remove: (() => Promise<void>) | undefined;
      await use(async () => { remove = await addVirtualAuthenticator(atlasPage); });
      await remove?.().catch(() => undefined);
    },
  };
}

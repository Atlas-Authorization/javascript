import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from '@atlasauth/js';
import { createExpoSecuritySection, createExpoSignInScreen } from './screens';
import { appleSignInProvider } from './social';

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const clientFor = (fn: (url: string, init: RequestInit) => Response) =>
  new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.test', fetchImpl: (async (u: string, i: RequestInit) => fn(u, i)) as unknown as typeof fetch });
const apple = (token: string | null) => ({ AppleAuthenticationScope: { EMAIL: 1, FULL_NAME: 0 }, signInAsync: vi.fn(async () => ({ identityToken: token })) });

describe('native sign-in providers', () => {
  it('appleSignInProvider returns the attempt as flow state, and a dismissed sheet as native_cancelled', async () => {
    const client = clientFor((u) => (u.endsWith('/id_token/nonce') ? reply({ nonce: 'n1' }) : reply({ id: 'att_1', status: 'needs_second_factor' })));
    const ok = await appleSignInProvider(apple('idt'))(client, { captcha: null });
    expect(ok.attempt).toMatchObject({ id: 'att_1', status: 'needs_second_factor' });
    const none = await appleSignInProvider(apple(null))(client, { captcha: null });
    expect(none.errors[0]).toMatchObject({ reason: 'native_cancelled' });
  });
});

describe('createExpoSignInScreen', () => {
  it('offers only the buttons it was given', () => {
    const client = clientFor(() => reply({}));
    expect(createExpoSignInScreen(client).getView().alternatives).toEqual([]);
    const screen = createExpoSignInScreen(client, { apple: apple('x'), google: { signIn: vi.fn() }, passkey: { signIn: vi.fn() } });
    expect(screen.getView().alternatives).toEqual(['passkey', 'apple', 'google']);
  });
});

describe('createExpoSecuritySection', () => {
  it('loads a section on the provider client', async () => {
    const client = clientFor(() => reply({ data: [{ id: 'pk1', name: 'iPhone', backed_up: true, last_used_at: null, created_at: 1 }] }));
    const section = createExpoSecuritySection(client, 'passkeys');
    await new Promise((r) => setTimeout(r, 0));
    expect(section.getView().items).toEqual([expect.objectContaining({ id: 'pk1', label: 'iPhone' })]);
  });
});

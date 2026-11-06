import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { ATLAS_KEY, createAtlasClient } from '../lib/context';
import SignIn from '../lib/components/SignIn.svelte';

/**
 * A held password's refusal (`password_not_yet_usable`) offers the emailed proof even
 * where email code sign-in is off; it goes through the sign-up verification routes,
 * and proving it brings the password back with the "you can sign in" message.
 */
vi.mock('@atlasauth/js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@atlasauth/js')>();
  return { ...actual, readRedirectResult: () => null };
});

const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<SignIn> password hold', () => {
  it('offers the emailed proof after the refusal, and proving it brings the password back', async () => {
    const posts: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === 'POST') posts.push(path);
      if (path === '/v1/client') return json({ session: null, user: null });
      if (path === '/v1/client/sign_ins') {
        return json({ id: 'sia_1', status: 'needs_first_factor', identifier: 'held@example.com', supported_first_factors: ['password'] }, 201);
      }
      if (path === '/v1/client/sign_ins/sia_1/attempt_first_factor') {
        return json({ errors: [{ code: 'password_not_yet_usable', message: 'Verify your email first.', meta: { verification_attempt_id: 'sua_9' } }] }, 403);
      }
      if (path === '/v1/client/sign_ups/sua_9/prepare_verification') return json({ identifier: 'held@example.com' });
      return json({});
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const client = createAtlasClient({ publishableKey: 'pk_test_x', frontendApi: FAPI, fetchImpl, manualBoot: true });
    const el = render(SignIn, { context: new Map([[ATLAS_KEY, client]]) }).container as HTMLElement;
    await client.reload(); // the session check answers (signed out) before the form draws
    const input = (name: string) => el.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
    const send = async (name: string, value: string) => {
      await fireEvent.input(input(name)!, { target: { value } });
      await fireEvent.submit(el.querySelector('form')!);
    };

    await waitFor(() => expect(input('identifier')).not.toBeNull());
    await send('identifier', 'held@example.com');
    await waitFor(() => expect(input('password')).not.toBeNull());
    expect(el.querySelector('[data-strategy="email_code"]')).toBeNull();

    await send('password', 'the-right-password');
    await waitFor(() => expect(el.querySelector('[data-strategy="email_code"]')).not.toBeNull());

    await fireEvent.click(el.querySelector('[data-strategy="email_code"]')!);
    await waitFor(() => expect(posts).toContain('/v1/client/sign_ups/sua_9/prepare_verification'));
    expect(posts).not.toContain('/v1/client/sign_ins/sia_1/prepare_first_factor');

    await waitFor(() => expect(input('code')).not.toBeNull());
    await send('code', '123456');
    await waitFor(() => expect(posts).toContain('/v1/client/sign_ups/sua_9/attempt_verification'));
    await waitFor(() => expect(el.querySelector('[data-atlas-password-released]')).not.toBeNull());
    expect(input('password')).not.toBeNull();
  });
});

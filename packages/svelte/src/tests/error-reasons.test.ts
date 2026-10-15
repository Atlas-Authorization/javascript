import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { ATLAS_KEY, createAtlasClient } from '../lib/context';
import { EN_US, type Catalog } from '../lib/i18n';
import SignIn from '../lib/components/SignIn.svelte';

/**
 * Server form errors render in the app's language: the catalog's
 * `error.<reason>` beats the server's English `message`, and the bundle's
 * locale goes to the server as `Accept-Language`.
 */
vi.mock('@atlasauth/js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@atlasauth/js')>();
  return { ...actual, readRedirectResult: () => null };
});

const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ES: Catalog = {
  locale: 'es-ES',
  'error.form_password_incorrect': 'Esas credenciales son incorrectas.',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

async function refusedSignIn(error: Record<string, unknown>, localization?: Catalog) {
  const headers: Record<string, string>[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/client') return json({ session: null, user: null });
    if (path === '/v1/client/sign_ins') {
      headers.push({ ...((init?.headers as Record<string, string>) ?? {}) });
      return json({ errors: [error] }, 400);
    }
    return json({});
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  const client = createAtlasClient({ publishableKey: 'pk_test_x', frontendApi: FAPI, fetchImpl, manualBoot: true, localization });
  const view = render(SignIn, { context: new Map([[ATLAS_KEY, client]]) });
  const el = view.container as HTMLElement;
  const input = el.querySelector('input[name="identifier"]') as HTMLInputElement;
  await fireEvent.input(input, { target: { value: 'me@example.com' } });
  await fireEvent.submit(el.querySelector('form')!);
  await waitFor(() => expect(el.querySelector('.atlas-error')).not.toBeNull());
  const text = [...el.querySelectorAll('.atlas-error')].map((n) => n.textContent).join(' | ');
  return { text, headers };
}

describe('server errors by reason', () => {
  it('renders the English catalog string with no localization', async () => {
    const { text, headers } = await refusedSignIn({
      code: 'VERIFICATION_FAILED',
      message: 'Server sentence.',
      reason: 'form_password_incorrect',
    });
    expect(text).toBe(EN_US['error.form_password_incorrect']);
    expect(headers[0]!['accept-language']).toBeUndefined();
  });

  it('renders the Spanish catalog string under a Spanish bundle and sends Accept-Language', async () => {
    const { text, headers } = await refusedSignIn(
      { code: 'VERIFICATION_FAILED', message: 'Those credentials are incorrect.', reason: 'form_password_incorrect' },
      ES,
    );
    expect(text).toBe('Esas credenciales son incorrectas.');
    expect(headers[0]!['accept-language']).toBe('es-ES');
  });

  it('falls back to the server message for an unknown reason', async () => {
    const { text } = await refusedSignIn({ code: 'X', message: 'Mensaje del servidor.', reason: 'brand_new' }, ES);
    expect(text).toBe('Mensaje del servidor.');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@solidjs/testing-library';
import { h } from './h';
import { AtlasProvider } from './provider';
import { SignIn } from './widgets';

/**
 * Server form errors render in the app's language: with a `localization`
 * bundle the widget shows its `error.<reason>` string instead of the server's
 * English `message`, and sends the language as `Accept-Language`.
 */

const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ES = { locale: 'es-ES', 'error.form_password_incorrect': 'Esas credenciales son incorrectas.' };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function refusedSignIn(error: Record<string, unknown>, props: Record<string, unknown> = {}) {
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
  const { container } = render(() =>
    h(AtlasProvider, { publishableKey: 'pk_test_x', frontendApi: FAPI, fetchImpl, ...props }, h(SignIn, {})),
  );
  const el = container as HTMLElement;
  await vi.waitFor(() => expect(el.querySelector('input[name="identifier"]')).not.toBeNull());
  (el.querySelector('input[name="identifier"]') as HTMLInputElement).value = 'me@example.com';
  el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(el.querySelector('.atlas-error')).not.toBeNull());
  const text = [...el.querySelectorAll('.atlas-error')].map((n) => n.textContent).join(' | ');
  return { text, headers };
}

describe('server errors by reason', () => {
  it('shows the server message (English) with no localization, and sends no Accept-Language', async () => {
    const { text, headers } = await refusedSignIn({
      code: 'VERIFICATION_FAILED',
      message: 'Those credentials are incorrect.',
      reason: 'form_password_incorrect',
    });
    expect(text).toBe('Those credentials are incorrect.');
    expect(headers[0]!['accept-language']).toBeUndefined();
  });

  it('shows the Spanish string with a Spanish bundle and sends its locale', async () => {
    const { text, headers } = await refusedSignIn(
      { code: 'VERIFICATION_FAILED', message: 'Those credentials are incorrect.', reason: 'form_password_incorrect' },
      { localization: ES },
    );
    expect(text).toBe('Esas credenciales son incorrectas.');
    expect(headers[0]!['accept-language']).toBe('es-ES');
  });

  it('falls back to the server message for an unknown reason; `locale` overrides the bundle tag', async () => {
    const { text, headers } = await refusedSignIn(
      { code: 'X', message: 'Mensaje del servidor.', reason: 'brand_new' },
      { localization: ES, locale: 'es-MX' },
    );
    expect(text).toBe('Mensaje del servidor.');
    expect(headers[0]!['accept-language']).toBe('es-MX');
  });
});

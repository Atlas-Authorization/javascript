import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { AtlasProvider } from '@atlasauth/react';
import { Field } from './primitives';
import * as SignIn from './sign-in';

/**
 * Server errors in the app's language: under `<AtlasProvider locale="es">` the
 * flow's errors (and `<Field.Error>`) carry the catalog's `error.<reason>`
 * text instead of the server's English `message`, and the sign-in request
 * carries `Accept-Language`.
 */

const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function refusedSignIn(error: Record<string, unknown>, locale?: string) {
  const headers: Record<string, string>[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/client') return json({ session: null, user: null });
    if (path === '/v1/appearance') return json({ object: 'appearance', appearance: {}, captchaFlows: {} });
    if (path === '/v1/client/sign_ins') {
      headers.push({ ...((init?.headers as Record<string, string>) ?? {}) });
      return json({ errors: [error] }, 400);
    }
    return json({});
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <AtlasProvider
        publishableKey="pk_test_x"
        frontendApi={FAPI}
        fetchImpl={fetchImpl}
        appearance={{ instanceDesign: false }}
        {...(locale ? { locale } : {})}
      >
        <SignIn.Root>
          {(flow) => (
            <>
              {flow.errors
                .filter((e) => !e.param)
                .map((e) => (
                  <p key={e.code} className="form-error">
                    {e.message}
                  </p>
                ))}
              <SignIn.Step name="start">
                <Field name="identifier">
                  <Field.Input />
                  <Field.Error className="field-error" />
                </Field>
                <SignIn.Action action="submit">Continue</SignIn.Action>
              </SignIn.Step>
            </>
          )}
        </SignIn.Root>
      </AtlasProvider>,
    );
  });
  const el = view.container as HTMLElement;
  fireEvent.change(el.querySelector('input[name="identifier"]')!, { target: { value: 'me@example.com' } });
  await act(async () => {
    fireEvent.click(el.querySelector('button')!);
  });
  await vi.waitFor(() => expect(el.querySelector('.form-error, .field-error')).not.toBeNull());
  return { el, headers };
}

describe('Elements server errors by reason', () => {
  it('a form error renders the Spanish catalog string and sends Accept-Language', async () => {
    const { el, headers } = await refusedSignIn(
      { code: 'VERIFICATION_FAILED', message: 'Those credentials are incorrect.', reason: 'form_password_incorrect' },
      'es',
    );
    expect(el.querySelector('.form-error')!.textContent).toBe('Esas credenciales son incorrectas.');
    expect(headers[0]!['accept-language']).toBe('es');
  });

  it('<Field.Error> renders the localised text', async () => {
    const { el } = await refusedSignIn(
      { code: 'RATE', message: 'Too many failed attempts. Try again later.', reason: 'too_many_attempts', param: 'identifier' },
      'es',
    );
    expect(el.querySelector('.field-error')!.textContent).toBe('Demasiados intentos fallidos. Inténtalo de nuevo más tarde.');
  });

  it('an unknown reason falls back to the server message', async () => {
    const { el } = await refusedSignIn({ code: 'X', message: 'Mensaje del servidor.', reason: 'brand_new' }, 'es');
    expect(el.querySelector('.form-error')!.textContent).toBe('Mensaje del servidor.');
  });
});

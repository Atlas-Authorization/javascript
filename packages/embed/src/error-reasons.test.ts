// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasWidget } from './widget';
import { optionsFromElement } from './config';
import type { AppearanceResponse, PublicAppearance } from './appearance';

/**
 * Server form errors render in the app's language: with a `localization`
 * bundle the widget shows its `error.<reason>` string instead of the server's
 * English `message`, and `locale` reaches the server as `Accept-Language`.
 */

const BASE_APPEARANCE: PublicAppearance = {
  applicationName: 'Acme',
  logoUrl: null,
  colorPrimary: '#5b5bd6',
  colorBackground: '#ffffff',
  colorText: '#1c1c1f',
  colorAccent: '#5b5bd6',
  colorCard: '#ffffff',
  colorBorder: '#e4e4e9',
  borderRadius: '10px',
  theme: 'light',
  fontStack: 'system-ui',
  layout: 'centered',
  headline: null,
  subheadline: null,
  footer: null,
  providerOrder: [],
  providerHidden: [],
};

const envelope = (providers: string[]): AppearanceResponse => ({
  object: 'appearance',
  appearance: BASE_APPEARANCE,
  providers,
  strategies: {
    password: true,
    emailCode: true,
    emailLink: true,
    passkey: false,
    phoneCode: false,
    siwe: false,
  },
});

const OPTS = { publishableKey: 'pk_test_1', frontendApi: 'https://accounts.acme.com' };
const ES = { locale: 'es-ES', 'error.form_password_incorrect': 'Esas credenciales son incorrectas.' };

afterEach(() => {
  document.body.innerHTML = '';
});

const flush = async (times = 6): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
};

async function refusedSignIn(error: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const headers: Record<string, string>[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    let status = 200;
    let body: unknown = {};
    if (method === 'GET' && url.pathname === '/v1/appearance') {
      body = envelope([]);
    } else if (method === 'POST' && url.pathname === '/v1/client/sign_ins') {
      headers.push({ ...((init?.headers as Record<string, string>) ?? {}) });
      status = 400;
      body = { errors: [error] };
    }
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const root = document.createElement('div');
  document.body.appendChild(root);
  await new AtlasWidget(root, { ...OPTS, fetchImpl: impl, ...extra }).mount();
  (root.querySelector('input[name="identifier"]') as HTMLInputElement).value = 'ada@example.com';
  root.querySelector('form')!.dispatchEvent(new Event('submit'));
  await flush();
  const text = [...root.querySelectorAll('.atlas-embed-form-error, .atlas-embed-error')]
    .map((n) => n.textContent)
    .join(' | ');
  return { text, headers };
}

describe('server errors by reason', () => {
  it('shows the server message with no localization, and sends no Accept-Language', async () => {
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

  it('falls back to the server message for an unknown reason; `locale` wins over the bundle tag', async () => {
    const { text, headers } = await refusedSignIn(
      { code: 'X', message: 'Mensaje del servidor.', reason: 'brand_new' },
      { localization: ES, locale: 'es' },
    );
    expect(text).toBe('Mensaje del servidor.');
    expect(headers[0]!['accept-language']).toBe('es');
  });
});

describe('locale from markup', () => {
  it('reads data-atlas-locale / locale', () => {
    const el = document.createElement('atlas-sign-in');
    el.setAttribute('data-atlas-key', 'pk_test_1');
    el.setAttribute('data-atlas-fapi', 'https://accounts.acme.com');
    el.setAttribute('data-atlas-locale', 'fr');
    expect(optionsFromElement(el, 'sign-in')?.locale).toBe('fr');
    el.removeAttribute('data-atlas-locale');
    el.setAttribute('locale', 'de-DE');
    expect(optionsFromElement(el, 'sign-in')?.locale).toBe('de-DE');
  });
});

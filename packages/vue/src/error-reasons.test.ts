import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, shallowRef, type App } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ATLAS_INJECTION_KEY, useAtlas } from './context';
import { createAtlas, type AtlasClient, type AuthStatus } from './plugin';
import { SignIn } from './components';
import { EN_US, withFallback, type Catalog } from './i18n';
import type { AtlasOrganizationMembership, AtlasSession, AtlasUser, SessionClaims } from './types';

/**
 * Server form errors render in the app's language: the catalog's
 * `error.<reason>` beats the server's English `message`, and the bundle's
 * locale goes to the server as `Accept-Language`.
 */

const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ES: Catalog = {
  locale: 'es-ES',
  'error.form_password_incorrect': 'Esas credenciales son incorrectas.',
  'error.form_password_too_short': 'La contraseña debe tener al menos {min_length} caracteres.',
};

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

function makeClient(language?: Catalog): AtlasClient {
  return {
    publishableKey: 'pk_test_x',
    frontendApi: FAPI,
    appearance: undefined,
    catalog: language ? withFallback(language) : EN_US,
    errorCatalog: language ?? EN_US,
    locale: language?.locale,
    status: shallowRef<AuthStatus>('signed_out'),
    user: shallowRef<AtlasUser | null>(null),
    session: shallowRef<AtlasSession | null>(null),
    claims: shallowRef<SessionClaims | null>(null),
    memberships: shallowRef<AtlasOrganizationMembership[]>([]),
    pendingAttempt: null,
    getToken: async () => null,
    getProviderToken: async () => null,
    signOut: async () => ({ revoked: true }),
    setActiveOrganization: async () => undefined,
    reload: async () => undefined,
  };
}

async function flush() {
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
    await nextTick();
  }
}

async function refusedSignIn(error: Record<string, unknown>, language?: Catalog) {
  const headers: Record<string, string>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/client/sign_ins') {
        headers.push({ ...((init?.headers as Record<string, string>) ?? {}) });
        return json({ errors: [error] }, 400);
      }
      return json({});
    }),
  );
  const client = makeClient(language);
  const Host = defineComponent({ setup: () => () => h(SignIn) });
  wrapper = mount(Host, {
    attachTo: document.body,
    global: { plugins: [{ install: (app: App) => app.provide(ATLAS_INJECTION_KEY, client) }] },
  });
  await flush();
  await wrapper.find('input[name="identifier"]').setValue('someone@example.com');
  await wrapper.find('form').trigger('submit');
  await vi.waitFor(() => expect(wrapper!.find('.atlas-error').exists()).toBe(true));
  return { text: wrapper.findAll('.atlas-error').map((n) => n.text()).join(' | '), headers };
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

  it('fills placeholders from meta', async () => {
    const { text } = await refusedSignIn(
      { code: 'PASSWORD_POLICY', message: 'x', reason: 'form_password_too_short', meta: { min_length: 10 } },
      ES,
    );
    expect(text).toBe('La contraseña debe tener al menos 10 caracteres.');
  });

  it('falls back to the server message for an unknown reason, or one the bundle lacks', async () => {
    expect((await refusedSignIn({ code: 'X', message: 'Mensaje del servidor.', reason: 'brand_new' }, ES)).text).toBe(
      'Mensaje del servidor.',
    );
    wrapper?.unmount();
    expect(
      (await refusedSignIn({ code: 'X', message: 'Demasiados intentos.', reason: 'too_many_attempts' }, ES)).text,
    ).toBe('Demasiados intentos.');
  });
});

describe('createAtlas', () => {
  it('derives the error catalog and Accept-Language locale from `localization`', () => {
    let seen: AtlasClient | null = null;
    const Probe = defineComponent({
      setup: () => {
        seen = useAtlas();
        return () => null;
      },
    });
    const fetchImpl = vi.fn(async () => json({ session: null, user: null }));
    wrapper = mount(Probe, {
      global: {
        plugins: [
          createAtlas({
            publishableKey: 'pk_test',
            frontendApi: FAPI,
            localization: ES,
            fetchImpl: fetchImpl as unknown as typeof fetch,
          }),
        ],
      },
    });
    expect(seen!.locale).toBe('es-ES');
    expect(seen!.errorCatalog).toBe(ES);
  });
});

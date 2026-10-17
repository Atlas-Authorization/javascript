// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDesign } from '@atlasauth/design';
import { AtlasProvider } from './AtlasProvider';
import { SignIn } from './sign-in';
import type { InstanceDesign } from './appearance';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `<AtlasProvider initialState>`: the instance's public sign-in data fetched on
 * the server. The panel is then styled and has its social buttons in the server
 * HTML, and the browser does not request that data again. Without it, the
 * environment is fetched once for the whole provider, not once per button.
 */

const FAPI = 'https://fapi.example';

const design: InstanceDesign = {
  scope: '.atlas-root',
  css: '.atlas-root{--atlas-color-primary:#123456;}',
  data_attributes: {},
  font_stylesheets: [],
  resolved: resolveDesign({ preset: 'forest' }),
};

const appearance = {
  object: 'appearance',
  appearance: { legal: { termsUrl: null, privacyUrl: null, required: false }, signUpFields: [] },
  captchaFlows: {},
  email_delivery: { available: true, password_reset: true, password_sign_up: true },
  design,
};

const environment = {
  first_factors: ['password'],
  strategies: { password: true },
  email_delivery: { available: true, password_reset: true, password_sign_up: true },
  social_providers: [
    {
      provider: 'github',
      native: false,
      mode: 'redirect',
      label: null,
      display_name: 'GitHub',
      icon: null,
      allow_sign_in: true,
      allow_sign_up: true,
    },
    {
      provider: 'google',
      native: true,
      mode: 'native',
      label: null,
      display_name: 'Google',
      icon: null,
      allow_sign_in: true,
      allow_sign_up: true,
      client_id: 'google-client.apps.googleusercontent.com',
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch() {
  const paths: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path === '/v1/client') return json({ session: null, user: null });
    if (path === '/v1/appearance') return json(appearance);
    if (path === '/v1/client/environment') return json(environment);
    return json({});
  }) as unknown as typeof fetch;
  return { impl, paths };
}

function props(fetchImpl: typeof fetch, initialState?: ComponentProps<typeof AtlasProvider>['initialState']) {
  const p: ComponentProps<typeof AtlasProvider> = {
    publishableKey: 'pk_test_x',
    frontendApi: FAPI,
    fetchImpl,
    children: createElement(SignIn),
  };
  if (initialState) p.initialState = initialState;
  return p;
}

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
});

async function mount(p: ComponentProps<typeof AtlasProvider>) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(createElement(AtlasProvider, p));
  });
  unmount = () => act(() => root.unmount());
  return el;
}

describe('server render with initialState', () => {
  it('puts the dashboard design, the social buttons and the connection hints in the server HTML', () => {
    const { impl, paths } = fakeFetch();
    const html = renderToString(createElement(AtlasProvider, props(impl, { appearance, environment })));

    // The dashboard design's stylesheet and the GitHub button are server-rendered.
    expect(html).toContain('<style data-atlas-design=');
    expect(html).toContain('data-atlas-provider="github"');
    expect(html).toContain(`<link rel="preconnect" href="${FAPI}" crossorigin="use-credentials"/>`);
    expect(html).toContain('<link rel="preload" as="script" href="https://accounts.google.com/gsi/client"/>');
    // Rendering fetched nothing.
    expect(paths).toEqual([]);
  });

  it('without it the server HTML has the bare panel and no Google preload', () => {
    const { impl } = fakeFetch();
    const html = renderToString(createElement(AtlasProvider, props(impl)));
    expect(html).not.toContain('<style data-atlas-design=');
    expect(html).not.toContain('data-atlas-provider="github"');
    expect(html).not.toContain('accounts.google.com/gsi/client');
    expect(html).toContain('rel="preconnect"');
  });
});

describe('in the browser', () => {
  it('with initialState, does not request the appearance or environment again', async () => {
    const { impl, paths } = fakeFetch();
    vi.stubGlobal('fetch', impl);
    const el = await mount(props(impl, { appearance, environment }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(el.querySelector('[data-atlas-provider="github"]')).not.toBeNull();
    expect(paths).not.toContain('/v1/appearance');
    expect(paths).not.toContain('/v1/client/environment');
  });

  it('without it, fetches the appearance once and the environment once for every button', async () => {
    const { impl, paths } = fakeFetch();
    vi.stubGlobal('fetch', impl);
    const el = await mount(props(impl));
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-provider="github"]')).not.toBeNull());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(paths.filter((p) => p === '/v1/appearance')).toHaveLength(1);
    expect(paths.filter((p) => p === '/v1/client/environment')).toHaveLength(1);
  });
});

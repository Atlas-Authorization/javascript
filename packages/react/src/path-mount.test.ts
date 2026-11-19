// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider, useAtlas } from './AtlasProvider';
import { SignIn } from './sign-in';
import { resolveGlobalTokenOptions, setIntegrations } from './active-atlas';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.unstubAllGlobals();
  setIntegrations(null);
  document.body.innerHTML = '';
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function Key() {
  return createElement('p', { id: 'key' }, useAtlas().publishableKey);
}

async function mount(props: Record<string, unknown>, children: unknown) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(AtlasProvider, { ...props, children } as never));
  });
  return host;
}

describe('<AtlasProvider> without a publishable key on a path mount', () => {
  it('asks the mounted Frontend API which instance it serves and goes live with that key', async () => {
    const calls: { url: string; key: string | null }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, key: new Headers(init?.headers).get('x-publishable-key') });
      if (url === '/atlas/v1/environment') return json({ publishable_key: 'pk_test_abc', first_factors: ['password'] });
      return json({ session: null, user: null });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const host = await mount({ frontendApi: '/atlas' }, createElement(Key));
    await vi.waitFor(() => expect(host.querySelector('#key')?.textContent).toBe('pk_test_abc'));
    expect(calls[0]).toEqual({ url: '/atlas/v1/environment', key: null });
  });

  it('stays inert when the mount does not say, and for an absolute Frontend API with no path', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => json({}, 404));
    vi.stubGlobal('fetch', fetchImpl);
    const host = await mount({ frontendApi: '/atlas' }, createElement(Key));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(host.querySelector('#key')?.textContent).toBe('');
    fetchImpl.mockClear();
    await mount({ frontendApi: 'https://fapi.example' }, createElement(Key));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('<SignIn> links to the sign-up page under the mount, resolved against the page origin', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/v1/environment') || url.endsWith('/v1/client/environment')) {
          return json({ publishable_key: 'pk_test_abc', first_factors: ['password'] });
        }
        return json({ session: null, user: null });
      }),
    );
    const host = await mount({ frontendApi: '/atlas' }, createElement(SignIn));
    await vi.waitFor(() => expect(host.querySelector('[data-atlas-sign-up-prompt] a')).not.toBeNull());
    const href = host.querySelector('[data-atlas-sign-up-prompt] a')!.getAttribute('href')!;
    expect(href.startsWith(`${window.location.origin}/atlas/hosted/sign-up`)).toBe(true);
  });
});

describe('<SignIn> with no identifier-first method', () => {
  it('draws no identifier box when only passkey / social first factors are on', async () => {
    let served = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (!String(input).endsWith('/v1/client/environment')) return json({ session: null, user: null });
        served = true;
        return json({ first_factors: ['passkey'], social_providers: [] });
      }),
    );
    const host = await mount({ publishableKey: 'pk_test_abc', frontendApi: 'https://fapi.example' }, createElement(Fragment, null, createElement(SignIn)));
    await vi.waitFor(() => expect(host.querySelector('[data-atlas-sign-up-prompt]')).not.toBeNull());
    await vi.waitFor(() => expect(served).toBe(true));
    await act(async () => {});
    expect(host.querySelector('input[name="identifier"]')).toBeNull();
  });
});

describe('integrations allow-list for window.Atlas.session.getToken', () => {
  it('is open without a list, closed to unlisted ids with one, and merges per-integration defaults', () => {
    expect(resolveGlobalTokenOptions({ for: 'anything' })).toEqual({ for: 'anything' });
    setIntegrations(['chatly', { for: 'forumulate', spaceId: 'sp_1' }]);
    expect(resolveGlobalTokenOptions({ for: 'chatly' })).toEqual({ for: 'chatly' });
    expect(resolveGlobalTokenOptions({ for: 'forumulate' })).toEqual({ for: 'forumulate', spaceId: 'sp_1' });
    expect(resolveGlobalTokenOptions({ for: 'forumulate', spaceId: 'sp_2' })).toEqual({ for: 'forumulate', spaceId: 'sp_2' });
    expect(resolveGlobalTokenOptions({ for: 'other' })).toBeNull();
    expect(resolveGlobalTokenOptions(undefined)).toBeUndefined();
  });
});

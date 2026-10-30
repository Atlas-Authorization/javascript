// @vitest-environment happy-dom
import { act, createElement, type ChangeEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider } from './AtlasProvider';
import { ApiKeys, type ApiKeysProps } from './api-keys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `<ApiKeys/>` drives `/v1/client/me/api_keys`: it lists, creates (parking for a
 * password re-authentication when the server answers STEP_UP_REQUIRED), shows
 * the new secret once, and revokes only after a confirmation step.
 */

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const JWT = `${b64({ alg: 'none' })}.${b64({ sid: 'sess_1', sub: 'user_1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const KEY = {
  object: 'api_key',
  id: 'eak_1',
  subject_type: 'user',
  subject_id: 'user_1',
  name: 'Laptop',
  prefix: 'ak_0123',
  claims: {},
  scopes: null,
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
  created_at: 1,
};

type Route = (url: string, init: RequestInit) => Response | undefined;

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mount(route: Route, props: ApiKeysProps = {}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/v1/client')) {
      return json({ session: { id: 'sess_1', status: 'active' }, user: { id: 'user_1' }, jwt: JWT });
    }
    return route(url, init) ?? json({});
  }) as unknown as typeof fetch;
  // The account components' FAPI client and reauthenticate() use the global fetch.
  vi.stubGlobal('fetch', fetchImpl);

  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      createElement(AtlasProvider, {
        publishableKey: 'pk_test_x',
        frontendApi: 'https://fapi.example',
        fetchImpl,
        appearance: { instanceDesign: false },
        children: createElement(ApiKeys, props),
      }),
    );
  });
  unmount = () => act(() => root.unmount());
  return { el, calls };
}

const button = (el: HTMLElement, label: string) => {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button "${label}" in: ${el.innerHTML}`);
  return found;
};

async function click(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const listBody = (data: unknown[], extra: Record<string, unknown> = {}) => ({
  object: 'list',
  data,
  has_more: false,
  allowed_scopes: [],
  allowed_claims: [],
  max_active_keys: 10,
  active_count: data.length,
  ...extra,
});

describe('<ApiKeys/>', () => {
  it('lists keys, creates one with slot claims, and shows the secret once', async () => {
    let keys: unknown[] = [KEY];
    const onCreate = vi.fn();
    const { el, calls } = await mount(
      (url, init) => {
        if (url.endsWith('/v1/client/me/api_keys') && init.method === 'POST') {
          const created = { ...KEY, id: 'eak_2', name: 'CI', claims: { spend_limit: 25 } };
          keys = [created, KEY];
          return json({ ...created, secret: 'ak_0456_supersecret' }, 201);
        }
        if (url.endsWith('/v1/client/me/api_keys')) {
          return json(listBody(keys, { allowed_claims: ['spend_limit'], allowed_scopes: ['reports:read'] }));
        }
        return undefined;
      },
      {
        onCreate,
        renderClaimsFields: ({ setClaim }) =>
          createElement('input', {
            name: 'spend',
            onChange: (e: ChangeEvent<HTMLInputElement>) => setClaim('spend_limit', Number(e.target.value)),
          }),
      },
    );
    await vi.waitFor(() => expect(el.querySelectorAll('[data-atlas="api-key"]')).toHaveLength(1));
    expect(el.textContent).toContain('Laptop');

    await click(button(el, 'Create key'));
    const form = el.querySelector('[data-atlas="api-key-create"]') as HTMLElement;
    await type(form.querySelector('input') as HTMLInputElement, 'CI');
    await type(el.querySelector('input[name="spend"]') as HTMLInputElement, '25');
    await act(async () => {
      (form.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    });
    await click(button(form, 'Create key'));

    await vi.waitFor(() => expect(el.querySelector('[data-atlas="api-key-secret-value"]')?.textContent).toBe('ak_0456_supersecret'));
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/client/me/api_keys'))!;
    expect(post.body).toEqual({ name: 'CI', scopes: ['reports:read'], claims: { spend_limit: 25 } });
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ id: 'eak_2', secret: 'ak_0456_supersecret' }));
    await vi.waitFor(() => expect(el.querySelectorAll('[data-atlas="api-key"]')).toHaveLength(2));

    // Dismissed, the secret is gone for good.
    await click(button(el, 'Done'));
    expect(el.textContent).not.toContain('ak_0456_supersecret');
  });

  it('lays read/write scopes out as a grid and locks the scopes a ticked one implies', async () => {
    const { el, calls } = await mount((url, init) => {
      if (url.endsWith('/v1/client/me/api_keys') && init.method === 'POST') {
        return json({ ...KEY, id: 'eak_3', secret: 'ak_0789_grid' }, 201);
      }
      if (url.endsWith('/v1/client/me/api_keys')) {
        return json(
          listBody([], {
            allowed_scopes: ['calls:read', 'calls:write', 'leads:read', 'leads:write', 'admin'],
            scope_implications: { 'calls:write': ['calls:read'], admin: ['*'] },
          }),
        );
      }
      return undefined;
    });
    await vi.waitFor(() => expect(el.querySelector('[data-atlas="api-keys-empty"]')).not.toBeNull());
    await click(button(el, 'Create key'));
    const grid = el.querySelector('[data-atlas="api-key-scope-grid"]') as HTMLElement;
    expect(grid.querySelectorAll('tbody tr')).toHaveLength(2);
    const box = (scope: string) => el.querySelector(`[data-atlas-scope="${scope}"]`) as HTMLInputElement;

    await act(async () => box('calls:write').click());
    expect(box('calls:read').checked).toBe(true);
    expect(box('calls:read').disabled).toBe(true);
    expect(box('leads:read').checked).toBe(false);

    await act(async () => box('admin').click());
    expect(box('leads:write').checked && box('leads:write').disabled).toBe(true);
    await act(async () => box('admin').click());
    expect(box('leads:write').checked).toBe(false);

    await click(button(el.querySelector('[data-atlas="api-key-create"]') as HTMLElement, 'Create key'));
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/client/me/api_keys'))!;
    // Only the explicitly chosen scope is sent; the implied one comes from the instance.
    expect(post.body).toEqual({ scopes: ['calls:write'] });
  });

  it('prompts for the password on STEP_UP_REQUIRED, then finishes the create', async () => {
    let stepped = false;
    const { el, calls } = await mount((url, init) => {
      if (url.endsWith('/v1/client/me/reauthenticate')) {
        stepped = true;
        return json({ object: 'client', reauthenticated: true });
      }
      if (url.endsWith('/v1/client/me/api_keys') && init.method === 'POST') {
        return stepped
          ? json({ ...KEY, id: 'eak_9', secret: 'ak_0999_fresh' }, 201)
          : json({ errors: [{ code: 'STEP_UP_REQUIRED', message: 'Re-authenticate.' }] }, 403);
      }
      if (url.endsWith('/v1/client/me/api_keys')) return json(listBody([]));
      return undefined;
    });
    await vi.waitFor(() => expect(el.querySelector('[data-atlas="api-keys-empty"]')).not.toBeNull());

    await click(button(el, 'Create key'));
    await click(button(el.querySelector('[data-atlas="api-key-create"]') as HTMLElement, 'Create key'));

    const prompt = await vi.waitFor(() => {
      const found = el.querySelector('[data-atlas="api-keys-reverification"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await type(prompt.querySelector('input[type="password"]') as HTMLInputElement, 'hunter2');
    await click(button(prompt, 'Confirm'));

    await vi.waitFor(() => expect(el.querySelector('[data-atlas="api-key-secret-value"]')?.textContent).toBe('ak_0999_fresh'));
    const reauth = calls.find((c) => c.url.endsWith('/v1/client/me/reauthenticate'))!;
    expect(reauth.body).toEqual({ strategy: 'password', password: 'hunter2' });
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/v1/client/me/api_keys'))).toHaveLength(2);
    expect(el.querySelector('[data-atlas="api-keys-reverification"]')).toBeNull();
  });

  it('revokes only after confirmation', async () => {
    let revoked = false;
    const { el, calls } = await mount((url) => {
      if (url.endsWith('/v1/client/me/api_keys/eak_1/revoke')) {
        revoked = true;
        return json({ object: 'api_key', id: 'eak_1', revoked: true });
      }
      if (url.endsWith('/v1/client/me/api_keys')) {
        return json(listBody([revoked ? { ...KEY, revoked_at: 2 } : KEY]));
      }
      return undefined;
    });
    await vi.waitFor(() => expect(el.querySelectorAll('[data-atlas="api-key"]')).toHaveLength(1));

    await click(button(el, 'Revoke'));
    expect(el.querySelector('[data-atlas="api-key-revoke-confirm"]')).not.toBeNull();
    expect(calls.some((c) => c.url.endsWith('/revoke'))).toBe(false);

    await click(button(el, 'Yes, revoke'));
    await vi.waitFor(() => expect(el.textContent).toContain('Revoked'));
    expect(calls.filter((c) => c.url.endsWith('/eak_1/revoke'))).toHaveLength(1);
  });

  it('renames a key', async () => {
    const { el, calls } = await mount((url, init) => {
      if (url.endsWith('/v1/client/me/api_keys/eak_1') && init.method === 'PATCH') return json({ ...KEY, name: 'Desk' });
      if (url.endsWith('/v1/client/me/api_keys')) return json(listBody([KEY]));
      return undefined;
    });
    await vi.waitFor(() => expect(el.querySelectorAll('[data-atlas="api-key"]')).toHaveLength(1));
    await click(button(el, 'Rename'));
    await type(el.querySelector('[data-atlas="api-key"] input') as HTMLInputElement, 'Desk');
    await click(button(el, 'Save'));
    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'Desk' }),
    );
  });

  it('shows limits when the key carries them, and the cap message at the limit', async () => {
    const { el } = await mount((url) =>
      url.endsWith('/v1/client/me/api_keys')
        ? json(listBody([{ ...KEY, limits: { monthly_requests: 1000 } }], { max_active_keys: 1, active_count: 1 }))
        : undefined,
    );
    await vi.waitFor(() => expect(el.querySelector('[data-atlas="api-key-limits"]')?.textContent).toContain('monthly_requests 1000'));
    expect(el.querySelector('[data-atlas="api-keys-limit"]')).not.toBeNull();
    expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'Create key')).toBe(false);
  });

  it('renders the disabled notice when self-service is off', async () => {
    const { el } = await mount((url) =>
      url.endsWith('/v1/client/me/api_keys')
        ? json({ errors: [{ code: 'FORBIDDEN', message: 'Off.' }] }, 403)
        : undefined,
    );
    await vi.waitFor(() => expect(el.querySelector('[data-atlas="api-keys-disabled"]')).not.toBeNull());
  });

  it('passes organization_id through for org keys', async () => {
    const { el, calls } = await mount(
      (url) => (url.includes('/v1/client/me/api_keys') ? json(listBody([])) : undefined),
      { organizationId: 'org_1' },
    );
    await vi.waitFor(() => expect(el.querySelector('[data-atlas="api-keys-empty"]')).not.toBeNull());
    expect(calls.some((c) => c.url.endsWith('/v1/client/me/api_keys?organization_id=org_1'))).toBe(true);
    expect(el.textContent).toContain('act as this organization');
  });
});

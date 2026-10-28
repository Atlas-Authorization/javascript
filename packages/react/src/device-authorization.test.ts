// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider } from './AtlasProvider';
import { DeviceAuthorization, type DeviceAuthorizationProps } from './device-authorization';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `<DeviceAuthorization/>` drives `/v1/client/me/device_authorizations`: enter
 * (or pass) the code, review the app and its access, Allow or Deny — parking an
 * approval for a password re-authentication when the server asks for one.
 */

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const JWT = `${b64({ alg: 'none' })}.${b64({ sid: 'sess_1', sub: 'user_1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const AUTH = {
  object: 'device_authorization',
  id: 'dev_1',
  user_code: 'WDJB-MJHT',
  status: 'pending',
  client: { client_id: 'client_tv', name: 'Living Room TV', logo_url: null, homepage_url: null, first_party: false },
  scopes: [{ scope: 'profile', description: 'See your name and picture' }],
  audience: null,
  requires_step_up: false,
  created_at: 1,
  expires_at: 2,
};

type Route = (url: string, init: RequestInit) => Response | undefined;

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mount(route: Route, props: DeviceAuthorizationProps = {}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/v1/client')) return json({ session: { id: 'sess_1', status: 'active' }, user: { id: 'user_1' }, jwt: JWT });
    return route(url, init) ?? json({});
  }) as unknown as typeof fetch;
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
        children: createElement(DeviceAuthorization, props),
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

describe('<DeviceAuthorization/>', () => {
  it('looks up the typed code, shows the app and its access, and approves it', async () => {
    const onApproved = vi.fn();
    const { el, calls } = await mount(
      (url) => {
        if (url.endsWith('/device_authorizations/lookup')) return json(AUTH);
        if (url.endsWith('/device_authorizations/dev_1/approve')) return json({ ...AUTH, status: 'approved' });
        return undefined;
      },
      { onApproved },
    );
    const input = el.querySelector('[data-atlas="device-authorization-entry"] input') as HTMLInputElement;
    await type(input, 'wdjb mjht');
    await act(async () => {
      el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(calls.find((c) => c.url.endsWith('/lookup'))?.body).toEqual({ user_code: 'WDJB-MJHT' });
    expect(el.textContent).toContain('Living Room TV');
    expect(el.textContent).toContain('See your name and picture');
    expect(el.textContent).toContain('WDJB-MJHT');

    await click(button(el, 'Allow'));
    expect(calls.find((c) => c.url.endsWith('/approve'))?.body).toEqual({ user_code: 'WDJB-MJHT' });
    expect(el.querySelector('[data-atlas="device-authorization-approved"]')).not.toBeNull();
    expect(onApproved).toHaveBeenCalledTimes(1);
    expect(onApproved.mock.calls[0]![0].status).toBe('approved');
  });

  it('starts from a code passed in and denies', async () => {
    const onDenied = vi.fn();
    const { el, calls } = await mount(
      (url) => {
        if (url.endsWith('/lookup')) return json(AUTH);
        if (url.endsWith('/deny')) return json({ ...AUTH, status: 'denied' });
        return undefined;
      },
      { userCode: 'WDJB-MJHT', onDenied },
    );
    expect(calls.filter((c) => c.url.endsWith('/lookup'))).toHaveLength(1);
    await click(button(el, 'Deny'));
    expect(el.querySelector('[data-atlas="device-authorization-denied"]')).not.toBeNull();
    expect(onDenied).toHaveBeenCalledTimes(1);
  });

  it('says so when the code is not valid', async () => {
    const { el } = await mount(
      (url) => (url.endsWith('/lookup') ? json({ errors: [{ code: 'NOT_FOUND', message: 'Not found.' }] }, 404) : undefined),
      { userCode: 'AAAA-AAAA' },
    );
    expect(el.querySelector('[role="alert"]')?.textContent).toMatch(/not valid/);
  });

  it('asks the user to confirm it is them when approving needs a fresh sign-in', async () => {
    let approveCalls = 0;
    const { el } = await mount(
      (url) => {
        if (url.endsWith('/lookup')) return json({ ...AUTH, requires_step_up: true });
        if (url.endsWith('/approve')) {
          approveCalls += 1;
          return approveCalls === 1
            ? json({ errors: [{ code: 'STEP_UP_REQUIRED', message: 'Re-authenticate.' }] }, 403)
            : json({ ...AUTH, status: 'approved' });
        }
        return undefined;
      },
      { userCode: 'WDJB-MJHT' },
    );
    await click(button(el, 'Allow'));
    expect(el.querySelector('[data-atlas="device-authorization-reverification"]')).not.toBeNull();
  });
});

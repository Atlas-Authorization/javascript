// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider } from './AtlasProvider';
import { ManageCiba } from './account';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** `<ManageCiba/>`: pending CIBA requests with Approve / Deny, and the CIBA PIN form. */

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const JWT = `${b64({ alg: 'none' })}.${b64({ sid: 'sess_1', sub: 'user_1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const REQUEST = { id: 'bcr_1', client_name: 'Acme Kiosk', scope: ['openid'], binding_message: 'Code 1234', created_at: 1, expires_at: 2 };

type Route = (url: string, init: RequestInit) => Response | undefined;
let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mount(route: Route) {
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
        children: createElement(ManageCiba),
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
const click = (target: HTMLElement) => act(async () => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const type = (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('<ManageCiba/>', () => {
  it('renders nothing when there is no request, no PIN and no app that can ask', async () => {
    const { el } = await mount((url) => (url.endsWith('/ciba_pin') ? json({ set: false, available: false }) : url.endsWith('/backchannel_requests') ? json({ data: [] }) : undefined));
    expect(el.querySelector('[data-atlas="manage-ciba"]')).toBeNull();
  });

  it('lists a request and sends the decision, then reloads', async () => {
    let open = true;
    const { el, calls } = await mount((url, init) => {
      if (url.endsWith('/ciba_pin')) return json({ set: false, available: false });
      if (url.endsWith('/backchannel_requests')) return json({ data: open ? [REQUEST] : [] });
      if (url.endsWith('/backchannel_requests/bcr_1') && init.method === 'POST') { open = false; return json({ status: 'denied' }); }
      return undefined;
    });
    expect(el.textContent).toContain('Acme Kiosk');
    expect(el.textContent).toContain('Code 1234');
    await click(button(el, 'Deny'));
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/bcr_1'))?.body).toEqual({ decision: 'deny' });
    expect(el.textContent).not.toContain('Acme Kiosk');
  });

  it('sets the PIN with the current password and offers removal once set', async () => {
    let set = false;
    const { el, calls } = await mount((url, init) => {
      if (url.endsWith('/backchannel_requests')) return json({ data: [] });
      if (url.endsWith('/ciba_pin')) {
        if (init.method === 'PUT') { set = true; return json({ set: true }); }
        if (init.method === 'DELETE') { set = false; return json({ set: false }); }
        return json({ set, available: true });
      }
      return undefined;
    });
    expect(el.textContent).toContain('You have not set a CIBA PIN.');
    const [pw, pin] = [...el.querySelectorAll('input')] as HTMLInputElement[];
    await type(pw!, 'correct horse battery');
    await type(pin!, '482913');
    await click(button(el, 'Set PIN'));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ pin: '482913', current_password: 'correct horse battery' });
    expect(el.textContent).toContain('You have a CIBA PIN.');
    await click(button(el, 'Remove PIN'));
    expect(calls.find((c) => c.method === 'DELETE')).toBeTruthy();
    expect(el.textContent).toContain('You have not set a CIBA PIN.');
  });

  it('shows the server refusal when the PIN is rejected', async () => {
    const { el } = await mount((url, init) => {
      if (url.endsWith('/backchannel_requests')) return json({ data: [] });
      if (url.endsWith('/ciba_pin')) return init.method === 'PUT' ? json({ errors: [{ code: 'VALIDATION', message: 'The PIN must be 6 to 12 digits.' }] }, 400) : json({ set: false, available: true });
      return undefined;
    });
    await click(button(el, 'Set PIN'));
    expect(el.textContent).toContain('The PIN must be 6 to 12 digits.');
  });
});

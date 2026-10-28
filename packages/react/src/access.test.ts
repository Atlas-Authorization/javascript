// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider } from './AtlasProvider';
import { AccessRequests } from './access';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const list = (data: unknown[]) => json({ object: 'list', data, has_more: false });

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mount(refuse = false) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const c = { method: init?.method ?? 'GET', path: url.pathname, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null };
    calls.push(c);
    const p = url.pathname;
    if (p === '/v1/client') return json({ session: null, user: null });
    if (p === '/v1/appearance') return json({ object: 'appearance', appearance: { legal: {}, signUpFields: [] }, captchaFlows: {} });
    if (p.endsWith('/iga/catalog')) return list([{ object: 'iga_catalog_item', id: 'ige_1', key: 'wiki', name: 'Wiki <b>admin</b>', description: null, kind: 'custom', risk_level: 'low', approval_steps: 1, max_duration_seconds: null, require_justification: true }]);
    if (p.endsWith('/iga/approvals')) return list([{ object: 'iga_request', id: 'igr_9', entitlement_id: 'ige_1', justification: 'on call', status: 'pending' }]);
    if (c.method === 'POST' && p.endsWith('/iga/requests')) return refuse ? json({ errors: [{ code: 'conflict', message: 'Already requested.' }] }, 409) : json({ object: 'iga_request', id: 'igr_1', status: 'pending' }, 201);
    if (p.includes('/iga/')) return list([]);
    return json({});
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(createElement(AtlasProvider, { publishableKey: 'pk_test_x', frontendApi: FAPI, fetchImpl, appearance: { instanceDesign: false }, children: createElement(AccessRequests) }));
  });
  unmount = () => act(() => root.unmount());
  await vi.waitFor(() => expect(el.querySelector('[data-atlas-access-catalog]')).not.toBeNull());
  return { el, calls };
}

describe('<AccessRequests />', () => {
  it('shows the catalog as text and files a request with the reason', async () => {
    const { el, calls } = await mount();
    expect(el.querySelector('[data-atlas-access-catalog]')!.textContent).toContain('Wiki <b>admin</b>');
    expect(el.querySelector('[data-atlas-access-catalog] b')).toBeNull();
    const input = el.querySelector('input[name="justification"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'need it');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      el.querySelector('[data-atlas-access-catalog] form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const post = calls.find((c) => c.method === 'POST' && c.path.endsWith('/iga/requests'));
    expect(post?.body).toMatchObject({ entitlement: 'wiki', justification: 'need it' });
  });

  it('offers pending approvals and shows a refusal', async () => {
    const { el, calls } = await mount(true);
    expect(el.querySelector('[data-atlas-access-approvals]')!.textContent).toContain('on call');
    const input = el.querySelector('input[name="justification"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'x');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      el.querySelector('[data-atlas-access-catalog] form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-access-error]')?.textContent).toBe('Already requested.'));
    expect(calls.some((c) => c.path.endsWith('/decide'))).toBe(false);
  });
});

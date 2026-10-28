import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { createStore } from 'solid-js/store';
import { h } from './h';
import { AtlasContext } from './context';
import { ManageCiba } from './index';
import type { AtlasClient, AtlasState } from './provider';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const REQUEST = { id: 'bcr_1', client_name: 'Acme Kiosk', scope: ['openid'], binding_message: 'Code 1234', created_at: 1, expires_at: 2 };

const [state] = createStore<AtlasState>({ status: 'signed_in', user: null, session: null, claims: null, memberships: [] } as unknown as AtlasState);
const client = { publishableKey: 'pk_test', frontendApi: 'https://fapi.example', state } as unknown as AtlasClient;

type Route = (url: string, init: RequestInit) => Response | undefined;
function setup(route: Route) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    return route(String(input), init) ?? json({});
  }));
  return { view: render(() => h(AtlasContext.Provider, { value: client }, h(ManageCiba, {}))), calls };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<ManageCiba/> (Solid)', () => {
  it('renders nothing when there is no request, no PIN and no app that can ask', async () => {
    const { view, calls } = setup((url) => (url.endsWith('/ciba_pin') ? json({ set: false, available: false }) : json({ data: [] })));
    await waitFor(() => expect(calls.length).toBe(2));
    expect(view.container.querySelector('[data-atlas="manage-ciba"]')).toBeNull();
  });

  it('lists a request and sends the decision', async () => {
    let open = true;
    const { view, calls } = setup((url, init) => {
      if (url.endsWith('/ciba_pin')) return json({ set: false, available: false });
      if (url.endsWith('/backchannel_requests')) return json({ data: open ? [REQUEST] : [] });
      if (url.endsWith('/bcr_1') && init.method === 'POST') { open = false; return json({ status: 'denied' }); }
      return undefined;
    });
    await waitFor(() => expect(view.getByText('Acme Kiosk')).toBeTruthy());
    fireEvent.click(view.getByText('Deny'));
    await waitFor(() => expect(view.queryByText('Acme Kiosk')).toBeNull());
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ decision: 'deny' });
  });

  it('sets the PIN with the current password and shows a server refusal', async () => {
    const { view, calls } = setup((url, init) => {
      if (url.endsWith('/backchannel_requests')) return json({ data: [] });
      if (url.endsWith('/ciba_pin')) return init.method === 'PUT' ? json({ errors: [{ code: 'VALIDATION', message: 'The PIN must be 6 to 12 digits.' }] }, 400) : json({ set: false, available: true });
      return undefined;
    });
    await waitFor(() => expect(view.getByText('You have not set a CIBA PIN.', { exact: false })).toBeTruthy());
    fireEvent.input(view.getByLabelText('Current password'), { target: { value: 'correct horse battery' } });
    fireEvent.input(view.getByLabelText('New CIBA PIN'), { target: { value: '12' } });
    fireEvent.click(view.getByText('Set PIN'));
    await waitFor(() => expect(view.getByText('The PIN must be 6 to 12 digits.')).toBeTruthy());
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ pin: '12', current_password: 'correct horse battery' });
  });
});

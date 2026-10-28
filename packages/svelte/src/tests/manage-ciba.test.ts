import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { writable } from 'svelte/store';
import { ATLAS_KEY } from '../lib/context';
import { EN_US } from '../lib/i18n';
import ManageCiba from '../lib/components/ManageCiba.svelte';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const REQUEST = { id: 'bcr_1', client_name: 'Acme Kiosk', scope: ['openid'], binding_message: 'Code 1234', created_at: 1, expires_at: 2 };

const client = { publishableKey: 'pk_test', frontendApi: 'https://fapi.example', catalog: EN_US, status: writable('signed_in') };
type Route = (url: string, init: RequestInit) => Response | undefined;

function setup(route: Route) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    return route(String(input), init) ?? json({});
  }));
  const view = render(ManageCiba, { context: new Map([[ATLAS_KEY, client]]) });
  return { ...view, calls };
}
afterEach(() => vi.unstubAllGlobals());

describe('<ManageCiba/> (Svelte)', () => {
  it('renders nothing when there is no request, no PIN and no app that can ask', async () => {
    const { container, calls } = setup((url) => (url.endsWith('/ciba_pin') ? json({ set: false, available: false }) : json({ data: [] })));
    await waitFor(() => expect(calls.length).toBe(2));
    expect(container.querySelector('[data-atlas="manage-ciba"]')).toBeNull();
  });

  it('lists a request and sends the decision', async () => {
    let open = true;
    const { findByText, queryByText, getByText, calls } = setup((url, init) => {
      if (url.endsWith('/ciba_pin')) return json({ set: false, available: false });
      if (url.endsWith('/backchannel_requests')) return json({ data: open ? [REQUEST] : [] });
      if (url.endsWith('/bcr_1') && init.method === 'POST') { open = false; return json({ status: 'denied' }); }
      return undefined;
    });
    await findByText('Acme Kiosk');
    await fireEvent.click(getByText('Deny'));
    await waitFor(() => expect(queryByText('Acme Kiosk')).toBeNull());
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ decision: 'deny' });
  });

  it('sets the PIN with the current password and shows a server refusal', async () => {
    const { findByText, getByLabelText, getByText, calls } = setup((url, init) => {
      if (url.endsWith('/backchannel_requests')) return json({ data: [] });
      if (url.endsWith('/ciba_pin')) return init.method === 'PUT' ? json({ errors: [{ code: 'VALIDATION', message: 'The PIN must be 6 to 12 digits.' }] }, 400) : json({ set: false, available: true });
      return undefined;
    });
    await findByText('You have not set a CIBA PIN.', { exact: false });
    await fireEvent.input(getByLabelText('Current password'), { target: { value: 'correct horse battery' } });
    await fireEvent.input(getByLabelText('New CIBA PIN'), { target: { value: '12' } });
    await fireEvent.click(getByText('Set PIN'));
    await findByText('The PIN must be 6 to 12 digits.');
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ pin: '12', current_password: 'correct horse battery' });
  });
});

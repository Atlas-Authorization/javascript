import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from '@atlasauth/js';
import { CibaController, cibaVisible } from './ciba';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const REQUEST = { id: 'bcr_1', client_name: 'Acme Kiosk', scope: ['openid'], binding_message: 'Code 1234', created_at: 1, expires_at: 2 };

type Route = (url: string, init: RequestInit) => Response | undefined;
function setup(route: Route) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    return route(String(input), init) ?? json({});
  }) as unknown as typeof fetch;
  const c = new CibaController(new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl }));
  return { c, calls };
}

describe('CibaController', () => {
  it('has nothing to show when there is no request, no PIN and no app that can ask', async () => {
    const { c } = setup((url) => (url.endsWith('/ciba_pin') ? json({ set: false, available: false }) : json({ data: [] })));
    await c.load();
    expect(cibaVisible(c.getSnapshot())).toBe(false);
  });

  it('loads requests, sends the decision and reloads', async () => {
    let open = true;
    const { c, calls } = setup((url, init) => {
      if (url.endsWith('/ciba_pin')) return json({ set: false, available: false });
      if (url.endsWith('/backchannel_requests')) return json({ data: open ? [REQUEST] : [] });
      if (url.endsWith('/bcr_1') && init.method === 'POST') { open = false; return json({ status: 'denied' }); }
      return undefined;
    });
    await c.load();
    expect(c.getSnapshot().requests).toHaveLength(1);
    expect(await c.decide('bcr_1', 'deny')).toBe(true);
    expect(calls.find((x) => x.method === 'POST')?.body).toEqual({ decision: 'deny' });
    expect(c.getSnapshot().requests).toHaveLength(0);
  });

  it('sets and removes the PIN with the current password, and surfaces a refusal', async () => {
    let set = false;
    const { c, calls } = setup((url, init) => {
      if (url.endsWith('/backchannel_requests')) return json({ data: [] });
      if (url.endsWith('/ciba_pin')) {
        if (init.method === 'PUT') return String((JSON.parse(String(init.body)) as { pin: string }).pin).length < 6 ? json({ errors: [{ code: 'VALIDATION', message: 'The PIN must be 6 to 12 digits.' }] }, 400) : ((set = true), json({ set: true }));
        if (init.method === 'DELETE') { set = false; return json({ set: false }); }
        return json({ set, available: true });
      }
      return undefined;
    });
    await c.load();
    expect(await c.savePin('12', 'pw')).toBe(false);
    expect(c.getSnapshot().message).toBe('The PIN must be 6 to 12 digits.');
    expect(await c.savePin('482913', 'pw')).toBe(true);
    expect(calls.filter((x) => x.method === 'PUT').at(-1)?.body).toEqual({ pin: '482913', current_password: 'pw' });
    expect(c.getSnapshot().pin?.set).toBe(true);
    expect(await c.removePin('pw')).toBe(true);
    expect(c.getSnapshot().pin?.set).toBe(false);
  });
});

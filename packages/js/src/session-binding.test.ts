import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { bindSession, createNavigationTicket, navigateWithTicket, sessionBindingRequired } from './session-binding';

const fakeDpop = {
  thumbprint: async () => 'jkt',
  proof: vi.fn(async (method: string, url: string) => `proof:${method}:${url}`),
  fetch: vi.fn(),
};

describe('session binding client', () => {
  it('sends a DPoP proof on every request when a binding key is set', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ object: 'session_binding', session_id: 's', jkt: 'jkt', attested: false, bound_at: 1 }), { status: 201, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const client = new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://auth.example.test', fetchImpl, sessionBinding: fakeDpop });
    const res = await bindSession(client);
    expect(res.ok).toBe(true);
    expect(calls[0]!.url).toBe('https://auth.example.test/v1/client/session_binding');
    expect(calls[0]!.headers.dpop).toBe('proof:POST:https://auth.example.test/v1/client/session_binding');
  });

  it('sends no proof without a binding key', async () => {
    const calls: Array<Record<string, string>> = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      calls.push(init.headers as Record<string, string>);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://auth.example.test', fetchImpl }).request('/v1/client');
    expect(calls[0]!.dpop).toBeUndefined();
  });

  it('recognises the binding-required reasons', () => {
    expect(sessionBindingRequired({ errors: [{ reason: 'session_binding_required' } as never] })).toBe(true);
    expect(sessionBindingRequired({ errors: [{ reason: 'dpop_binding_required' } as never] })).toBe(true);
    expect(sessionBindingRequired({ errors: [] })).toBe(false);
  });
});

describe('navigation tickets', () => {
  const ticketFetch = (status: number, calls: Array<{ url: string; body: string; dpop?: string }>) =>
    (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init.body), dpop: (init.headers as Record<string, string>).dpop });
      return new Response(
        JSON.stringify(status === 201 ? { object: 'navigation_ticket', ticket: 'ntk_a.b', url: '/hosted/sign-in?x=1&atlas_nav_ticket=ntk_a.b', target: '/hosted/sign-in?x=1', expires_at: 1 } : { errors: [{ code: 'unauthenticated', message: 'no', reason: 'dpop_binding_required' }] }),
        { status, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

  it('mints a ticket with a DPoP proof and navigates to the returned URL', async () => {
    const calls: Array<{ url: string; body: string; dpop?: string }> = [];
    const client = new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://auth.example.test', fetchImpl: ticketFetch(201, calls), sessionBinding: fakeDpop });
    const go = vi.fn();
    const res = await navigateWithTicket(client, '/hosted/sign-in?x=1', { navigate: go });
    expect(res.ok).toBe(true);
    expect(calls[0]!.url).toBe('https://auth.example.test/v1/client/session_binding/navigation_ticket');
    expect(JSON.parse(calls[0]!.body)).toEqual({ target: '/hosted/sign-in?x=1' });
    expect(calls[0]!.dpop).toBe('proof:POST:https://auth.example.test/v1/client/session_binding/navigation_ticket');
    expect(go).toHaveBeenCalledWith('https://auth.example.test/hosted/sign-in?x=1&atlas_nav_ticket=ntk_a.b');
  });

  it('does not navigate when minting failed, and passes the ttl', async () => {
    const calls: Array<{ url: string; body: string; dpop?: string }> = [];
    const client = new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://auth.example.test', fetchImpl: ticketFetch(401, calls), sessionBinding: fakeDpop });
    const go = vi.fn();
    const res = await navigateWithTicket(client, '/oauth2/authorize?client_id=c', { navigate: go, ttlSeconds: 10 });
    expect(res.ok).toBe(false);
    expect(sessionBindingRequired(res)).toBe(true);
    expect(go).not.toHaveBeenCalled();
    expect(JSON.parse(calls[0]!.body).ttl_seconds).toBe(10);
    expect((await createNavigationTicket(client, '/hosted/user')).ok).toBe(false);
  });
});

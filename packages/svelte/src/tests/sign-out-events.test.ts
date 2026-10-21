import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { SignOutEvent } from '@atlasauth/js';
import { createAtlasClient, type AtlasClient } from '../lib/context';
import { ATLAS_SVELTE_VERSION } from '../lib/version';

const PKG_JSON = '../../package.json';
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
// A fixed exp, so jwtFor(sid) is the same string however slow the run (a
// per-call Date.now() changed the token when a second ticked mid-test).
const EXP = Math.floor(Date.now() / 1000) + 3600;
const jwtFor = (sid: string) =>
  `${b64({ alg: 'none' })}.${b64({ sid, sub: 'user_1', exp: EXP })}.sig`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const signedIn = (sid: string) =>
  json({ session: { id: sid, status: 'active', last_active_organization_id: null }, user: { id: 'user_1' }, jwt: jwtFor(sid) });
const signedOutBody = (reason: string | null) => json({ session: null, sessions: [], user: null, signed_out_reason: reason });

type Route = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

/** Signed in on the first boot; later /v1/client calls go to `route`. */
function network(route: Route) {
  const headers: Record<string, string>[] = [];
  let boots = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    headers.push((init?.headers ?? {}) as Record<string, string>);
    if (url.endsWith('/v1/client') && boots++ === 0) return signedIn('sess_1');
    return (await route(url, init)) ?? json({});
  }) as unknown as typeof fetch;
  return { fetchImpl, headers };
}

const clients: AtlasClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.destroy();
  vi.restoreAllMocks();
});

async function make(fetchImpl: typeof fetch) {
  const events: SignOutEvent[] = [];
  const client = createAtlasClient({
    publishableKey: 'pk_test_x',
    frontendApi: 'https://fapi.example',
    fetchImpl,
    manualBoot: true,
    onSignOut: (e) => events.push(e),
  });
  clients.push(client);
  await client.boot();
  expect(get(client.status)).toBe('signed_in');
  return { client, events };
}

describe('svelte: onSignOut, getToken({ template }), X-Atlas-SDK', () => {
  it('the version constant matches package.json', () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, PKG_JSON), 'utf8')) as { version: string };
    expect(ATLAS_SVELTE_VERSION).toBe(manifest.version);
  });

  it("names the SDK on every request and reports reason 'user' once on signOut()", async () => {
    const net = network((url) => (url.endsWith('/revoke') ? json({ status: 'revoked' }) : undefined));
    const t = await make(net.fetchImpl);
    await t.client.signOut({ frontchannel: false });
    expect(get(t.client.status)).toBe('signed_out');
    expect(t.events).toEqual([{ reason: 'user', sessionId: 'sess_1' }]);
    expect(net.headers.length).toBeGreaterThan(1);
    for (const h of net.headers) expect(h['x-atlas-sdk']).toBe('@atlasauth/svelte/' + ATLAS_SVELTE_VERSION);
  });

  it("reports 'revoked' when a re-check finds the session ended elsewhere, and nothing while it stays signed in", async () => {
    let next: 'in' | 'revoked' = 'in';
    const net = network((url) => (url.endsWith('/v1/client') ? (next === 'in' ? signedIn('sess_1') : signedOutBody('revoked')) : undefined));
    const t = await make(net.fetchImpl);
    await t.client.reload();
    expect(t.events).toEqual([]);
    next = 'revoked';
    await t.client.reload();
    expect(t.events).toEqual([{ reason: 'revoked', sessionId: 'sess_1' }]);
  });

  it("reports 'session_expired' from the server's reason", async () => {
    const net = network((url) => (url.endsWith('/v1/client') ? signedOutBody('session_expired') : undefined));
    const t = await make(net.fetchImpl);
    await t.client.reload();
    expect(t.events).toEqual([{ reason: 'session_expired', sessionId: 'sess_1' }]);
  });

  it('getToken({ template }) mints a named-template token for the session', async () => {
    const net = network((url) => (url.endsWith('/sessions/sess_1/tokens/chatly') ? json({ object: 'token', jwt: 'chat.jwt.x', expires_in: 120 }) : undefined));
    const t = await make(net.fetchImpl);
    expect(await t.client.getToken({ template: 'chatly' })).toBe('chat.jwt.x');
  });
});

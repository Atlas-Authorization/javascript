import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { startEmulator, startProxy, type Emulator } from './server';

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});
const j = (r: Response) => r.json() as Promise<Record<string, any>>;

describe('emulator', () => {
  it('signs a seeded user in with the deterministic code and catches the mail', async () => {
    const e: Emulator = await startEmulator({ seed: { users: [{ email: 'ada@example.com', password: 'pw' }] } });
    open.push(e);
    const h = { 'content-type': 'application/json', 'x-publishable-key': 'pk_test_x' };
    const si = await j(await fetch(`${e.url}/v1/client/sign_ins`, { method: 'POST', headers: h, body: JSON.stringify({ identifier: 'ada@example.com' }) }));
    await fetch(`${e.url}/v1/client/sign_ins/${si.id}/prepare_first_factor`, { method: 'POST', headers: h, body: JSON.stringify({ strategy: 'email_code' }) });
    const caught = await j(await fetch(`${e.url}/__emulator/mail.json`));
    expect(caught.data).toMatchObject([{ to: 'ada@example.com', code: '424242', channel: 'email' }]);
    const done = await j(await fetch(`${e.url}/v1/client/sign_ins/${si.id}/attempt_first_factor`, { method: 'POST', headers: h, body: JSON.stringify({ strategy: 'email_code', code: '424242' }) }));
    expect(done.status).toBe('complete');
    expect(await (await fetch(`${e.url}/__emulator/mail`)).text()).toContain('ada@example.com');
  });

  it('serves OIDC discovery for its own origin', async () => {
    const e = await startEmulator();
    open.push(e);
    const d = await j(await fetch(`${e.url}/.well-known/openid-configuration`));
    expect(d.issuer).toBe(e.url);
    expect(d.jwks_uri).toBe(`${e.url}/.well-known/jwks.json`);
  });

  it('puts the app and the API on one origin', async () => {
    const app = createServer((_, res) => res.end('app'));
    await new Promise<void>((ok) => app.listen(0, '127.0.0.1', ok));
    const appUrl = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    open.push({ close: () => new Promise((ok) => (app.closeAllConnections(), app.close(() => ok()))) });
    const e = await startEmulator({ app: appUrl });
    open.push(e);
    expect(await (await fetch(`${e.url}/dashboard`)).text()).toBe('app');
    expect((await j(await fetch(`${e.url}/.well-known/openid-configuration`))).issuer).toBe(e.url);
    const p = await startProxy({ app: appUrl, api: e.url });
    open.push(p);
    expect(await (await fetch(`${p.url}/`)).text()).toBe('app');
    expect((await j(await fetch(`${p.url}/.well-known/openid-configuration`))).issuer).toBe(e.url);
  });

  it('mounts the API under a base path and leaves the rest to the app', async () => {
    const app = createServer((req, res) => res.end(`app:${req.url}`));
    await new Promise<void>((ok) => app.listen(0, '127.0.0.1', ok));
    const appUrl = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    open.push({ close: () => new Promise((ok) => (app.closeAllConnections(), app.close(() => ok()))) });
    const e = await startEmulator();
    open.push(e);
    const p = await startProxy({ app: appUrl, api: e.url, basePath: '/atlas' });
    open.push(p);
    expect((await j(await fetch(`${p.url}/atlas/.well-known/openid-configuration`))).issuer).toBe(e.url);
    expect(await (await fetch(`${p.url}/v1/x`)).text()).toBe('app:/v1/x');
  });
});

describe('one state across the Frontend API mock and the Backend API engine', () => {
  const openapi = resolve(__dirname, '../../../sdks/rust/scripts/openapi.snapshot.json');
  const fapi = { 'content-type': 'application/json', 'x-publishable-key': 'pk_test_x' };
  const bapi = { 'content-type': 'application/json', authorization: 'Bearer sk_test_emulator' };

  it('signs in through the Frontend API a user created over the Backend API, then refreshes, lists and revokes the session on the real routes', async () => {
    const e = await startEmulator({ openapi });
    open.push(e);
    const made = await j(await fetch(`${e.url}/v1/users`, { method: 'POST', headers: bapi, body: JSON.stringify({ email_address: 'shared@example.com', password: 'Correct-horse-9-battery' }) }));
    expect(made.id).toBeTruthy();
    // the mock authenticates the user the engine created (password and all)
    const si = await j(await fetch(`${e.url}/v1/client/sign_ins`, { method: 'POST', headers: fapi, body: JSON.stringify({ identifier: 'shared@example.com' }) }));
    await fetch(`${e.url}/v1/client/sign_ins/${si.id}/prepare_first_factor`, { method: 'POST', headers: fapi, body: JSON.stringify({ strategy: 'email_code' }) });
    const done = await j(await fetch(`${e.url}/v1/client/sign_ins/${si.id}/attempt_first_factor`, { method: 'POST', headers: fapi, body: JSON.stringify({ strategy: 'email_code', code: '424242' }) }));
    expect(done.status).toBe('complete');
    // the session the mock minted is visible and refreshable over the Backend API / real Frontend API route
    const sessions = await j(await fetch(`${e.url}/v1/sessions?user_id=${made.id}`, { headers: bapi }));
    expect(sessions.data).toHaveLength(1);
    const sid = sessions.data[0].id as string;
    const refreshed = await j(await fetch(`${e.url}/v1/client/sessions/${sid}/tokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: `rt_${sid}` }) }));
    expect(refreshed).toMatchObject({ object: 'session_tokens', session_id: sid });
    expect(refreshed.jwt.split('.')).toHaveLength(3);
    // revoking over the Backend API ends it for the mock too
    await fetch(`${e.url}/v1/sessions/${sid}/revoke`, { method: 'POST', headers: bapi });
    const me = await fetch(`${e.url}/v1/client/me`, { headers: { ...fapi, authorization: `Bearer jwt_${sid}` } });
    expect(me.status).toBeGreaterThanOrEqual(400);
  });

  it('shows an organization and membership created in the engine to the mock, and serves the OAuth provider and well-known documents from the engine', async () => {
    const e = await startEmulator({ openapi });
    open.push(e);
    const user = await j(await fetch(`${e.url}/v1/users`, { method: 'POST', headers: bapi, body: JSON.stringify({ email_address: 'o@example.com' }) }));
    const org = await j(await fetch(`${e.url}/v1/organizations`, { method: 'POST', headers: bapi, body: JSON.stringify({ name: 'Shared' }) }));
    await fetch(`${e.url}/v1/organizations/${org.id}/memberships`, { method: 'POST', headers: bapi, body: JSON.stringify({ user_id: user.id, role: 'org:member' }) });
    await fetch(`${e.url}/v1/client/environment`, { headers: fapi });
    expect(e.mock.findOrganization(org.id)?.name).toBe('Shared');
    expect(e.mock.memberships.some((m) => m.userId === user.id && m.organizationId === org.id && m.role === 'member')).toBe(true);
    const doc = await j(await fetch(`${e.url}/.well-known/openid-configuration`));
    expect(doc).toMatchObject({ issuer: e.url, revocation_endpoint: `${e.url}/oauth2/revoke` });
    // the mock's own secret key also opens the engine
    expect((await fetch(`${e.url}/v1/users`, { headers: { authorization: 'Bearer sk_test_atlas' } })).status).toBe(200);
  });
});

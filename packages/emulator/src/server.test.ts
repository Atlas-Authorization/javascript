import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
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
});

import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { instanceSettingsFrom, startSignInWithAtlas } from './instance-settings';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function clientWith(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl }), calls };
}

describe('instanceSettingsFrom: Sign in with Atlas', () => {
  it('reads the connection when the instance has it on', () => {
    expect(instanceSettingsFrom({ sign_in_with_atlas: { enabled: true, connection_id: 'ssoc_1' } }).signInWithAtlas).toEqual({
      connectionId: 'ssoc_1',
    });
  });

  it('is absent when off, without a connection, or on an older server', () => {
    expect(instanceSettingsFrom({ sign_in_with_atlas: { enabled: false } }).signInWithAtlas).toBeUndefined();
    expect(instanceSettingsFrom({ sign_in_with_atlas: { enabled: true } }).signInWithAtlas).toBeUndefined();
    expect(instanceSettingsFrom({}).signInWithAtlas).toBeUndefined();
  });
});

describe('startSignInWithAtlas', () => {
  it('starts the SSO sign-in for the connection and returns the authorization URL', async () => {
    const { client, calls } = clientWith(() => json(200, { authorization_url: 'https://id.example/authorize?x=1' }));
    expect(await startSignInWithAtlas(client, 'ssoc_1', 'https://app.example.com/login')).toEqual({
      url: 'https://id.example/authorize?x=1',
    });
    expect(calls[0]!.url).toContain('/v1/client/sign_ins/sso');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      connection_id: 'ssoc_1',
      redirect_url: 'https://app.example.com/login',
    });
  });

  it("returns the server's message when it cannot start", async () => {
    const { client } = clientWith(() => json(422, { errors: [{ code: 'VALIDATION_FAILED', message: 'Not active.' }] }));
    expect(await startSignInWithAtlas(client, 'ssoc_1', 'https://app.example.com/')).toEqual({ error: 'Not active.' });
  });
});

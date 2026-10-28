import { describe, expect, it } from 'vitest';
import { OAuthFlowError, pollDeviceAuthorization, startDeviceAuthorization } from './operator';

/** The RFC 8628 device flow against an instance's own OAuth server, for a CLI of your own. */

type Call = { url: string; body: URLSearchParams };

function server(answers: Array<[number, Record<string, unknown>]>) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: new URLSearchParams(String(init.body)) });
    const [status, json] = answers.shift()!;
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const DEVICE = {
  device_code: 'dc_1',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://staff-fapi.atlasauth.net/oauth2/device',
  verification_uri_complete: 'https://staff-fapi.atlasauth.net/oauth2/device?user_code=ABCD-EFGH',
  expires_in: 600,
  interval: 5,
};

describe('startDeviceAuthorization / pollDeviceAuthorization', () => {
  it('starts at <issuer>/oauth2/device_authorization and polls <issuer>/oauth2/token through pending and slow_down', async () => {
    const { calls, fetch } = server([
      [200, DEVICE],
      [400, { error: 'authorization_pending' }],
      [400, { error: 'slow_down' }],
      [200, { access_token: 'at_1', token_type: 'Bearer', expires_in: 3600, id_token: 'id_1' }],
    ]);
    const start = await startDeviceAuthorization(
      { issuer: 'https://staff-fapi.atlasauth.net/', clientId: 'cli_console', scope: ['openid', 'profile'], resource: 'https://console.example.com' },
      { fetch },
    );
    expect(start.user_code).toBe('ABCD-EFGH');
    expect(calls[0]!.url).toBe('https://staff-fapi.atlasauth.net/oauth2/device_authorization');
    expect(calls[0]!.body.get('client_id')).toBe('cli_console');
    expect(calls[0]!.body.get('scope')).toBe('openid profile');
    expect(calls[0]!.body.get('resource')).toBe('https://console.example.com');

    const waits: number[] = [];
    const tokens = await pollDeviceAuthorization(start, { fetch, sleep: async (ms) => void waits.push(ms) });
    expect(tokens.access_token).toBe('at_1');
    expect(waits).toEqual([5000, 5000, 10000]);
    for (const c of calls.slice(1)) {
      expect(c.url).toBe('https://staff-fapi.atlasauth.net/oauth2/token');
      expect(c.body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
      expect(c.body.get('device_code')).toBe('dc_1');
      expect(c.body.has('client_secret')).toBe(false);
    }
  });

  it('sends a confidential client secret and throws access_denied when the person denies', async () => {
    const { calls, fetch } = server([
      [200, DEVICE],
      [400, { error: 'access_denied', error_description: 'The user denied the request.' }],
    ]);
    const start = await startDeviceAuthorization({ issuer: 'https://auth.example.com', clientId: 'c', clientSecret: 's' }, { fetch });
    const err = await pollDeviceAuthorization(start, { fetch, sleep: async () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthFlowError);
    expect(err.error).toBe('access_denied');
    expect(calls[0]!.body.get('client_secret')).toBe('s');
    expect(calls[1]!.body.get('client_secret')).toBe('s');
  });

  it('throws the server error when the client may not use the device grant', async () => {
    const { fetch } = server([[400, { error: 'unauthorized_client', error_description: 'no device grant' }]]);
    await expect(startDeviceAuthorization({ issuer: 'https://auth.example.com', clientId: 'c' }, { fetch })).rejects.toMatchObject({
      error: 'unauthorized_client',
      status: 400,
    });
  });
});

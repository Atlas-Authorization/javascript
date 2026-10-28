import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import {
  DeviceAuthorizationError,
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  formatUserCode,
  lookupDeviceAuthorization,
  userCodeFromUrl,
} from './device-authorization';

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

const WIRE = {
  object: 'device_authorization',
  id: 'dev_1',
  user_code: 'WDJB-MJHT',
  status: 'pending',
  client: { client_id: 'client_tv', name: 'TV App', logo_url: null, homepage_url: 'https://tv.example.com', first_party: false },
  scopes: [{ scope: 'openid', description: 'Sign you in' }],
  audience: null,
  requires_step_up: true,
  created_at: 1,
  expires_at: 2,
};

describe('device authorization client', () => {
  it('normalises typed codes and reads them from verification URLs', () => {
    expect(formatUserCode(' wdjb mjht ')).toBe('WDJB-MJHT');
    expect(formatUserCode('wdjb-mjht')).toBe('WDJB-MJHT');
    expect(formatUserCode('abc')).toBe('abc');
    expect(userCodeFromUrl('https://auth.example.com/oauth2/device?user_code=wdjbmjht')).toBe('WDJB-MJHT');
    expect(userCodeFromUrl('https://auth.example.com/activate')).toBeNull();
    expect(userCodeFromUrl('not a url')).toBeNull();
  });

  it('looks up, approves and denies with the user code, mapping to camelCase', async () => {
    const { client, calls } = clientWith((url) => json(200, url.endsWith('/approve') ? { ...WIRE, status: 'approved' } : url.endsWith('/deny') ? { ...WIRE, status: 'denied' } : WIRE));
    const found = await lookupDeviceAuthorization(client, 'wdjb mjht');
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/me/device_authorizations/lookup');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ user_code: 'WDJB-MJHT' });
    expect(calls[0]!.init.credentials).toBe('include');
    expect(found).toMatchObject({
      id: 'dev_1',
      userCode: 'WDJB-MJHT',
      requiresStepUp: true,
      client: { clientId: 'client_tv', name: 'TV App', homepageUrl: 'https://tv.example.com', firstParty: false },
      scopes: [{ scope: 'openid', description: 'Sign you in' }],
    });
    expect((await approveDeviceAuthorization(client, found)).status).toBe('approved');
    expect(calls[1]!.url).toBe('https://fapi.example/v1/client/me/device_authorizations/dev_1/approve');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ user_code: 'WDJB-MJHT' });
    expect((await denyDeviceAuthorization(client, found)).status).toBe('denied');
    expect(calls[2]!.url).toBe('https://fapi.example/v1/client/me/device_authorizations/dev_1/deny');
  });

  it('turns refusals into DeviceAuthorizationError', async () => {
    const stepUp = clientWith(() => json(403, { errors: [{ code: 'STEP_UP_REQUIRED', message: 'Re-authenticate.' }] }));
    const err = await approveDeviceAuthorization(stepUp.client, { id: 'dev_1', userCode: 'WDJB-MJHT' }).catch((e) => e);
    expect(err).toBeInstanceOf(DeviceAuthorizationError);
    expect(err.needsReverification).toBe(true);
    expect(err.isInvalidCode).toBe(false);

    const notFound = clientWith(() => json(404, { errors: [{ code: 'NOT_FOUND', message: 'That code is not valid.' }] }));
    const missing = await lookupDeviceAuthorization(notFound.client, 'AAAA-AAAA').catch((e) => e);
    expect(missing.isInvalidCode).toBe(true);
    expect(missing.status).toBe(404);
  });
});

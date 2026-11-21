import { describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../../config-http';
import type { CollectionSpec, SingletonSpec } from '../config';
import { registeredConfigTypes } from './index';
import { NATIVE_APP_CONFIG_TYPES } from './native-apps';

const spec = NATIVE_APP_CONFIG_TYPES[0] as CollectionSpec;

describe('native_apps config type', () => {
  it('is registered and is not pruned by a bare --prune', () => {
    expect(registeredConfigTypes().map((s) => s.type)).toContain('native_apps');
    expect(spec.prune).toBe(false);
  });

  it('keys an app by platform and store name', () => {
    expect(spec.keyOf({ platform: 'ios', bundle_id: 'com.example.app' } as never)).toBe('ios:com.example.app');
    expect(spec.keyOf({ platform: 'android', package_name: 'com.example.app' } as never)).toBe('android:com.example.app');
  });

  it('reads live apps without the server-only fields, and never sends the platform on update', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const http = {
      get: async () => ({ data: [{ id: 'napp_1', platform: 'ios', bundle_id: 'com.example.app', team_id: 'TEAM123456', callback_urls: ['exampleapp://oauth-callback'], created_at: 'x' }] }),
      patch: async (p: string, b: unknown) => void calls.push(['PATCH', p, b]),
    } as unknown as ConfigHttp;
    const [live] = await spec.fetchLive(http);
    expect(live).toEqual({ key: 'ios:com.example.app', id: 'napp_1', config: { platform: 'ios', bundle_id: 'com.example.app', team_id: 'TEAM123456', callback_urls: ['exampleapp://oauth-callback'] } });
    await spec.update!(http, live!, { ...(live!.config as Record<string, unknown>), callback_urls: ['exampleapp://cb'] } as never);
    expect(calls).toEqual([['PATCH', '/v1/native_apps/napp_1', { bundle_id: 'com.example.app', team_id: 'TEAM123456', callback_urls: ['exampleapp://cb'] }]]);
  });

  it('validates what each platform needs and the callback count', () => {
    expect(spec.validate!({ platform: 'ios', bundle_id: 'a.b', callback_urls: ['exampleapp://x'] } as never)).toEqual(['native_apps: an ios app needs bundle_id and team_id.']);
    expect(spec.validate!({ platform: 'android', package_name: 'a.b', sha256_cert_fingerprints: ['AA'], callback_urls: [] } as never)).toEqual(['native_apps: callback_urls needs 1 to 10 entries.']);
    expect(spec.validate!({ platform: 'ios', bundle_id: 'a.b', team_id: 'T', callback_urls: ['exampleapp://x'] } as never)).toEqual([]);
  });

  it('matches fingerprints however the file writes them', () => {
    const live = { platform: 'android', sha256_cert_fingerprints: ['AA:BB'] };
    expect(spec.align!(live as never, { sha256_cert_fingerprints: ['aabb'] } as never)).toEqual({ platform: 'android', sha256_cert_fingerprints: ['aabb'] });
  });

  it('lists the publishable key apps by store name and writes their ids', async () => {
    const pk = NATIVE_APP_CONFIG_TYPES[1] as SingletonSpec;
    expect(registeredConfigTypes().map((s) => s.type)).toContain('native_apps_publishable_key');
    const puts: unknown[] = [];
    const http = {
      get: async (p: string) => (p.endsWith('/publishable_key') ? { app_ids: ['napp_1'] } : { data: [{ id: 'napp_1', platform: 'ios', bundle_id: 'com.example.app', team_id: 'T', callback_urls: ['exampleapp://cb'] }] }),
      put: async (_p: string, b: unknown) => void puts.push(b),
    } as unknown as ConfigHttp;
    expect(await pk.fetchLive(http)).toEqual({ apps: ['ios:com.example.app'] });
    await pk.apply(http, { apps: ['ios:com.example.app'] } as never, { forceHook: false });
    expect(puts).toEqual([{ app_ids: ['napp_1'] }]);
    await expect(pk.apply(http, { apps: ['android:com.example.other'] } as never, { forceHook: false })).rejects.toThrow('not a registered native app');
    expect(pk.validate!({ apps: ['napp_1'] } as never)).toHaveLength(1);
  });
});

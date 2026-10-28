import { describe, expect, it, vi } from 'vitest';
import { collectBrowserPosture, installId, reportDevicePosture } from './posture';

describe('browser posture', () => {
  it('reads platform, browser and OS version from client hints', async () => {
    const p = await collectBrowserPosture({
      userAgentData: { platform: 'macOS', brands: [{ brand: 'Not A;Brand', version: '99' }, { brand: 'Google Chrome', version: '130' }], getHighEntropyValues: async () => ({ platformVersion: '14.2.1', uaFullVersion: '130.0.1.2' }) },
    });
    expect(p).toEqual({ platform: 'macOS', os_version: '14.2.1', browser: 'Google Chrome', browser_version: '130.0.1.2' });
  });
  it('still reports the platform when hints are blocked or missing', async () => {
    expect(await collectBrowserPosture({ platform: 'Win32' })).toEqual({ platform: 'Win32' });
    const blocked = await collectBrowserPosture({ userAgentData: { platform: 'Linux', getHighEntropyValues: async () => { throw new Error('blocked'); } } });
    expect(blocked).toEqual({ platform: 'Linux' });
  });
  it('keeps one install id per extension install', async () => {
    const mem = new Map<string, string>();
    const store = { get: async (k: string) => mem.get(k), set: async (k: string, v: string) => void mem.set(k, v) };
    const a = await installId(store, () => 'id-1-aaaaaaaa');
    const b = await installId(store, () => 'id-2-bbbbbbbb');
    expect(a).toBe('id-1-aaaaaaaa');
    expect(b).toBe(a);
  });
  it('posts the report and throws on a refusal', async () => {
    const post = vi.fn(async () => ({ ok: true, status: 200, data: {}, errors: [] }));
    await reportDevicePosture({ fapi: { post } } as never, { installId: 'abcdefgh', navigator: { userAgentData: { platform: 'macOS' } } });
    expect(post).toHaveBeenCalledWith('/v1/client/me/device_posture', { install_id: 'abcdefgh', platform: 'macOS' });
    await expect(reportDevicePosture({ fapi: { post: async () => ({ ok: false, status: 403, data: null, errors: [] }) } } as never, { installId: 'abcdefgh', navigator: { platform: 'x' } })).rejects.toThrow(/403/);
  });
});

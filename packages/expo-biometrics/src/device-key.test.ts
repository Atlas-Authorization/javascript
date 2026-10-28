import { describe, expect, it } from 'vitest';
import { createDeviceKeySigner, toDeviceKeyJwk, toP1363Signature } from './device-key';

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

describe('device key adapters', () => {
  const point = [0x04, ...new Array(32).fill(1), ...new Array(32).fill(2)];

  it('reads the point from a bare X9.63 key or the tail of an SPKI', () => {
    const spkiHeader = [0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00];
    const bare = toDeviceKeyJwk(b64(point));
    expect(bare).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(toDeviceKeyJwk(b64([...spkiHeader, ...point]))).toEqual(bare);
    expect(toDeviceKeyJwk({ x: 'a', y: 'b' })).toEqual({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b' });
  });

  it('rejects a key that is not an uncompressed P-256 point', () => {
    expect(() => toDeviceKeyJwk(b64([1, 2, 3]))).toThrow();
  });

  it('converts a DER signature to 64-byte r||s and passes raw through', () => {
    const der = b64([0x30, 0x07, 0x02, 0x02, 0x00, 0x80, 0x02, 0x01, 0x01]);
    expect(toP1363Signature(der).length).toBe(86); // 64 bytes in base64url
    const sixtyFour = b64(new Array(64).fill(7));
    expect(toP1363Signature(sixtyFour)).toBe(sixtyFour.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
    expect(() => toP1363Signature(b64([0x31, 0x00]))).toThrow();
  });

  it('wraps a keystore as a DeviceKeySigner', async () => {
    const signer = createDeviceKeySigner({
      createKey: async () => b64(point),
      sign: async () => b64(new Array(64).fill(1)),
    });
    expect((await signer.createKey({ biometric: true })).kty).toBe('EC');
    expect((await signer.sign('m')).length).toBe(86);
  });
});

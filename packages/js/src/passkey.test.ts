import { describe, expect, it, vi } from 'vitest';
import {
  base64UrlToBuffer,
  bufferToBase64Url,
  createPasskey,
  getPasskeyAssertion,
  type WebAuthnHost,
} from './passkey';

const bytes = (arr: number[]) => new Uint8Array(arr).buffer;

describe('base64url round-trip', () => {
  it('encodes and decodes without padding, url-safe', () => {
    const b = bytes([251, 252, 48, 7, 21, 78]); // produces + and / in std base64
    const enc = bufferToBase64Url(b);
    expect(enc).not.toMatch(/[+/=]/);
    expect(new Uint8Array(base64UrlToBuffer(enc))).toEqual(new Uint8Array(b));
  });

  it('decodes a value the server would send (padded or not)', () => {
    expect(new Uint8Array(base64UrlToBuffer('AQID'))).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('createPasskey', () => {
  it('builds create() options from begin, and returns the finish body', async () => {
    let seen: PublicKeyCredentialCreationOptions | undefined;
    const host: WebAuthnHost = {
      credentials: {
        create: vi.fn(async (o) => {
          seen = o.publicKey;
          return {
            rawId: bytes([9, 9]),
            id: 'CQk',
            response: {
              attestationObject: bytes([1, 2, 3]),
              clientDataJSON: bytes([4, 5, 6]),
            },
          } as unknown as Credential;
        }),
        get: vi.fn(),
      },
    };

    const begin = {
      challenge: 'Y2hhbA', // "chal"
      rp: { id: 'acme.test', name: 'Acme' },
      user: { id: bufferToBase64Url(bytes([117, 49])), name: 'u', displayName: 'U' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      excludeCredentials: [{ type: 'public-key', id: bufferToBase64Url(bytes([1])) }],
    };

    const body = await createPasskey(begin, { name: 'My Key', host });

    // The challenge + excludeCredentials ids were decoded to ArrayBuffers for the API.
    expect(seen!.challenge).toBeInstanceOf(ArrayBuffer);
    expect((seen!.user as { id: ArrayBuffer }).id).toBeInstanceOf(ArrayBuffer);
    expect(seen!.excludeCredentials![0]!.id).toBeInstanceOf(ArrayBuffer);
    // The finish body echoes the challenge and base64url-encodes the results.
    expect(body.challenge).toBe('Y2hhbA');
    expect(body.attestation_object).toBe(bufferToBase64Url(bytes([1, 2, 3])));
    expect(body.client_data_json).toBe(bufferToBase64Url(bytes([4, 5, 6])));
    expect(body.name).toBe('My Key');
  });

  it('throws when the ceremony is cancelled (null credential)', async () => {
    const host: WebAuthnHost = { credentials: { create: vi.fn(async () => null), get: vi.fn() } };
    await expect(
      createPasskey(
        { challenge: 'Y2hhbA', rp: { id: 'a', name: 'A' }, user: { id: 'AAAA', name: 'u', displayName: 'U' } },
        { host },
      ),
    ).rejects.toThrow(/cancelled/);
  });
});

describe('getPasskeyAssertion', () => {
  it('builds get() options and returns the finish body, passing handle/challenge through', async () => {
    let seenMediation: string | undefined;
    const host: WebAuthnHost = {
      credentials: {
        create: vi.fn(),
        get: vi.fn(async (o) => {
          seenMediation = (o as { mediation?: string }).mediation;
          return {
            rawId: bytes([7, 7, 7]),
            id: 'Bwcc',
            response: {
              authenticatorData: bytes([10]),
              clientDataJSON: bytes([20]),
              signature: bytes([30]),
            },
          } as unknown as Credential;
        }),
      },
    };
    const begin = {
      handle: 'wa_abc',
      challenge: 'Y2hhbA',
      rpId: 'acme.test',
      allowCredentials: [],
      userVerification: 'preferred',
    };

    const body = await getPasskeyAssertion(begin, { host, mediation: 'conditional' });
    expect(seenMediation).toBe('conditional');
    expect(body.handle).toBe('wa_abc');
    expect(body.challenge).toBe('Y2hhbA');
    expect(body.credential_id).toBe(bufferToBase64Url(bytes([7, 7, 7])));
    expect(body.authenticator_data).toBe(bufferToBase64Url(bytes([10])));
    expect(body.signature).toBe(bufferToBase64Url(bytes([30])));
  });
});

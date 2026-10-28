import { describe, expect, it, vi } from 'vitest';
import { createPasskey, getPasskeyAssertion, passkeyExtensionsInput, type PasskeyExtensionResults, type WebAuthnHost } from './passkey';

const bytes = (arr: number[]) => new Uint8Array(arr).buffer;
const PRF_OUT = new Uint8Array(32).fill(7).buffer;

function hostWith(extensions: Record<string, unknown>) {
  const seen: { create?: PublicKeyCredentialCreationOptions; get?: PublicKeyCredentialRequestOptions } = {};
  const credential = (response: Record<string, unknown>) =>
    ({ rawId: bytes([9, 9]), id: 'CQk', response, getClientExtensionResults: () => extensions }) as unknown as Credential;
  const host: WebAuthnHost = {
    credentials: {
      create: vi.fn(async (o) => {
        seen.create = o.publicKey;
        return credential({ attestationObject: bytes([1]), clientDataJSON: bytes([2]) });
      }),
      get: vi.fn(async (o) => {
        seen.get = o.publicKey;
        return credential({ authenticatorData: bytes([3]), clientDataJSON: bytes([4]), signature: bytes([5]) });
      }),
    },
  };
  return { host, seen };
}

const createBegin = {
  challenge: 'Y2hhbA',
  rp: { id: 'acme.test', name: 'Acme' },
  user: { id: 'dTE', name: 'u', displayName: 'U' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
};

describe('passkey PRF extension', () => {
  it('encodes string salts as UTF-8 and only passes evalByCredential on sign-in', () => {
    const create = passkeyExtensionsInput({ eval: { first: 'app:key:v1' }, evalByCredential: { CQk: { first: 'x' } } }, 'create');
    expect(create).toEqual({ prf: { eval: { first: new TextEncoder().encode('app:key:v1') } } });
    const get = passkeyExtensionsInput({ evalByCredential: { CQk: { first: new Uint8Array([1, 2]), second: 'y' } } }, 'get');
    expect(get).toEqual({ prf: { evalByCredential: { CQk: { first: new Uint8Array([1, 2]), second: new TextEncoder().encode('y') } } } });
    expect(passkeyExtensionsInput(undefined, 'get')).toBeUndefined();
  });

  it('registration: requests prf, hands the results to the app, and keeps them out of the finish body', async () => {
    const { host, seen } = hostWith({ prf: { enabled: true, results: { first: PRF_OUT } } });
    let got: PasskeyExtensionResults | undefined;
    const body = await createPasskey(createBegin, { host, prf: { eval: { first: 'vault' } }, onExtensionResults: (r) => (got = r) });
    expect((seen.create as unknown as { extensions: { prf: unknown } }).extensions.prf).toEqual({ eval: { first: new TextEncoder().encode('vault') } });
    expect(got).toEqual({ credentialId: 'CQk', prf: { enabled: true, results: { first: new Uint8Array(PRF_OUT) } } });
    expect(Object.keys(body).sort()).toEqual(['attestation_object', 'challenge', 'client_data_json']);
    expect(JSON.stringify(body)).not.toContain('prf');
  });

  it('sign-in: requests prf and returns both outputs to the app only', async () => {
    const second = new Uint8Array(32).fill(9).buffer;
    const { host, seen } = hostWith({ prf: { results: { first: PRF_OUT, second } } });
    let got: PasskeyExtensionResults | undefined;
    const body = await getPasskeyAssertion(
      { handle: 'h', challenge: 'Y2hhbA', rpId: 'acme.test' },
      { host, prf: { eval: { first: 'a', second: 'b' } }, onExtensionResults: (r) => (got = r) },
    );
    expect((seen.get as unknown as { extensions: { prf: { eval: unknown } } }).extensions.prf.eval).toBeTruthy();
    expect(got!.prf!.results!.first).toEqual(new Uint8Array(PRF_OUT));
    expect(got!.prf!.results!.second).toEqual(new Uint8Array(second));
    expect(JSON.stringify(body)).not.toContain('prf');
  });

  it('no prf requested: no extensions member, and an authenticator without PRF reports nothing', async () => {
    const { host, seen } = hostWith({});
    let got: PasskeyExtensionResults | undefined;
    await getPasskeyAssertion({ handle: 'h', challenge: 'Y2hhbA' }, { host, onExtensionResults: (r) => (got = r) });
    expect(seen.get).not.toHaveProperty('extensions');
    expect(got).toEqual({ credentialId: 'CQk' });
  });
});

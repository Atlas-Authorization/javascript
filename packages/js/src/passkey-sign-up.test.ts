import { describe, expect, it, vi } from 'vitest';
import { FapiClient, initialFlow, shouldKeepPolling } from './fapi';
import { awaitingPasskey, registerSignUpPasskey, startPasskeySignUp } from './passkey-sign-up';
import { createPasskeySignUp, finishPasskeySignUp } from './captcha-controller';
import type { WebAuthnHost } from './passkey';
import type { AttemptView } from './attempt';

const bytes = (arr: number[]) => new Uint8Array(arr).buffer;

function scripted(route: (path: string, body: Record<string, unknown> | null) => { status?: number; body: unknown }) {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ path: url.pathname, body });
    const out = route(url.pathname, body);
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://f.example', fetchImpl, referral: false }), calls };
}

const WAITING: AttemptView & { strategy: string; poll_secret: string } = {
  id: 'sua_1',
  object: 'sign_up_attempt',
  status: 'needs_first_factor',
  strategy: 'passkey',
  supported_first_factors: ['passkey'],
  poll_secret: 'ps_1',
};

const BEGIN = {
  challenge: 'Y2hhbGxlbmdl',
  rp: { id: 'example.com', name: 'Atlas' },
  user: { id: 'dXNlcl8x', name: 'user_1', displayName: 'user_1' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  excludeCredentials: [],
};

const host = (create: WebAuthnHost['credentials']['create']): WebAuthnHost => ({ credentials: { create, get: vi.fn() } });
const madeCredential = async () =>
  ({ rawId: bytes([1]), response: { attestationObject: bytes([1, 2, 3]), clientDataJSON: bytes([4, 5, 6]) } }) as unknown as Credential;

describe('startPasskeySignUp', () => {
  it('posts no password, only what was given, and keeps the poll secret', async () => {
    const { client, calls } = scripted(() => ({ status: 201, body: WAITING }));
    const flow = await startPasskeySignUp(client, { fields: { company: 'Acme' }, consent: true });
    expect(calls[0]).toEqual({ path: '/v1/client/sign_ups/passkey', body: { fields: { company: 'Acme' }, consent: true } });
    expect(flow.pollSecret).toBe('ps_1');
    expect(awaitingPasskey(flow.attempt)).toBe(true);
    // Only this tab can move it on now: no point polling.
    expect(shouldKeepPolling(flow)).toBe(false);
  });

  it('a needs_email_verification attempt is not awaiting the passkey yet, and polls in link mode', async () => {
    const { client } = scripted(() => ({
      status: 201,
      body: { id: 'sua_2', object: 'sign_up_attempt', status: 'needs_email_verification', strategy: 'passkey', poll_secret: 'ps_2' },
    }));
    const flow = await startPasskeySignUp(client, { email: 'a@example.com' });
    expect(awaitingPasskey(flow.attempt)).toBe(false);
    expect(shouldKeepPolling(flow)).toBe(true);
  });

  it('returns the server errors with no attempt', async () => {
    const { client } = scripted(() => ({ status: 422, body: { errors: [{ code: 'STRATEGY_DISABLED', message: 'off' }] } }));
    const flow = await startPasskeySignUp(client, {});
    expect(flow.attempt).toBeNull();
    expect(flow.errors[0]?.code).toBe('STRATEGY_DISABLED');
  });
});

describe('registerSignUpPasskey', () => {
  it('begin → create → finish, carrying the poll secret, and returns the ticket', async () => {
    const { client, calls } = scripted((path) =>
      path.endsWith('/passkey/begin')
        ? { status: 201, body: BEGIN }
        : { body: { id: 'sua_1', object: 'sign_up_attempt', status: 'complete', ticket: 'tkt_1' } },
    );
    const create = vi.fn(madeCredential);
    const done = await registerSignUpPasskey(client, { ...initialFlow, attempt: WAITING, pollSecret: 'ps_1' }, { host: host(create) });
    expect(calls.map((c) => c.path)).toEqual(['/v1/client/sign_ups/sua_1/passkey/begin', '/v1/client/sign_ups/sua_1/passkey/finish']);
    expect(calls[0]!.body).toEqual({ poll_secret: 'ps_1' });
    expect(calls[1]!.body).toMatchObject({ poll_secret: 'ps_1', challenge: 'Y2hhbGxlbmdl', attestation_object: 'AQID', client_data_json: 'BAUG' });
    expect(done.attempt?.status).toBe('complete');
    expect(done.ticket).toBe('tkt_1');
  });

  it('a cancelled prompt is an error on the kept attempt, never a throw; nothing is finished', async () => {
    const { client, calls } = scripted(() => ({ status: 201, body: BEGIN }));
    const create = vi.fn(async () => {
      throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError');
    });
    const out = await finishPasskeySignUp(
      client,
      { ...initialFlow, attempt: WAITING, pollSecret: 'ps_1' },
      { t: (k) => (k === 'signUp.passkeyCancelled' ? 'Not created.' : k), host: host(create) },
    );
    expect(out.attempt).toEqual(WAITING);
    expect(out.errors).toEqual([{ code: 'PASSKEY_CANCELLED', message: 'Not created.' }]);
    expect(calls.some((c) => c.path.endsWith('/finish'))).toBe(false);
  });

  it('refuses without the poll secret', async () => {
    const { client, calls } = scripted(() => ({ body: {} }));
    const out = await registerSignUpPasskey(client, { ...initialFlow, attempt: WAITING, pollSecret: null });
    expect(out.errors[0]?.code).toBe('INVALID_STATE');
    expect(calls).toHaveLength(0);
  });
});

describe('createPasskeySignUp', () => {
  it('sends the email (when given) and fields, never a password', async () => {
    const { client, calls } = scripted(() => ({ status: 201, body: WAITING }));
    await createPasskeySignUp(client, { email: 'p@example.com', password: 'leftover', company: 'Acme', note: '' }, { consent: true, t: (k) => k });
    expect(calls[0]!.body).toEqual({ email: 'p@example.com', fields: { company: 'Acme' }, consent: true });
  });
});

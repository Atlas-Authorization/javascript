import { describe, expect, it, vi } from 'vitest';
import { FapiClient, advance, initialFlow, requestForStep } from './fapi';
import { accountUxFrom } from './environment';
import {
  acknowledgeRecoveryCodes,
  copyRecoveryCodes,
  createMfaEnrollment,
  enrollmentOptionKey,
  enrollmentSubmitKey,
  pendingRecoveryCodes,
  recoveryCodesFrom,
  recoveryCodesText,
  groupSetupKey,
  mfaChoicesFrom,
  prepareSecondFactorCode,
  type MfaChoices,
  passkeyRunsHere, holdsPasskeySecondFactor, holdsSecondFactor, sendOnlyWaySecondFactorCode, secondFactorSendText } from './mfa-enrollment';
import type { WebAuthnHost } from './passkey';

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

const PREPARE = '/v1/client/sign_ins/sia_1/prepare_mfa_enrollment';
const TOTP = {
  object: 'mfa_enrollment',
  strategy: 'totp',
  factor_id: 'mfa_t',
  secret: 'JBSWY3DPEHPK3PXP',
  uri: 'otpauth://totp/x',
  qr_code: 'data:image/gif;base64,R0lG',
};
const SMS = { object: 'mfa_enrollment', strategy: 'phone_code', factor_id: 'mfa_s', phone: '+1•••••0101' };
const BOTH: MfaChoices = { totp: true, sms: true, emailCode: false, totpCodes: 1 };
const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('mfaChoicesFrom', () => {
  it('reads account.mfa, and offers the authenticator app only when the server does not say', () => {
    expect(mfaChoicesFrom(accountUxFrom({ account: { email_second_factor: true, mfa: { totp: true, sms: true, totp_codes: 1 } } }))).toEqual({
      totp: true,
      sms: true,
      emailCode: true,
      totpCodes: 1,
    });
    expect(mfaChoicesFrom(accountUxFrom({ account: { mfa: { totp: false, sms: true, totp_codes: 2 } } }))).toMatchObject({ totp: false, sms: true, totpCodes: 2 });
    expect(mfaChoicesFrom(accountUxFrom({ account: {} }))).toEqual({ totp: true, sms: false, emailCode: false, totpCodes: 2 });
    expect(mfaChoicesFrom(null)).toEqual({ totp: true, sms: false, emailCode: false, totpCodes: 2 });
  });
});

describe('createMfaEnrollment', () => {
  it('with only the authenticator app, fetches its setup (QR included) as soon as the step starts', async () => {
    const { client, calls } = scripted(() => ({ status: 201, body: TOTP }));
    const enrol = createMfaEnrollment(client, { ...BOTH, sms: false });
    enrol.start('sia_1');
    await tick();
    expect(calls).toEqual([{ path: PREPARE, body: { strategy: 'totp' } }]);
    expect(enrol.state.method).toBe('totp');
    expect(enrol.state.enrollment).toEqual({
      strategy: 'totp',
      factorId: 'mfa_t',
      secret: 'JBSWY3DPEHPK3PXP',
      uri: 'otpauth://totp/x',
      qrCode: 'data:image/gif;base64,R0lG',
    });
    expect(await enrol.submit({ code: '123456', secondCode: '' })).toEqual({ factorId: 'mfa_t', code: '123456', secondCode: '' });
    // Starting the same attempt again keeps the setup (no second prepare).
    enrol.start('sia_1');
    expect(calls).toHaveLength(1);
  });

  it('with both on offer, waits for the choice; texts ask for the number, then the code', async () => {
    const { client, calls } = scripted((_p, body) => ({ status: 201, body: body?.strategy === 'phone_code' ? SMS : TOTP }));
    const seen: string[] = [];
    const enrol = createMfaEnrollment(client, BOTH);
    enrol.subscribe((s) => seen.push(s.method ?? 'choose'));
    enrol.start('sia_1');
    await tick();
    expect(calls).toHaveLength(0);
    expect(enrol.state.options).toEqual(['totp', 'phone_code']);
    expect(enrol.state.method).toBeNull();

    await enrol.choose('phone_code');
    expect(calls).toHaveLength(0);
    // The form's submit before a code went out sends the number.
    expect(await enrol.submit({ phone: ' +14155550101 ' })).toBeNull();
    expect(calls[0]).toEqual({ path: PREPARE, body: { strategy: 'phone_code', phone: '+14155550101' } });
    expect(enrol.state.enrollment).toEqual({ strategy: 'phone_code', factorId: 'mfa_s', phone: '+1•••••0101' });

    await enrol.resend();
    expect(calls[1]?.body).toEqual({ strategy: 'phone_code', phone: '+14155550101' });

    const values = await enrol.submit({ code: '654321' });
    expect(values).toEqual({ factorId: 'mfa_s', enrollStrategy: 'phone_code', code: '654321' });
    expect(requestForStep({ id: 'sia_1', status: 'needs_mfa_enrollment' }, values!)).toEqual({
      path: '/v1/client/sign_ins/sia_1/attempt_mfa_enrollment',
      body: { factor_id: 'mfa_s', code: '654321' },
    });
    expect(seen).toContain('phone_code');
  });

  it('an empty number is refused locally; a bad number keeps the option with the server error', async () => {
    const { client, calls } = scripted(() => ({ status: 422, body: { errors: [{ code: 'FORM_PARAM_FORMAT_INVALID', message: 'Use E.164.', param: 'phone' }] } }));
    const enrol = createMfaEnrollment(client, BOTH);
    enrol.start('sia_1');
    await enrol.choose('phone_code');
    await enrol.sendPhone('  ');
    expect(calls).toHaveLength(0);
    expect(enrol.state.errors[0]?.param).toBe('phone');
    await enrol.sendPhone('555');
    expect(enrol.state.errors[0]?.message).toBe('Use E.164.');
    expect(enrol.state.options).toEqual(['totp', 'phone_code']);
    expect(enrol.state.method).toBe('phone_code');
  });

  it('a texted factor the server has turned off is dropped and the authenticator app is prepared', async () => {
    const { client, calls } = scripted((_p, body) =>
      body?.strategy === 'phone_code'
        ? { status: 400, body: { errors: [{ code: 'STRATEGY_DISABLED', message: 'SMS is off.' }] } }
        : { status: 201, body: TOTP },
    );
    const enrol = createMfaEnrollment(client, BOTH);
    enrol.start('sia_1');
    await enrol.choose('phone_code');
    await enrol.sendPhone('+14155550101');
    expect(enrol.state.options).toEqual(['totp']);
    expect(enrol.state.method).toBe('totp');
    expect(enrol.state.enrollment?.factorId).toBe('mfa_t');
    expect(calls.map((c) => c.body?.strategy)).toEqual(['phone_code', 'totp']);
  });

  it('a new attempt starts over; a non-image qr_code is not passed on', async () => {
    const { client } = scripted(() => ({ status: 201, body: { ...TOTP, qr_code: 'javascript:alert(1)' } }));
    const enrol = createMfaEnrollment(client, { ...BOTH, sms: false });
    enrol.start('sia_1');
    await tick();
    expect(enrol.state.enrollment?.qrCode).toBeUndefined();
    enrol.start('sia_2');
    expect(enrol.state.enrollment).toBeNull();
  });
});

describe('prepareSecondFactorCode', () => {
  it('texts the code and returns the masked number; a refusal throws with its code', async () => {
    const ok = scripted(() => ({ status: 201, body: { object: 'second_factor_challenge', strategy: 'sms', sent_to: '+1•••0101' } }));
    await expect(prepareSecondFactorCode(ok.client, 'sia_1', 'sms')).resolves.toEqual({ sentTo: '+1•••0101' });
    expect(ok.calls[0]).toEqual({ path: '/v1/client/sign_ins/sia_1/prepare_second_factor', body: { strategy: 'sms' } });

    const no = scripted(() => ({ status: 404, body: { errors: [{ code: 'NOT_FOUND', message: 'This account has no SMS second factor.' }] } }));
    await expect(prepareSecondFactorCode(no.client, 'sia_1', 'sms')).rejects.toMatchObject({
      message: 'This account has no SMS second factor.',
      code: 'NOT_FOUND',
    });
  });
});

describe('groupSetupKey', () => {
  it('groups the key in fours', () => {
    expect(groupSetupKey('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(groupSetupKey('ABCDE')).toBe('ABCD E');
  });
});

describe('recovery codes after an enrolment', () => {
  const ENROL = { attempt: { id: 'sia_1', status: 'needs_mfa_enrollment' } };

  it('advance moves backup_codes off the attempt into recoveryCodes, held until acknowledged', async () => {
    const { client } = scripted(() => ({
      status: 200,
      body: { id: 'sia_1', status: 'complete', created_session_id: 'sess_1', ticket: 'tkt_1', backup_codes: ['aaaa-1111', 'bbbb-2222', 7, ''] },
    }));
    const next = await advance(client, { ...initialFlow, ...ENROL }, { factorId: 'mfa_t', code: '111111', secondCode: '222222' });
    expect(next.ticket).toBe('tkt_1');
    expect(next.recoveryCodes).toEqual(['aaaa-1111', 'bbbb-2222']);
    expect(next.attempt).not.toHaveProperty('backup_codes');
    expect(JSON.stringify(next.attempt)).not.toContain('aaaa-1111');
    expect(pendingRecoveryCodes(next)).toEqual(['aaaa-1111', 'bbbb-2222']);

    const saved = acknowledgeRecoveryCodes(next);
    expect(pendingRecoveryCodes(saved)).toBeNull();
    expect(saved.recoveryCodes).toBeNull();
    expect(saved.ticket).toBe('tkt_1');
  });

  it('nothing to show without codes, or before the attempt completes', async () => {
    const { client } = scripted(() => ({ status: 200, body: { id: 'sia_1', status: 'complete', ticket: 'tkt_1', backup_codes: [] } }));
    const next = await advance(client, { ...initialFlow, ...ENROL }, { factorId: 'mfa_t', code: '1', secondCode: '2' });
    expect(next).not.toHaveProperty('recoveryCodes');
    expect(pendingRecoveryCodes(next)).toBeNull();
    expect(pendingRecoveryCodes({ attempt: { id: 'sia_1', status: 'needs_mfa_enrollment' }, recoveryCodes: ['x'] })).toBeNull();
    expect(recoveryCodesFrom('abc')).toBeNull();
  });

  it('the text file holds one code per line; copy uses the clipboard and reports failure', async () => {
    expect(recoveryCodesText(['a', 'b'])).toBe('a\nb\n');
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copyRecoveryCodes(['a', 'b'])).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('a\nb');
    writeText.mockRejectedValueOnce(new Error('denied'));
    await expect(copyRecoveryCodes(['a'])).resolves.toBe(false);
    vi.stubGlobal('navigator', {});
    await expect(copyRecoveryCodes(['a'])).resolves.toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('every factor the instance offers at the enrolment step', () => {
  const ALL = { totp: true, sms: true, emailCode: false, totpCodes: 1 as const, hotp: true, yubikey: true, duo: true, passkey: true };
  const host = {
    credentials: {
      create: vi.fn(async () => ({
        response: { attestationObject: new Uint8Array([1]).buffer, clientDataJSON: new Uint8Array([2]).buffer },
        getClientExtensionResults: () => ({}),
      })),
    },
  } as unknown as WebAuthnHost;
  const OPTIONS = {
    challenge: 'Y2g',
    rp: { id: 'x', name: 'x' },
    user: { id: 'dQ', name: 'a', displayName: 'a' },
    pubKeyCredParams: [],
    authenticatorSelection: { userVerification: 'required' },
  };
  const server = (path: string, body: Record<string, unknown> | null) => {
    if (!path.endsWith('/prepare_mfa_enrollment')) return { body: {} };
    if (body?.strategy === 'hotp') return { status: 201, body: { strategy: 'hotp', factor_id: 'mfa_h', secret: 'ABCDEFGH', uri: 'otpauth://hotp/x', qr_code: 'data:image/gif;base64,R0lG' } };
    if (body?.strategy === 'duo') return { status: 201, body: { strategy: 'duo', factor_id: 'mfa_d', authorization_url: 'https://api-1.duosecurity.com/oauth' } };
    if (body?.strategy === 'passkey') return { status: 201, body: { strategy: 'passkey', options: OPTIONS } };
    return { status: 201, body: { strategy: 'totp', factor_id: 'mfa_t', secret: 'ABCD', uri: 'otpauth://totp/x' } };
  };

  it('reads them from account.mfa; an older server offers none of them', () => {
    expect(mfaChoicesFrom(accountUxFrom({ account: { mfa: { totp: true, sms: false, totp_codes: 1, hotp: true, yubikey: true, duo: true, passkey: true } } }))).toMatchObject({ hotp: true, yubikey: true, duo: true, passkey: true });
    const older = mfaChoicesFrom(accountUxFrom({ account: { mfa: { totp: true, sms: false, totp_codes: 1 } } }));
    expect(older).not.toHaveProperty('hotp');
    expect(older).not.toHaveProperty('passkey');
  });

  it('offers all of them, each with its own label', () => {
    const { client } = scripted(server);
    const enrol = createMfaEnrollment(client, ALL, { host });
    expect(enrol.state.options).toEqual(['totp', 'phone_code', 'hotp', 'yubikey', 'duo', 'passkey']);
    expect(enrol.state.options.map(enrollmentOptionKey)).toEqual([
      'mfa.enrollTotpOption',
      'mfa.enrollSmsOption',
      'mfa.enrollHotpOption',
      'mfa.enrollYubikeyOption',
      'mfa.enrollDuoOption',
      'mfa.enrollPasskeyOption',
    ]);
  });

  it('never offers a passkey where the browser has no WebAuthn', () => {
    const { client } = scripted(server);
    vi.stubGlobal('PublicKeyCredential', undefined);
    expect(createMfaEnrollment(client, { ...ALL }).state.options).not.toContain('passkey');
    vi.unstubAllGlobals();
  });

  it('a counter token: set up like the authenticator app, confirmed with one code', async () => {
    const { client, calls } = scripted(server);
    const enrol = createMfaEnrollment(client, ALL, { host });
    enrol.start('sia_1');
    await enrol.choose('hotp');
    expect(calls[0]!.body).toEqual({ strategy: 'hotp' });
    expect(enrol.state.enrollment).toMatchObject({ strategy: 'hotp', factorId: 'mfa_h', secret: 'ABCDEFGH', qrCode: 'data:image/gif;base64,R0lG' });
    expect(enrollmentSubmitKey(enrol.state)).toBe('signIn.submit');
    const values = await enrol.submit({ code: '123456' });
    expect(requestForStep({ id: 'sia_1', status: 'needs_mfa_enrollment' }, values!)!.body).toEqual({ strategy: 'hotp', factor_id: 'mfa_h', code: '123456' });
  });

  it('a YubiKey: nothing to prepare, the touched OTP is the proof', async () => {
    const { client, calls } = scripted(server);
    const enrol = createMfaEnrollment(client, ALL, { host });
    enrol.start('sia_1');
    await enrol.choose('yubikey');
    expect(calls).toHaveLength(0);
    expect(enrollmentSubmitKey(enrol.state)).toBe('signIn.submit');
    const values = await enrol.submit({ otp: 'cccc' });
    expect(requestForStep({ id: 'sia_1', status: 'needs_mfa_enrollment' }, values!)!.body).toEqual({ strategy: 'yubikey', otp: 'cccc' });
  });

  it('Duo: a link to its prompt, then the factor id', async () => {
    const { client } = scripted(server);
    const enrol = createMfaEnrollment(client, ALL, { host });
    enrol.start('sia_1');
    await enrol.choose('duo');
    expect(enrol.state.enrollment?.authorizationUrl).toBe('https://api-1.duosecurity.com/oauth');
    const values = await enrol.submit({});
    expect(requestForStep({ id: 'sia_1', status: 'needs_mfa_enrollment' }, values!)!.body).toEqual({ strategy: 'duo', factor_id: 'mfa_d' });
  });

  it('Duo: a URL that is not https is never linked', async () => {
    const { client } = scripted(() => ({ status: 201, body: { factor_id: 'mfa_d', authorization_url: 'javascript:alert(1)' } }));
    const enrol = createMfaEnrollment(client, ALL, { host });
    enrol.start('sia_1');
    await enrol.choose('duo');
    expect(enrol.state.enrollment?.authorizationUrl).toBeUndefined();
  });

  it('a passkey: prepared at once, the ceremony runs from the submit, no factor id is needed', async () => {
    const { client } = scripted(server);
    const enrol = createMfaEnrollment(client, ALL, { host });
    enrol.start('sia_1');
    await enrol.choose('passkey');
    expect(enrol.state.enrollment).toMatchObject({ strategy: 'passkey', factorId: '', passkeyOptions: OPTIONS });
    expect(enrollmentSubmitKey(enrol.state)).toBe('mfa.enrollPasskeyCreate');
    const values = await enrol.submit({});
    expect(requestForStep({ id: 'sia_1', status: 'needs_mfa_enrollment' }, values!)!.body).toEqual({
      strategy: 'passkey',
      challenge: 'Y2g',
      attestation_object: 'AQ',
      client_data_json: 'Ag',
    });
  });

  it('holdsSecondFactor asks once per attempt, whichever factors are asked about', async () => {
    const get = vi.fn(async () => ({ ok: true, status: 200, data: { factors: ['totp'] }, errors: [] }));
    const client = { get } as never;
    expect(await holdsSecondFactor(client, 'sia_1', 'sms')).toBe(false);
    expect(await holdsSecondFactor(client, 'sia_1', 'email_code')).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
    await holdsSecondFactor(client, 'sia_2', 'sms');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('a limited send says how long to wait, on arrival and on a press', async () => {
    const limited = { post: async () => ({ ok: false, status: 429, data: null, errors: [{ code: 'RATE_LIMITED', message: 'Too many', meta: { retry_after: 12.5 } }] }) } as never;
    const waits: number[] = [];
    expect(await sendOnlyWaySecondFactorCode(limited, 'sia_1', 'sms', (s) => waits.push(s))).toBeNull();
    expect(waits).toEqual([13]);
    const t = (_key: 'mfa.codeWait', vars: { seconds: string }) => `wait ${vars.seconds}`;
    const failure = await prepareSecondFactorCode(limited, 'sia_1', 'sms').catch((e: unknown) => e);
    expect(secondFactorSendText(failure, t)).toBe('wait 13');
    expect(secondFactorSendText(new Error('no route'), t)).toBe('no route');
  });

  it('holdsPasskeySecondFactor reads the answer, and anything unanswered as yes', async () => {
    const answer = (status: number, body: unknown) => ({ get: async () => ({ ok: status === 200, status, data: body, errors: [] }) }) as never;
    expect(await holdsPasskeySecondFactor(answer(200, { factors: ['totp'] }), 'sia_1')).toBe(false);
    expect(await holdsPasskeySecondFactor(answer(200, { factors: ['passkey'] }), 'sia_1')).toBe(true);
    expect(await holdsPasskeySecondFactor(answer(500, null), 'sia_1')).toBe(true);
    expect(await holdsPasskeySecondFactor({ get: async () => { throw new Error('down'); } } as never, 'sia_1')).toBe(true);
  });

  it('stays on the number step with the message when a number is refused', async () => {
    const refused = { code: 'MFA_SETUP_UNAVAILABLE', message: 'Use a test number.' };
    const { client, calls } = scripted(() => ({ status: 409, body: { errors: [refused] } }));
    const enrol = createMfaEnrollment(client, { totp: true, sms: true, emailCode: false, totpCodes: 1 });
    enrol.start('sia_1');
    await tick();
    await enrol.choose('phone_code');
    expect(await enrol.submit({ phone: '+14155552671' })).toBeNull();
    expect(calls).toHaveLength(1);
    expect(enrol.state.method).toBe('phone_code');
    expect(enrol.state.options).toEqual(['totp', 'phone_code']);
    expect(enrol.state.errors[0]?.message).toBe('Use a test number.');
  });

  describe('a page a passkey cannot run on', () => {
    const ceremony = { rpId: 'clerk.example.test', origins: ['https://listed.example'], hostedSignInUrl: 'https://clerk.example.test/hosted/sign-in' };

    it('knows the RP rule: the RP ID, under it, or a related origin', () => {
      expect(passkeyRunsHere(ceremony, 'https://clerk.example.test')).toBe(true);
      expect(passkeyRunsHere(ceremony, 'https://a.clerk.example.test')).toBe(true);
      expect(passkeyRunsHere(ceremony, 'https://listed.example')).toBe(true);
      expect(passkeyRunsHere(ceremony, 'http://localhost:3000')).toBe(false);
      expect(passkeyRunsHere(ceremony, 'https://notclerk.example.test')).toBe(false);
      expect(passkeyRunsHere(undefined, 'http://localhost:3000')).toBe(true);
    });

    it('does not count a listed localhost or plain http origin: the browser refuses those', () => {
      const listed = { ...ceremony, origins: ['http://localhost:3000', 'http://app.example', 'https://listed.example'] };
      expect(passkeyRunsHere(listed, 'http://localhost:3000')).toBe(false);
      expect(passkeyRunsHere(listed, 'http://app.example')).toBe(false);
      expect(passkeyRunsHere(listed, 'https://listed.example')).toBe(true);
    });

    it('leaves passkey out where another factor can be set up', () => {
      const enrol = createMfaEnrollment(scripted(server).client, { ...ALL, passkeyCeremony: ceremony }, { host, origin: 'http://localhost:3000' });
      expect(enrol.state.options).not.toContain('passkey');
    });

    const onPage = () => vi.stubGlobal('window', { location: { href: 'http://localhost:3000/in?__atlas_status=x', origin: 'http://localhost:3000' } });

    it('sends the step to the hosted page when a passkey is the only factor', () => {
      onPage();
      const navigate = vi.fn();
      const only = { totp: false, sms: false, emailCode: false, totpCodes: 1 as const, passkey: true, passkeyCeremony: ceremony };
      const enrol = createMfaEnrollment(scripted(server).client, only, { host, origin: 'http://localhost:3000', navigate });
      enrol.start('sia_1');
      const url = new URL(navigate.mock.calls[0]![0] as string);
      expect(url.origin + url.pathname).toBe('https://clerk.example.test/hosted/sign-in');
      expect(url.searchParams.get('__atlas_attempt')).toBe('sia_1');
      expect(url.searchParams.get('__atlas_status')).toBe('needs_mfa_enrollment');
      expect(url.searchParams.get('__atlas_handoff')).toBe('1');
      expect(url.searchParams.get('redirect_url')).toBe('http://localhost:3000/in');
      vi.unstubAllGlobals();
    });

    it('a ceremony the browser refuses for the origin goes to the hosted page, never showing its error', async () => {
      onPage();
      const navigate = vi.fn();
      const refusing = {
        credentials: {
          create: vi.fn(async () => {
            throw Object.assign(new Error('The relying party ID is not a registrable domain suffix'), { name: 'SecurityError' });
          }),
        },
      } as unknown as WebAuthnHost;
      const only = { totp: false, sms: false, emailCode: false, totpCodes: 1 as const, passkey: true, passkeyCeremony: ceremony };
      const enrol = createMfaEnrollment(scripted(server).client, only, { host: refusing, origin: 'https://listed.example', navigate });
      enrol.start('sia_1');
      await vi.waitFor(() => expect(enrol.state.enrollment).not.toBeNull());
      expect(await enrol.submit({})).toBeNull();
      expect(navigate).toHaveBeenCalledOnce();
      expect(JSON.stringify(enrol.state.errors)).not.toContain('relying party');
      vi.unstubAllGlobals();
    });
  });

  it('a passkey this device already holds signs for the factor; any other failure stays a failure', async () => {
    const held = { challenge: 'c2ln', rpId: 'x', allowCredentials: [], userVerification: 'required' };
    const heldServer = (path: string, body: Record<string, unknown> | null) =>
      body?.strategy === 'passkey' ? { status: 201, body: { strategy: 'passkey', options: OPTIONS, assertion_options: held } } : server(path, body);
    const bytes = () => new Uint8Array([1]).buffer;
    const signingHost = {
      credentials: {
        create: vi.fn(async () => {
          throw Object.assign(new Error('exists'), { name: 'InvalidStateError' });
        }),
        get: vi.fn(async () => ({ rawId: bytes(), response: { authenticatorData: bytes(), clientDataJSON: bytes(), signature: bytes() } })),
      },
    } as unknown as WebAuthnHost;
    const enrol = createMfaEnrollment(scripted(heldServer).client, { ...ALL, passkey: true }, { host: signingHost });
    enrol.start('sia_1');
    await enrol.choose('passkey');
    const values = await enrol.submit({});
    expect(requestForStep({ id: 'sia_1', status: 'needs_mfa_enrollment' }, values!)!.body).toEqual({
      strategy: 'passkey',
      challenge: 'c2ln',
      credential_id: 'AQ',
      authenticator_data: 'AQ',
      client_data_json: 'AQ',
      signature: 'AQ',
    });

    (signingHost.credentials.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('cancelled'));
    const cancelled = createMfaEnrollment(scripted(heldServer).client, { ...ALL, passkey: true }, { host: signingHost });
    cancelled.start('sia_1');
    await cancelled.choose('passkey');
    expect(await cancelled.submit({})).toBeNull();
    expect(cancelled.state.errors[0]).toMatchObject({ code: 'PASSKEY_CANCELLED' });
  });

  it('a passkey retry after a refusal fetches a fresh challenge; a cancelled prompt keeps the unspent one', async () => {
    const { client, calls } = scripted(server);
    const enrol = createMfaEnrollment(client, ALL, { host });
    enrol.start('sia_1');
    await enrol.choose('passkey');
    (host.credentials.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('cancelled'));
    expect(await enrol.submit({})).toBeNull();
    expect(enrol.state.errors[0]).toMatchObject({ code: 'PASSKEY_CANCELLED', message: 'cancelled' });
    expect(calls).toHaveLength(1);
    await enrol.submit({});
    expect(calls).toHaveLength(1);
    await enrol.submit({});
    expect(calls).toHaveLength(2);
  });

  it('a factor refused as off is dropped from what is offered', async () => {
    const { client } = scripted(() => ({ status: 422, body: { errors: [{ code: 'STRATEGY_DISABLED', message: 'Off.', param: 'strategy' }] } }));
    const enrol = createMfaEnrollment(client, { ...ALL, sms: false, yubikey: false, passkey: false, totp: false }, { host });
    enrol.start('sia_1');
    await enrol.choose('duo');
    expect(enrol.state.options).toEqual(['hotp']);
  });
});

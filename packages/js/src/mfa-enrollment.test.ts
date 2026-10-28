import { describe, expect, it, vi } from 'vitest';
import { FapiClient, advance, initialFlow, requestForStep } from './fapi';
import { accountUxFrom } from './environment';
import {
  acknowledgeRecoveryCodes,
  copyRecoveryCodes,
  createMfaEnrollment,
  pendingRecoveryCodes,
  recoveryCodesFrom,
  recoveryCodesText,
  groupSetupKey,
  mfaChoicesFrom,
  prepareSecondFactorCode,
  type MfaChoices,
} from './mfa-enrollment';

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

  it('a texted factor the server cannot set up is dropped and the authenticator app is prepared', async () => {
    const { client, calls } = scripted((_p, body) =>
      body?.strategy === 'phone_code'
        ? { status: 409, body: { errors: [{ code: 'INTERNAL', message: 'No SMS provider.' }] } }
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

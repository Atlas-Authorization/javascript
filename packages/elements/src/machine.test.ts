import { describe, expect, it, vi } from 'vitest';
import type { AttemptView, FieldError } from '@atlasauth/js';
import {
  bindField,
  fieldError,
  oauthProviderOf,
  runAction,
  signUpEmailUnavailable,
  stepForAttempt,
  stepMatches,
  strategyAvailable,
  type FlowActions,
} from './machine';

/**
 * These mirror `@atlasauth/react`'s test bar (`packages/react/src/flow.test.ts`):
 * the headless flow's every real decision is a pure function, so it is tested
 * without a DOM. The three primitives the library promises —
 *   • a Step renders only when it matches the server status,
 *   • a Field wires value/onChange and surfaces the attempt's field error,
 *   • an Action calls the right attempt method,
 * — are exactly `stepMatches` / `bindField` / `runAction` here.
 */

const attempt = (status: string, extra: Partial<AttemptView> = {}): AttemptView => ({
  id: 'sia_test',
  status,
  ...extra,
});

describe('stepForAttempt maps each server status to one Clerk-Elements step', () => {
  it('is `start` before any attempt exists (the identifier screen)', () => {
    expect(stepForAttempt(null)).toBe('start');
  });

  it('routes every known status through the @atlasauth/js nextStep mapping', () => {
    expect(stepForAttempt(attempt('needs_identifier'))).toBe('start');
    expect(stepForAttempt(attempt('needs_captcha'))).toBe('start');
    expect(stepForAttempt(attempt('needs_first_factor'))).toBe('first-factor');
    expect(stepForAttempt(attempt('needs_second_factor'))).toBe('second-factor');
    expect(stepForAttempt(attempt('needs_mfa_enrollment'))).toBe('mfa-enrollment');
    expect(stepForAttempt(attempt('needs_email_verification'))).toBe('verifications');
    expect(stepForAttempt(attempt('needs_new_password'))).toBe('reset-password');
    expect(stepForAttempt(attempt('needs_oauth_callback'))).toBe('sso-callback');
    expect(stepForAttempt(attempt('complete'))).toBe('complete');
  });

  it('degrades an abandoned or unknown status to `error`, never a blank match', () => {
    expect(stepForAttempt(attempt('abandoned'))).toBe('error');
    // A status a future server adds that this SDK version has never seen.
    expect(stepForAttempt(attempt('needs_some_new_thing'))).toBe('error');
  });
});

describe('stepMatches — a Step renders only for the current status', () => {
  it('matches exactly one step at a time', () => {
    const a = attempt('needs_first_factor');
    expect(stepMatches(a, 'first-factor')).toBe(true);
    // Every other step name is false for the same attempt.
    for (const name of ['start', 'second-factor', 'verifications', 'complete', 'error'] as const) {
      expect(stepMatches(a, name)).toBe(false);
    }
  });

  it('matches `start` when there is no attempt yet', () => {
    expect(stepMatches(null, 'start')).toBe(true);
    expect(stepMatches(null, 'first-factor')).toBe(false);
  });
});

describe('strategyAvailable — which strategies a Step offers', () => {
  it('offers social + passkey on the start screen, nothing factor-specific', () => {
    expect(strategyAvailable(null, 'oauth_google')).toBe(true);
    expect(strategyAvailable(null, 'passkey')).toBe(true);
    expect(strategyAvailable(null, 'password')).toBe(false);
    expect(strategyAvailable(null, 'email_code')).toBe(false);
  });

  it('offers EXACTLY the server supported_first_factors on a first-factor step', () => {
    const a = attempt('needs_first_factor', { supported_first_factors: ['password', 'email_code'] });
    expect(strategyAvailable(a, 'password')).toBe(true);
    expect(strategyAvailable(a, 'email_code')).toBe(true);
    // A strategy the server did NOT list is never offered (no client-side guess).
    expect(strategyAvailable(a, 'passkey')).toBe(false);
  });

  it('offers no strategy picker on a second-factor / verification step', () => {
    expect(strategyAvailable(attempt('needs_second_factor'), 'password')).toBe(false);
    expect(strategyAvailable(attempt('needs_email_verification'), 'email_code')).toBe(false);
  });
});

describe('strategyAvailable — email delivery', () => {
  const NO_EMAIL = { available: false, passwordReset: false, passwordSignUp: false };
  const ALL = { available: true, passwordReset: true, passwordSignUp: true };
  const ff = attempt('needs_first_factor', { supported_first_factors: ['password', 'email_code', 'email_link'] });

  it('hides email code / link while the app cannot deliver email', () => {
    expect(strategyAvailable(ff, 'email_code', NO_EMAIL)).toBe(false);
    expect(strategyAvailable(ff, 'email_link', NO_EMAIL)).toBe(false);
    expect(strategyAvailable(ff, 'password', NO_EMAIL)).toBe(true);
    expect(strategyAvailable(ff, 'email_code', ALL)).toBe(true);
    // Not loaded yet / an older server: the server's list, unchanged.
    expect(strategyAvailable(ff, 'email_code')).toBe(true);
  });

  it('offers reset_password beside password only while reset emails can be delivered', () => {
    expect(strategyAvailable(ff, 'reset_password', ALL)).toBe(true);
    expect(strategyAvailable(ff, 'reset_password')).toBe(true);
    expect(strategyAvailable(ff, 'reset_password', { ...ALL, passwordReset: false })).toBe(false);
    const codeOnly = attempt('needs_first_factor', { supported_first_factors: ['email_code'] });
    expect(strategyAvailable(codeOnly, 'reset_password', ALL)).toBe(false);
    expect(strategyAvailable(null, 'reset_password', ALL)).toBe(false);
  });

  it('signUpEmailUnavailable reads passwordSignUp, false while unknown', () => {
    expect(signUpEmailUnavailable(NO_EMAIL)).toBe(true);
    expect(signUpEmailUnavailable({ ...NO_EMAIL, passwordSignUp: true })).toBe(false);
    expect(signUpEmailUnavailable(undefined)).toBe(false);
    expect(signUpEmailUnavailable(null)).toBe(false);
  });
});

describe('oauthProviderOf', () => {
  it('extracts the provider from an oauth_ strategy, else null', () => {
    expect(oauthProviderOf('oauth_google')).toBe('google');
    expect(oauthProviderOf('oauth_microsoft')).toBe('microsoft');
    expect(oauthProviderOf('password')).toBeNull();
    expect(oauthProviderOf('passkey')).toBeNull();
  });
});

describe('fieldError + bindField — a Field wires value/onChange and surfaces its error', () => {
  const errors: FieldError[] = [
    { code: 'form_password_incorrect', message: 'Wrong password', param: 'password' },
    { code: 'form_identifier_not_found', message: 'No such account', param: 'identifier' },
    { code: 'rate_limited', message: 'Too many tries' }, // form-level: no param
  ];

  it('surfaces only the error whose param is this field', () => {
    expect(fieldError(errors, 'password')?.message).toBe('Wrong password');
    expect(fieldError(errors, 'identifier')?.code).toBe('form_identifier_not_found');
    // A field with no matching error (and a form-level error) gets none.
    expect(fieldError(errors, 'code')).toBeNull();
  });

  it('binds the current value (defaulting to an empty controlled string)', () => {
    const setValue = vi.fn();
    const bound = bindField('identifier', { identifier: 'a@b.com' }, setValue, errors);
    expect(bound.value).toBe('a@b.com');
    expect(bound.error?.message).toBe('No such account');

    // A field with no value yet is a controlled empty string, never undefined.
    expect(bindField('password', {}, setValue, errors).value).toBe('');
  });

  it('onChange writes the new value straight back through setValue', () => {
    const setValue = vi.fn();
    const bound = bindField('code', {}, setValue, errors);
    bound.onChange('123456');
    expect(setValue).toHaveBeenCalledWith('code', '123456');
  });
});

describe('runAction — an Action calls the right attempt method, and only that one', () => {
  const makeActions = () => {
    const actions: FlowActions = {
      submit: vi.fn(),
      resend: vi.fn(),
      navigate: vi.fn(),
    };
    return actions;
  };

  it('submit → submit()', () => {
    const a = makeActions();
    runAction(a, 'submit');
    expect(a.submit).toHaveBeenCalledOnce();
    expect(a.resend).not.toHaveBeenCalled();
    expect(a.navigate).not.toHaveBeenCalled();
  });

  it('resend → resend()', () => {
    const a = makeActions();
    runAction(a, 'resend');
    expect(a.resend).toHaveBeenCalledOnce();
    expect(a.submit).not.toHaveBeenCalled();
  });

  it('navigate → navigate(target), and is a no-op without a target', () => {
    const a = makeActions();
    runAction(a, 'navigate', '/forgot-password');
    expect(a.navigate).toHaveBeenCalledWith('/forgot-password');

    const b = makeActions();
    runAction(b, 'navigate');
    expect(b.navigate).not.toHaveBeenCalled();
  });
});

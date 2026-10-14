import { describe, expect, it } from 'vitest';
import {
  ATLAS_ERROR_CODES,
  firstErrorMessage,
  hasErrorCode,
  isEmailDeliveryNotConfigured,
} from './errors';
import type { FlowResult } from './types';

const message = "This app can't send email right now. Try another sign-in method or contact the app owner.";

const refused: FlowResult = {
  status: 'error',
  errors: [{ code: 'EMAIL_DELIVERY_NOT_CONFIGURED', message }],
};

describe('error codes', () => {
  it('names EMAIL_DELIVERY_NOT_CONFIGURED', () => {
    expect(ATLAS_ERROR_CODES.EMAIL_DELIVERY_NOT_CONFIGURED).toBe('EMAIL_DELIVERY_NOT_CONFIGURED');
  });

  it('detects the refusal on a result or a bare error list', () => {
    expect(isEmailDeliveryNotConfigured(refused)).toBe(true);
    expect(isEmailDeliveryNotConfigured(refused.errors)).toBe(true);
    expect(isEmailDeliveryNotConfigured({ errors: [{ code: 'VALIDATION_FAILED', message: 'x' }] })).toBe(false);
    expect(isEmailDeliveryNotConfigured(null)).toBe(false);
  });

  it('surfaces the server message verbatim', () => {
    expect(firstErrorMessage(refused)).toBe(message);
    expect(firstErrorMessage({ errors: [] })).toBeNull();
  });

  it('matches unknown codes too', () => {
    expect(hasErrorCode(refused, 'EMAIL_DELIVERY_NOT_CONFIGURED')).toBe(true);
    expect(hasErrorCode([{ code: 'SOMETHING_NEW', message: 'x' }], 'SOMETHING_NEW')).toBe(true);
  });
});

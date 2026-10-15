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

describe('firstErrorMessage in the app language', () => {
  const ES = {
    'error.form_password_incorrect': 'Esas credenciales son incorrectas.',
    'error.form_password_too_short': 'La contraseña debe tener al menos {min_length} caracteres.',
  };

  it('uses the error.<reason> string, with placeholders from meta', () => {
    expect(
      firstErrorMessage(
        [{ code: 'VERIFICATION_FAILED', message: 'Those credentials are incorrect.', reason: 'form_password_incorrect' }],
        ES,
      ),
    ).toBe('Esas credenciales son incorrectas.');
    expect(
      firstErrorMessage(
        [{ code: 'PASSWORD_POLICY', message: 'x', reason: 'form_password_too_short', meta: { min_length: 12 } }],
        ES,
      ),
    ).toBe('La contraseña debe tener al menos 12 caracteres.');
  });

  it('falls back to the server message for an unknown reason', () => {
    expect(firstErrorMessage([{ code: 'X', message: 'Mensaje del servidor.', reason: 'brand_new' }], ES)).toBe(
      'Mensaje del servidor.',
    );
  });
});

import type { FlowResult } from './types';

/**
 * Server error codes the SDK names — the values a `FlowResult.errors[].code`
 * can be compared against without string literals. `code` still carries every
 * code the server sends, known here or not.
 */
export const ATLAS_ERROR_CODES = {
  /**
   * 422 — a flow would send an email (code, link, reset, verification) but the
   * app has no way to deliver it. Refused before anything is issued; the
   * `message` is end-user wording, ready to show as-is.
   */
  EMAIL_DELIVERY_NOT_CONFIGURED: 'EMAIL_DELIVERY_NOT_CONFIGURED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  IDENTIFIER_NOT_FOUND: 'IDENTIFIER_NOT_FOUND',
  IDENTIFIER_EXISTS: 'IDENTIFIER_EXISTS',
  VERIFICATION_EXPIRED: 'VERIFICATION_EXPIRED',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
  PASSWORD_BREACHED: 'PASSWORD_BREACHED',
  PASSWORD_POLICY: 'PASSWORD_POLICY',
  LOCKED: 'LOCKED',
} as const;

export type AtlasErrorCode = (typeof ATLAS_ERROR_CODES)[keyof typeof ATLAS_ERROR_CODES];

type ErrorList = FlowResult['errors'];

const listOf = (input: ErrorList | Pick<FlowResult, 'errors'> | null | undefined): ErrorList =>
  !input ? [] : Array.isArray(input) ? input : (input.errors ?? []);

/** Whether a result (or its error list) carries `code`. */
export function hasErrorCode(
  input: ErrorList | Pick<FlowResult, 'errors'> | null | undefined,
  code: AtlasErrorCode | (string & {}),
): boolean {
  return listOf(input).some((e) => e.code === code);
}

/**
 * True when the app cannot send email (422 `EMAIL_DELIVERY_NOT_CONFIGURED`):
 * nothing was sent. Show {@link firstErrorMessage} and offer another method.
 */
export function isEmailDeliveryNotConfigured(
  input: ErrorList | Pick<FlowResult, 'errors'> | null | undefined,
): boolean {
  return hasErrorCode(input, ATLAS_ERROR_CODES.EMAIL_DELIVERY_NOT_CONFIGURED);
}

/** The first server message — written for end users, so show it verbatim. */
export function firstErrorMessage(
  input: ErrorList | Pick<FlowResult, 'errors'> | null | undefined,
): string | null {
  return listOf(input)[0]?.message ?? null;
}

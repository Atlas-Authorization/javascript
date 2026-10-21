/**
 * The single error type every management-client call throws on a non-2xx.
 *
 * Atlas answers a failed BAPI call with the §9.1 envelope:
 *
 *   { errors: [{ code, message, param?, meta? }] }
 *
 * `code` is the stable, machine-readable part of that contract — integrators
 * branch on it (`LAST_ADMIN`, `NOT_FOUND`, `SCOPE_MISSING`, …) — so it is
 * surfaced first-class here rather than buried in a parsed body. The raw
 * `errors` array and the HTTP `status` are both kept so a caller can inspect
 * `param`/`meta` (e.g. a rate limit's `retry_after`) when they need to.
 */
export interface AtlasErrorItem {
  code: string;
  message: string;
  param?: string;
  meta?: Record<string, unknown>;
}

export class AtlasApiError extends Error {
  override readonly name = 'AtlasApiError';
  /** HTTP status of the failed response. */
  readonly status: number;
  /** The full §9.1 error envelope, in order. */
  readonly errors: AtlasErrorItem[];

  constructor(status: number, errors: AtlasErrorItem[], message?: string) {
    super(message ?? errors[0]?.message ?? `Atlas API request failed with status ${status}`);
    this.status = status;
    this.errors = errors;
    // Restore the prototype chain when compiled down to ES5-era targets so
    // `instanceof AtlasApiError` holds for callers branching on the type.
    Object.setPrototypeOf(this, AtlasApiError.prototype);
  }

  /** The first error's stable code, the field callers branch on most. */
  get code(): string | undefined {
    return this.errors[0]?.code;
  }

  /** True when any error in the envelope carries the given stable code. */
  hasCode(code: string): boolean {
    return this.errors.some((e) => e.code === code);
  }
}

/**
 * Stable error codes worth branching on, as named constants. Any `code` string
 * Atlas returns can be compared with `error.code` / `error.hasCode()` directly;
 * these just save typing them.
 */
export const AtlasErrorCodes = {
  /** Emails cannot be sent: no email provider is configured for the instance. */
  EMAIL_DELIVERY_NOT_CONFIGURED: 'EMAIL_DELIVERY_NOT_CONFIGURED',
  /** This setting needs your own email provider configured first. */
  EMAIL_PROVIDER_REQUIRED: 'EMAIL_PROVIDER_REQUIRED',
  /** The email provider can't be removed while email-dependent features need it (`meta.features`). */
  EMAIL_PROVIDER_IN_USE: 'EMAIL_PROVIDER_IN_USE',
  /** 422 — captcha turned on without its own site key and secret (captcha is bring-your-own-keys). */
  CAPTCHA_KEYS_REQUIRED: 'CAPTCHA_KEYS_REQUIRED',
  /** 409 — removing a captcha key a live flow uses (`meta.flows`); `force=true` turns those flows off. */
  CAPTCHA_IN_USE: 'CAPTCHA_IN_USE',
  /** Strict mode: the body had a field this endpoint does not accept (`param` names it). */
  UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  /** 422 — the body set a field that is not writable on this endpoint (`param` names it; the message names the call that changes it). */
  READ_ONLY_FIELD: 'READ_ONLY_FIELD',
  /** 409 — the development email sender is not available on a production instance. */
  DEVELOPMENT_EMAIL_NOT_ALLOWED: 'DEVELOPMENT_EMAIL_NOT_ALLOWED',
  /** 503 — the development email sender is not available on this deployment. */
  DEVELOPMENT_EMAIL_UNAVAILABLE: 'DEVELOPMENT_EMAIL_UNAVAILABLE',
  /** 429 — the development sender's daily or per-recipient hourly cap is spent (`meta.window`, `meta.retry_after_seconds`). */
  DEVELOPMENT_EMAIL_LIMIT_REACHED: 'DEVELOPMENT_EMAIL_LIMIT_REACHED',
  /** 422 — the development sender sends only Atlas's own sign-in emails, never custom templates. */
  DEVELOPMENT_EMAIL_TEMPLATE_NOT_ALLOWED: 'DEVELOPMENT_EMAIL_TEMPLATE_NOT_ALLOWED',
  /** The billing plan still has subscribers and cannot be removed. */
  PLAN_IN_USE: 'PLAN_IN_USE',
  /** The key is valid but for another API surface (e.g. a platform key on the Backend API). */
  WRONG_KEY_SURFACE: 'WRONG_KEY_SURFACE',
  /** The key is unknown, revoked or malformed. */
  INVALID_KEY: 'INVALID_KEY',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  /** An idempotency key was reused with a different request (e.g. another unit or amount). */
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  /** A usage debit would exceed an API key's spend cap (`allowed: false` on the debit). */
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  SESSION_REVOKED: 'SESSION_REVOKED',
  SESSION_IDLE_EXPIRED: 'SESSION_IDLE_EXPIRED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SCOPE_MISSING: 'SCOPE_MISSING',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
} as const;

/** One of the named {@link AtlasErrorCodes}. */
export type AtlasErrorCode = (typeof AtlasErrorCodes)[keyof typeof AtlasErrorCodes];

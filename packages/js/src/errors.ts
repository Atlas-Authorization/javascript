/**
 * Server errors in the app's language.
 *
 * A Frontend API error carries a human `message` (in English unless the request
 * sent an `Accept-Language` the server has strings for) and, on current
 * servers, a stable `reason` such as `form_password_incorrect`. A prebuilt form
 * looks the reason up as the catalog key `error.<reason>`, so a Spanish form
 * shows a Spanish sentence even when the server answered in English, and an
 * app can reword any error by overriding that one key.
 */

/**
 * The reasons the Frontend API sends that every shipped catalog translates, as
 * `error.<reason>` keys. Listed for docs and coverage checks; a reason missing
 * from this list still renders (as the server's `message`).
 */
export const ERROR_REASONS = Object.freeze([
  'form_password_incorrect',
  'form_code_incorrect',
  'form_code_already_used',
  'form_code_expired',
  'form_code_max_attempts',
  'form_link_invalid',
  'form_identifier_not_found',
  'form_identifier_exists',
  'form_password_pwned',
  'form_password_too_short',
  'form_password_too_long',
  'form_password_requires_uppercase',
  'form_password_requires_lowercase',
  'form_password_requires_number',
  'form_password_requires_symbol',
  'form_password_not_allowed',
  'form_password_contains_identifier',
  'form_password_same_as_current',
  'form_password_reused',
  'password_expired',
  'email_not_verified',
  'sign_in_token_invalid',
  'too_many_attempts',
  'too_many_requests',
  'captcha_required',
  'captcha_failed',
  'captcha_unavailable',
  'email_delivery_unavailable',
  'strategy_disabled',
  'sign_up_restricted',
  'waitlisted',
  'identifier_not_allowed',
  'disposable_email_blocked',
  'sso_required',
  'sign_ins_disabled',
  'sign_ups_disabled',
  'high_risk_blocked',
  'sms_region_blocked',
] as const);

/** A reason with a string in every shipped catalog. */
export type ErrorReason = (typeof ERROR_REASONS)[number];

/** The catalog key for a reason: `error.<reason>`. */
export function errorReasonKey(reason: string): string {
  return `error.${reason}`;
}

/**
 * What {@link localizedErrorMessage} reads strings from: a flat catalog object
 * (`{ 'error.too_many_attempts': '…' }`, or a bundle such as `esES` from
 * `@atlasauth/localizations`) or a lookup function. A function may answer a
 * missing key with `undefined`, `null`, `''` or the key itself (the convention
 * of the prebuilt UIs' `translate`); all four count as "no string". Typed as
 * `object` so an `interface`-typed bundle is accepted without a cast.
 */
export type ErrorStrings = ((key: string) => string | null | undefined) | object;

/** Anything error-shaped: a `FieldError`, an `ApiKeyRequestError`, an `Error`, a server error object. */
export interface ErrorLike {
  reason?: string | null;
  message?: string | null;
  code?: string | null;
  /** Interpolation values for the catalog string (`{min_length}` ← `meta.min_length`). */
  meta?: Readonly<Record<string, unknown>> | null;
}

/** The English fallback of last resort, so the result is never blank. */
const GENERIC_ERROR = 'Something went wrong. Please try again.';

/** A reason is a lower-case token; anything else is never used as a key. */
const REASON = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Fill `{name}` from `meta` (string or finite-number values). Null when a
 * placeholder has no usable value: a sentence with a hole in it is worse than
 * the server's own message, which the server has already filled.
 */
function interpolate(template: string, meta: ErrorLike['meta']): string | null {
  let complete = true;
  const text = template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = meta && Object.prototype.hasOwnProperty.call(meta, name) ? meta[name] : undefined;
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    complete = false;
    return match;
  });
  return complete ? text : null;
}

function lookup(strings: ErrorStrings | null | undefined, key: string): string | null {
  if (!strings) return null;
  let value: unknown;
  if (typeof strings === 'function') {
    value = (strings as (key: string) => unknown)(key);
  } else {
    value = Object.prototype.hasOwnProperty.call(strings, key)
      ? (strings as Record<string, unknown>)[key]
      : undefined;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' || text === key ? null : value;
}

/**
 * The message to show for a server error, in the app's language:
 *
 * 1. the catalog string `error.<reason>`, when the error has a reason and
 *    `strings` has that key, with `{placeholders}` filled from the error's
 *    `meta` (a placeholder `meta` cannot fill skips to step 2);
 * 2. else the server's `message` (localised by the server when the client sent
 *    `Accept-Language` — see `FapiClientOptions.locale`);
 * 3. else the catalog's `error.generic`, else an English generic sentence.
 *
 * Never returns an empty string. `fallback`, when given, is consulted for
 * `error.generic` after `strings` — handy when `strings` is a language layer
 * without the English defaults underneath it.
 */
export function localizedErrorMessage(
  error: ErrorLike | string | null | undefined,
  strings?: ErrorStrings | null,
  fallback?: ErrorStrings | null,
): string {
  const err: ErrorLike = typeof error === 'string' ? { message: error } : (error ?? {});
  const reason = typeof err.reason === 'string' ? err.reason : '';
  if (reason && REASON.test(reason)) {
    const template = lookup(strings, errorReasonKey(reason));
    const text = template ? interpolate(template, err.meta) : null;
    if (text) return text;
  }
  if (typeof err.message === 'string' && err.message.trim() !== '') return err.message;
  return lookup(strings, 'error.generic') ?? lookup(fallback, 'error.generic') ?? GENERIC_ERROR;
}

/**
 * The BCP-47 tag a catalog declares for itself (`@atlasauth/localizations`
 * bundles carry `locale: 'es-ES'`), or undefined. Prebuilt UIs that take a
 * `localization` bundle use it as the `Accept-Language` they send.
 */
export function catalogLocale(catalog: object | null | undefined): string | undefined {
  if (!catalog || typeof catalog !== 'object') return undefined;
  const tag = (catalog as { locale?: unknown }).locale;
  return typeof tag === 'string' && tag.trim() !== '' ? tag : undefined;
}

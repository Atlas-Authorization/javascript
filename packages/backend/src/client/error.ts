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

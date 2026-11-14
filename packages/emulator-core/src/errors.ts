import { ERROR_CATALOG as GENERATED } from './error-catalog';

/** Codes newer than the generated copy; delete an entry once `npm run sync-error-catalog` carries it. */
const ERROR_CATALOG: Record<string, { status: number; title: string }> = { RESYNC_REQUIRED: { status: 410, title: 'Resync required' }, ...GENERATED };

export interface ErrorItem {
  code: string;
  message: string;
  param?: string;
  meta?: Record<string, unknown>;
}

/** An Atlas-shaped failure: status comes from the shared error catalog, never from the call site. */
export class EmulatorError extends Error {
  readonly status: number;
  constructor(
    readonly code: string,
    message: string,
    readonly param?: string,
    readonly extra: Partial<ErrorItem> & { allowed_methods?: string[] } = {},
  ) {
    super(message);
    this.status = ERROR_CATALOG[code]?.status ?? 400;
  }
  items(): ErrorItem[] {
    return [{ code: this.code, message: this.message, ...(this.param ? { param: this.param } : {}), ...this.extra }];
  }
}

export const errorBody = (items: ErrorItem[]) => ({ errors: items });

export function errorResponse(err: EmulatorError, headers: Record<string, string> = {}): Response {
  return Response.json(errorBody(err.items()), { status: err.status, headers });
}

export const notFound = (what: string) => new EmulatorError('NOT_FOUND', `${what} not found.`);

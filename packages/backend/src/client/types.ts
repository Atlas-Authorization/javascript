/**
 * Shapes shared across resource namespaces.
 *
 * The wire is snake_case JSON; these types mirror it exactly (no camelCase
 * translation), because the SDK's job is to type the BAPI, not to invent a
 * second dialect a reader would then have to reconcile against the docs.
 */

/** A free-form metadata bag. The BAPI stores arbitrary JSON objects here. */
export type Metadata = Record<string, unknown>;

/**
 * The `GET /v1/users`-style cursor page: no total, a boolean `has_more`, and an
 * opaque `next_cursor` to pass back as `starting_after`.
 */
export interface CursorPage<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

/** The `{ object: 'list', data, has_more }` envelope some list routes use. */
export interface ListPage<T> {
  object: 'list';
  data: T[];
  has_more?: boolean;
}

/** A bare `{ data }` list with no pagination metadata. */
export interface DataList<T> {
  data: T[];
}

/** Common cursor-pagination params. */
export interface CursorParams {
  /** Page size. Server clamps to its own maximum. */
  limit?: number;
  /** Opaque cursor: the id after which to continue (from `next_cursor`). */
  starting_after?: string;
}

/** A minimal deletion acknowledgement several mutation routes return. */
export interface DeletedObject {
  object: string;
  id: string;
  deleted: true;
}

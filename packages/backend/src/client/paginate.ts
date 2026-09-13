import type { CursorPage, CursorParams } from './types';

/**
 * Walk every page of a cursor-paginated BAPI list, yielding items one at a
 * time. Works with any resource `list` that takes `{ limit?, starting_after? }`
 * and returns a `{ data, has_more, next_cursor }` page — `users.list`,
 * `organizations.list`, `invitations.list`, `auditLogs.list`, `waitlist.list`.
 *
 *   for await (const user of paginate(atlas.users.list)) { ... }
 *
 * Kept as a free function rather than bolted onto every return value: the page
 * is the primitive most callers want, and a caller who needs the whole set
 * opts into the extra round trips explicitly.
 */
export async function* paginate<T, P extends CursorParams>(
  list: (params: P) => Promise<CursorPage<T>>,
  params: P = {} as P,
): AsyncGenerator<T, void, void> {
  let cursor = params.starting_after;
  for (;;) {
    const page = await list({ ...params, starting_after: cursor });
    for (const item of page.data) yield item;
    if (!page.has_more || !page.next_cursor) return;
    cursor = page.next_cursor;
  }
}

/** Collect every page of a cursor-paginated list into a single array. */
export async function collect<T, P extends CursorParams>(
  list: (params: P) => Promise<CursorPage<T>>,
  params: P = {} as P,
): Promise<T[]> {
  const out: T[] = [];
  for await (const item of paginate(list, params)) out.push(item);
  return out;
}

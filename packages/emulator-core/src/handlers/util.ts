/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext } from '../engine';
import { EmulatorError } from '../errors';
import type { Obj } from '../openapi';
import { paginate } from '../store';

export const pageOf = (c: RouteContext) => ({
  limit: Math.min(Math.max(Number(c.query.get('limit') ?? 20) || 20, 1), 100),
  startingAfter: c.query.get('starting_after') ?? undefined,
});

export function listReply<T extends { id: string }>(c: RouteContext, items: T[], present: (t: T) => Obj): { body: Obj } {
  const offset = Number(c.query.get('offset') ?? 0) || 0;
  const rows = offset > 0 ? items.slice(offset) : items;
  const page = paginate(rows, pageOf(c));
  return { body: { object: 'list', data: page.data.map(present), has_more: page.has_more, next_cursor: page.next_cursor } };
}

export const need = (body: Obj, field: string): any => {
  const v = body[field];
  if (v === undefined || v === null || v === '') throw new EmulatorError('VALIDATION_FAILED', `${field} is required.`, field);
  return v;
};

export const merge = (a: Obj | undefined, b: Obj | undefined): Obj => ({ ...(a ?? {}), ...(b ?? {}) });

export const bump = (e: Engine, row: Obj): void => {
  row.updated_at = e.clock.now();
  row.version = (row.version ?? 0) + 1;
};

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'org';

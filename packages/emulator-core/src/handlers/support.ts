/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext } from '../engine';
import { EmulatorError } from '../errors';
import type { Obj } from '../openapi';
import { Table } from '../store';

const resets: Array<(e: Engine) => void> = [];

/** Per-engine state for a handler module; every state made here is cleared by `resetSupport` (engine.reset). */
export function engineState<T>(init: (e: Engine) => T): (e: Engine) => T {
  const map = new WeakMap<Engine, T>();
  resets.push((e) => void map.delete(e));
  return (e) => {
    let s = map.get(e);
    if (!s) map.set(e, (s = init(e)));
    return s;
  };
}
export const resetSupport = (e: Engine): void => resets.forEach((f) => f(e));

/** The session a `Bearer` session token on a client-side route proves: user id and session id. 401 when absent or not valid. */
export async function sessionFromBearer(c: RouteContext): Promise<{ userId: string; sessionId: string; claims: Obj }> {
  const bearer = /^Bearer\s+(.+)$/i.exec(c.request.headers.get('authorization') ?? '')?.[1];
  if (!bearer) throw new EmulatorError('UNAUTHENTICATED', 'Send the session token as `Authorization: Bearer <jwt>`.');
  const v = await c.engine.tokens.verifyAny(bearer);
  if (!v.ok || typeof v.claims.sid !== 'string' || typeof v.claims.sub !== 'string') throw new EmulatorError('UNAUTHENTICATED', 'The session token is not valid.');
  const s = c.engine.db.sessions.get(v.claims.sid);
  if (!s || s.status === 'revoked') throw new EmulatorError('UNAUTHENTICATED', 'That session is no longer valid.');
  return { userId: v.claims.sub, sessionId: v.claims.sid, claims: v.claims };
}

/** A body that is only used for fields that must be strings in a set. */
export function oneOf(body: Obj, field: string, allowed: readonly string[], def?: string): string {
  const v = body[field] ?? def;
  if (typeof v !== 'string' || !allowed.includes(v)) throw new EmulatorError('VALIDATION_FAILED', `${field} must be one of ${allowed.join(', ')}.`, field);
  return v;
}

export const intIn = (v: unknown, field: string, min: number, max: number, def?: number): number => {
  const n = v === undefined || v === null || v === '' ? def : Number(v);
  if (n === undefined || !Number.isInteger(n) || n < min || n > max) throw new EmulatorError('VALIDATION_FAILED', `${field} must be an integer from ${min} to ${max}.`, field);
  return n;
};

export const listBody = (data: Obj[], extra: Obj = {}): Obj => ({ object: 'list', data, has_more: false, next_cursor: null, ...extra });


/** Legal holds, shared by the hold routes and by every route that would erase a user (a held user cannot be deleted). */
export const legalHolds = engineState((e: Engine) => new Table('legal_holds', e.clock.now, 'lhold'));
export const activeHold = (e: Engine, userId: string): Obj | undefined => legalHolds(e).find((h) => h.user_id === userId && !h.released_at);
export function assertNotOnHold(e: Engine, userId: string): void {
  const h = activeHold(e, userId);
  if (h) throw new EmulatorError('LEGAL_HOLD', 'This user is on legal hold and cannot be deleted. Release the hold first.', undefined, { meta: { hold_id: h.id } });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteDef } from '../engine';
import { EmulatorError } from '../errors';
import type { Obj } from '../openapi';
import { resourceServerOf } from './device';
import { revokeSession } from './round2';

/** The event types of the revocation stream, and what each is a revocation of. */
const KIND: Record<string, string> = {
  'session.revoked': 'session',
  'user.sessions_revoked': 'user_sessions',
  'oauth_tokens.revoked': 'token_family',
  'grant.revoked': 'grant',
  'api_key.revoked': 'api_key',
  'machine.revoked': 'machine',
  'machine_grant.revoked': 'machine_grant',
  'user.banned': 'user',
  'user.deactivated': 'user',
  'user.locked': 'user',
};
const KINDS = [...new Set(Object.values(KIND))];
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export const endActor = (type: string | null | undefined, id: string | null | undefined): Obj | null => (type ? { type, id: id ?? null } : null);

/** Soft-end a grant: it stays as a record (reason, actor, time) and no longer verifies. Returns false when it already ended. */
export function endGrant(e: Engine, g: Obj, reason: string, by: Obj): boolean {
  if (g.revoked_at) return false;
  g.revoked_at = e.clock.now();
  g.revoked_reason = reason;
  g.revoked_by = by;
  g.updated_at = g.revoked_at;
  const audience = resourceServerOf(e, g.resource_server_id).identifier;
  e.changed({ type: 'machine_grant.revoked', data: grantPayload(e, g, audience), resource: 'machine_grant', id: g.id, op: 'update' });
  return true;
}

function grantPayload(e: Engine, g: Obj, audience: string | null): Obj {
  return {
    object: 'machine_grant',
    id: g.id,
    machine_id: g.machine_id,
    resource_server_id: g.resource_server_id,
    audience,
    scopes: g.scopes,
    constraints: g.constraints ?? null,
    expires_at: g.expires_at ?? null,
    revoked_at: g.revoked_at ?? null,
    ended_at: g.revoked_at ?? null,
    revoked_reason: g.revoked_reason ?? null,
    revoked_by: g.revoked_by ?? null,
    dies_with: g.dies_with ?? null,
    created_at: g.created_at,
    updated_at: g.updated_at,
  };
}

/** Revoke a machine once; later calls keep the first end record. */
export function endMachine(e: Engine, m: Obj, reason: string, by: Obj): boolean {
  if (m.status === 'revoked' && m.revoked_at) return false;
  m.status = 'revoked';
  m.revoked_at = e.clock.now();
  m.revoked_reason = reason;
  m.revoked_by = by;
  m.updated_at = m.revoked_at;
  return true;
}

/**
 * The user signed out everywhere: sessions end, `user.sessions_revoked` fires, and every credential declared
 * `dies_with: sign_out_everywhere` ends with its own event. A grant of a machine the user owns always ends.
 * With `keptSessionId` (sign out of the other devices) only the sessions end.
 */
export function signOutEverywhere(e: Engine, userId: string, reason = 'signed_out_everywhere', keptSessionId?: string): void {
  const system = { type: 'system', id: null };
  const ending = e.db.sessions.filter((s) => s.user_id === userId && s.status !== 'revoked' && s.id !== keptSessionId);
  ending.forEach((s) => revokeSession(e, s, reason));
  e.webhooks.emit('user.sessions_revoked', {
    object: 'user_sessions_revoked',
    user_id: userId,
    sessions_revoked_at: e.clock.now(),
    reason,
    sessions_revoked: ending.length,
    ...(keptSessionId ? { kept_session_id: keptSessionId } : {}),
  });
  const owned = e.db.machines.filter((m) => !m.deleted && m.owner_user_id === userId && m.status !== 'revoked');
  for (const m of owned) for (const g of e.db.grants.filter((x) => x.machine_id === m.id && !x.revoked_at)) endGrant(e, g, 'owner_signed_out', system);
  if (keptSessionId) return;
  for (const k of e.db.apiKeys.filter((x) => x.subject_type === 'user' && x.subject_id === userId && x.dies_with === 'sign_out_everywhere' && !x.revoked_at)) {
    k.revoked_at = e.clock.now();
    k.revoked_reason = 'signed_out_everywhere';
    k.revoked_by = system;
    e.changed({ type: 'api_key.revoked', data: { object: 'api_key', id: k.id, subject_type: k.subject_type, subject_id: k.subject_id, revoked_at: k.revoked_at, revoked_reason: k.revoked_reason, end_reason: k.revoked_reason, revoked_by: system, dies_with: k.dies_with }, resource: 'api_key', id: k.id, op: 'update' });
  }
  for (const m of owned.filter((x) => x.dies_with === 'sign_out_everywhere')) {
    if (endMachine(e, m, 'owner_signed_out', system)) e.changed({ type: 'machine.revoked', data: { object: 'machine', id: m.id, owner_user_id: m.owner_user_id, status: m.status, revoked_reason: m.revoked_reason, revoked_by: system, ended_at: m.revoked_at, dies_with: m.dies_with }, resource: 'machine', id: m.id, op: 'update' });
  }
}

function frameOf(ev: { id: string; type: string; created_at: number; payload: Obj }, seq: number): Obj | null {
  const kind = KIND[ev.type];
  if (!kind) return null;
  const d: Obj = ev.payload?.data ?? {};
  const base = { object: 'revocation', id: ev.id, seq, type: ev.type, kind, at: ev.created_at, actor: ev.payload?.actor ?? { type: 'system', id: null } };
  switch (kind) {
    case 'session': return { ...base, user_id: str(d.user_id), ids: { session_id: str(d.id) }, reason: str(d.reason), revoked_at: d.revoked_at ?? ev.created_at };
    case 'user_sessions': return { ...base, user_id: str(d.user_id), ids: { kept_session_id: str(d.kept_session_id) }, reason: str(d.reason), sessions_revoked: d.sessions_revoked ?? 0, kept_session_id: str(d.kept_session_id), revoked_at: d.sessions_revoked_at ?? ev.created_at };
    case 'token_family': return { ...base, user_id: str(d.user_id), ids: { family_id: str(d.family_id), grant_id: str(d.grant_id), client_id: str(d.client_id) }, reason: str(d.reason), revoked_at: d.revoked_at ?? ev.created_at };
    case 'grant': return { ...base, user_id: str(d.user_id), ids: { grant_id: str(d.id), client_id: str(d.client_id) }, reason: str(d.reason) ?? 'grant_revoked', revoked_at: ev.created_at };
    case 'api_key': return { ...base, user_id: d.subject_type === 'user' ? str(d.subject_id) : null, ids: { api_key_id: str(d.id), subject_id: str(d.subject_id), organization_id: str(d.organization_id) }, reason: str(d.end_reason) ?? str(d.revoked_reason), revoked_at: d.revoked_at ?? ev.created_at };
    case 'machine': return { ...base, user_id: str(d.owner_user_id), ids: { machine_id: str(d.id), organization_id: str(d.organization_id) }, reason: str(d.revoked_reason) ?? str(d.reason), revoked_at: d.ended_at ?? ev.created_at };
    case 'machine_grant': return { ...base, user_id: null, ids: { machine_grant_id: str(d.id), machine_id: str(d.machine_id), resource_server_id: str(d.resource_server_id), audience: str(d.audience) }, reason: str(d.revoked_reason), revoked_at: d.revoked_at ?? ev.created_at };
    default: return { ...base, user_id: str(d.id) ?? str(d.user_id), ids: {}, reason: str(d.reason) ?? (ev.type === 'user.banned' ? 'banned' : ev.type === 'user.locked' ? 'locked' : 'deactivated'), revoked_at: ev.created_at };
  }
}

/** The stream's order is the order events were emitted: the emulator is single-threaded, so that is commit order. */
function entries(e: Engine, kinds: string[] | undefined): Array<{ seq: number; frame: Obj }> {
  const out: Array<{ seq: number; frame: Obj }> = [];
  let seq = 0;
  for (const ev of e.webhooks.events) {
    if (!KIND[ev.type]) continue;
    seq++;
    const frame = frameOf(ev as any, seq);
    if (frame && (!kinds || kinds.includes(String(frame.kind)))) out.push({ seq, frame });
  }
  return out;
}

const head = (e: Engine): number => e.webhooks.events.filter((ev) => KIND[ev.type]).length;

function kindsOf(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const kinds = raw.split(',').map((k) => k.trim()).filter(Boolean);
  const bad = kinds.filter((k) => !KINDS.includes(k));
  if (bad.length) throw new EmulatorError('VALIDATION_FAILED', `kinds must be a comma list of: ${KINDS.join(', ')}.`, 'kinds');
  return kinds;
}

function cursorOf(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  if (!/^\d{1,15}$/.test(raw)) throw new EmulatorError('VALIDATION_FAILED', 'after must be a cursor from this stream (a whole number).', 'after');
  return Number(raw);
}

export function revocationsHandlers(): RouteDef[] {
  return [
    {
      method: 'GET',
      pattern: '/v1/revocations',
      scope: 'events:read',
      handler: (c) => {
        const e = c.engine;
        const kinds = kindsOf(c.query.get('kinds'));
        const after = cursorOf(c.query.get('after'));
        const limit = Math.max(1, Math.min(Number(c.query.get('limit') ?? 100) || 100, 100));
        if (after === undefined && !c.query.get('since')) return { body: { object: 'list', data: [], has_more: false, next_cursor: String(head(e)), retention: { days: 90 } } };
        const matching = entries(e, kinds).filter((x) => x.seq > (after ?? 0));
        const page = matching.slice(0, limit);
        return { body: { object: 'list', data: page.map((x) => x.frame), has_more: matching.length > limit, next_cursor: String(page.length ? page[page.length - 1]!.seq : after ?? 0), retention: { days: 90 } } };
      },
    },
    {
      // The emulator answers a stream request with what exists now, as one SSE body, then ends it (a client reconnects with Last-Event-ID).
      method: 'GET',
      pattern: '/v1/revocations/stream',
      scope: 'events:read',
      handler: (c) => {
        const e = c.engine;
        const kinds = kindsOf(c.query.get('kinds'));
        const after = cursorOf(c.request.headers.get('last-event-id') ?? c.query.get('after')) ?? (c.query.get('since') ? 0 : head(e));
        const blocks = entries(e, kinds).filter((x) => x.seq > after).map((x) => `id: ${x.seq}\nevent: revocation\ndata: ${JSON.stringify(x.frame)}\n\n`);
        return { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' }, raw: `retry: 2000\n\nevent: ready\ndata: ${JSON.stringify({ cursor: String(after) })}\n\n${blocks.join('')}` };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/machines/revoked',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const since = Number(c.query.get('since') ?? c.query.get('starting_after') ?? 0) || 0;
        const secret = Boolean(c.request.headers.get('authorization')?.startsWith('Bearer '));
        const rows: Obj[] = [
          ...e.db.machines.filter((m) => m.revoked_at && m.revoked_at > since).map((m) => ({ at: m.revoked_at, body: { object: 'machine', id: m.id, revoked_at: m.revoked_at, ...(secret ? { revoked_reason: m.revoked_reason ?? null, revoked_by: m.revoked_by ?? null, owner_user_id: m.owner_user_id ?? null, organization_id: m.organization_id ?? null } : {}) } })),
          ...e.db.grants.filter((g) => g.revoked_at && g.revoked_at > since).map((g) => ({ at: g.revoked_at, body: { object: 'machine_grant', id: g.id, machine_id: g.machine_id, audience: resourceServerOf(e, g.resource_server_id).identifier, revoked_at: g.revoked_at, ...(secret ? { revoked_reason: g.revoked_reason ?? null, revoked_by: g.revoked_by ?? null } : {}) } })),
        ].sort((a, b) => a.at - b.at);
        const last = rows[rows.length - 1];
        return { body: { object: 'list', data: rows.map((r) => r.body), has_more: false, next_cursor: last ? String(last.at) : null } };
      },
    },
  ];
}


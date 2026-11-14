/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext, RouteDef } from '../engine';
import { bytesToB64url, sha256 } from '../crypto-util';
import { EmulatorError, notFound } from '../errors';
import { decodeJwt, jwkThumbprintOf, verifyJws } from '../jws';
import type { Obj } from '../openapi';
import { Table } from '../store';
import { engineState, intIn, sessionFromBearer } from './support';
import { listReply } from './util';

/**
 * Approvals v2: an application asks a person (or several, by user list or by organization role) to approve one concrete
 * action. The request is rendered to a canonical string and hashed (`digest`), so what the approver saw is what they
 * signed (what you see is what you sign). The default flow is the number-matching prompt for the subject; naming
 * `approvers` or `require_signature` needs an ES256 device-key signature over the digest from every approver. Enough
 * approvals produce a signed receipt a backend can verify offline; `consume` spends an approved request exactly once.
 */
const MIN_TTL_S = 60;
const MAX_TTL_S = 3600;
const DEFAULT_TTL_S = 300;
const MAX_WAIT_S = 25;
const DECISION_TYP = 'atlas-approval-decision+jws';

interface ApprovalState {
  requests: Table;
  keys: Table;
}
const st = engineState((e: Engine): ApprovalState => ({ requests: new Table('approval_requests', e.clock.now, 'apr'), keys: new Table('approval_keys', e.clock.now, 'apk') }));

const canonical = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v as Obj).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Obj)[k])}`).join(',')}}` : JSON.stringify(v ?? null));

const bad = (message: string, param: string) => new EmulatorError('VALIDATION_FAILED', message, param);

/** The state a request is in now: a pending request past its expiry becomes `expired` (and says so once). */
function settle(e: Engine, r: Obj): Obj {
  if (r.status === 'pending' && r.expires_at <= e.clock.now()) {
    r.status = 'expired';
    e.webhooks.emit('approval_request.expired', { object: 'approval_request', id: r.id, user_id: r.user_id });
  }
  return r;
}

const approverIds = (e: Engine, r: Obj): string[] => {
  if (r.approvers.mode === 'subject') return [r.user_id];
  if (r.approvers.mode === 'users') return r.approvers.user_ids;
  return e.db.memberships.filter((m) => m.organization_id === r.approvers.organization_id && m.role === r.approvers.role).map((m) => m.user_id);
};

const presentCreated = (r: Obj): Obj => ({
  object: 'approval_request',
  id: r.id,
  status: r.status,
  user_id: r.user_id,
  match_number: r.match_number,
  expires_at: r.expires_at,
  approvers: r.approvers,
  require_signature: r.require_signature,
  digest: r.digest,
  reference: r.reference,
  binding: r.binding,
});

const presentFull = (r: Obj): Obj => ({
  ...presentCreated(r),
  description: r.description,
  context: r.context,
  created_at: r.created_at,
  approvals_received: r.decisions.filter((d: Obj) => d.decision === 'approve').length,
  decisions: r.decisions.map((d: Obj) => ({ approver_user_id: d.approver_user_id, decision: d.decision, signed: d.signed, decided_at: d.at })),
  consumed_at: r.consumed_at ?? null,
  receipt: r.status === 'approved' && !r.consumed_at ? r.receipt : null,
});

async function create(c: RouteContext, userId: string): Promise<{ status: number; body: Obj }> {
  const e = c.engine;
  const b = c.body;
  const user = e.db.users.get(userId);
  if (!user || user.deleted) throw notFound('User');
  if (typeof b.description !== 'string' || !b.description.trim()) throw bad('A description is required.', 'description');
  if (b.description.length > 4000) throw bad('description must be 4000 characters or fewer.', 'description');
  let context: Record<string, string> = {};
  if (b.context !== undefined) {
    if (!b.context || typeof b.context !== 'object' || Array.isArray(b.context)) throw bad('context must be an object of string values.', 'context');
    const entries = Object.entries(b.context as Obj);
    if (entries.length > 50) throw bad('context may hold at most 50 entries.', 'context');
    for (const [k, v] of entries) if (typeof v !== 'string' || k.length > 128 || v.length > 2000) throw bad(`context.${k} must be a string of at most 2000 characters.`, 'context');
    context = b.context as Record<string, string>;
  }
  const ttl = intIn(b.ttl_seconds, 'ttl_seconds', MIN_TTL_S, MAX_TTL_S, DEFAULT_TTL_S);
  if (b.require_signature !== undefined && typeof b.require_signature !== 'boolean') throw bad('require_signature must be true or false.', 'require_signature');
  for (const k of ['binding', 'reference'] as const) if (b[k] !== undefined && b[k] !== null && (typeof b[k] !== 'string' || !b[k] || b[k].length > 200)) throw bad(`${k} must be a non-empty string of at most 200 characters.`, k);
  let approvers: Obj = { mode: 'subject', user_ids: [userId], organization_id: null, role: null, required: 1 };
  if (b.approvers !== undefined) {
    const a = b.approvers;
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw bad('approvers must be an object.', 'approvers');
    if (Array.isArray(a.user_ids) === (a.organization_id !== undefined)) throw bad('approvers takes user_ids, or organization_id with role.', 'approvers');
    if (Array.isArray(a.user_ids)) {
      if (!a.user_ids.length || a.user_ids.length > 20 || a.user_ids.some((u: unknown) => typeof u !== 'string' || !e.db.users.get(u))) throw bad('approvers.user_ids is 1 to 20 existing users.', 'approvers.user_ids');
      approvers = { mode: 'users', user_ids: [...new Set<string>(a.user_ids)], organization_id: null, role: null, required: 1 };
    } else {
      if (!e.db.organizations.get(a.organization_id)) throw bad('approvers.organization_id is not an organization.', 'approvers.organization_id');
      if (typeof a.role !== 'string' || !a.role) throw bad('approvers.role is required with organization_id.', 'approvers.role');
      approvers = { mode: 'org_role', user_ids: [], organization_id: a.organization_id, role: a.role, required: 1 };
    }
    const pool = approvers.mode === 'users' ? approvers.user_ids.length : e.db.memberships.filter((m) => m.organization_id === approvers.organization_id && m.role === approvers.role).length;
    approvers.required = intIn(a.required, 'approvers.required', 1, Math.max(1, pool), 1);
    if (!pool) throw bad('No one holds that role in the organization.', 'approvers');
  }
  const requireSignature = b.require_signature === true || approvers.mode !== 'subject';
  const now = e.clock.now();
  const digest = bytesToB64url(await sha256(canonical({ v: 1, user_id: userId, description: b.description.trim(), context, binding: b.binding ?? null, reference: b.reference ?? null })));
  const row = st(e).requests.insert({
    user_id: userId,
    description: b.description.trim(),
    context,
    status: 'pending',
    match_number: approvers.mode === 'subject' ? String(10 + Math.floor(Math.random() * 90)) : null,
    approvers,
    require_signature: requireSignature,
    binding: b.binding ?? null,
    reference: b.reference ?? null,
    digest,
    decisions: [],
    created_at: now,
    expires_at: now + ttl * 1000,
    receipt: null,
  });
  return { status: 201, body: presentCreated(row) };
}

const requestOf = (e: Engine, id: string | undefined, userId?: string): Obj => {
  const r = st(e).requests.get(id);
  if (!r || (userId !== undefined && r.user_id !== userId)) throw notFound('Approval request');
  return settle(e, r);
};

async function receiptFor(e: Engine, r: Obj): Promise<string> {
  return e.tokens.signClaims({ sub: r.user_id, jti: e.db.newId('aprcpt'), token_use: 'approval_receipt', approval_id: r.id, digest: r.digest, reference: r.reference, binding: r.binding, approvers: r.decisions.filter((d: Obj) => d.decision === 'approve').map((d: Obj) => d.approver_user_id) }, 3600);
}

function cancel(e: Engine, r: Obj): Obj {
  if (r.status !== 'pending') throw new EmulatorError('CONFLICT', `This request is ${r.status}; only a pending request can be cancelled.`);
  r.status = 'cancelled';
  e.webhooks.emit('approval_request.cancelled', { object: 'approval_request', id: r.id, user_id: r.user_id });
  return r;
}

/** Verify a device-key decision signature: ES256 JWS typ atlas-approval-decision+jws over { approval_id, digest, decision, iat } by a key this approver registered. */
async function verifySignature(e: Engine, r: Obj, approverId: string, decision: string, sig: unknown): Promise<void> {
  if (!sig || typeof sig !== 'object' || (sig as Obj).type !== 'device_key' || typeof (sig as Obj).key_id !== 'string' || typeof (sig as Obj).jws !== 'string') throw bad('signature must be { type: "device_key", key_id, jws }.', 'signature');
  const key = st(e).keys.get((sig as Obj).key_id);
  if (!key || key.user_id !== approverId) throw new EmulatorError('VERIFICATION_FAILED', 'That signing key is not registered to this approver.', 'signature');
  const jwt = decodeJwt((sig as Obj).jws);
  if (!jwt || jwt.header.typ !== DECISION_TYP || jwt.header.alg !== 'ES256') throw new EmulatorError('VERIFICATION_FAILED', 'The decision must be an ES256 JWS with typ atlas-approval-decision+jws.', 'signature');
  if (!(await verifyJws(jwt, key.jwk))) throw new EmulatorError('VERIFICATION_FAILED', 'The decision signature does not verify.', 'signature');
  const p = jwt.payload;
  if (p.approval_id !== r.id || p.digest !== r.digest || p.decision !== decision) throw new EmulatorError('VERIFICATION_FAILED', 'The signed decision is for a different request, digest or decision.', 'signature');
  if (typeof p.iat !== 'number' || Math.abs(e.clock.now() / 1000 - p.iat) > 300) throw new EmulatorError('VERIFICATION_FAILED', 'The signed decision is too old.', 'signature');
}

async function decide(c: RouteContext): Promise<{ body: Obj }> {
  const e = c.engine;
  const { userId } = await sessionFromBearer(c);
  const r = requestOf(e, c.params.id);
  if (!approverIds(e, r).includes(userId)) throw notFound('Approval request');
  if (r.status !== 'pending') throw new EmulatorError('CONFLICT', `This request is ${r.status}.`);
  if (r.decisions.some((d: Obj) => d.approver_user_id === userId)) throw new EmulatorError('CONFLICT', 'You already answered this request.');
  const decision = c.body.decision;
  if (decision !== 'approve' && decision !== 'deny') throw bad('decision must be approve or deny.', 'decision');
  let signed = false;
  if (decision === 'approve') {
    if (r.approvers.mode === 'subject' && !r.require_signature) {
      if (String(c.body.number ?? '') !== r.match_number) throw new EmulatorError('VERIFICATION_FAILED', 'That is not the number shown to the requester.', 'number');
    } else {
      await verifySignature(e, r, userId, decision, c.body.signature);
      signed = true;
    }
  }
  r.decisions.push({ approver_user_id: userId, decision, signed, at: e.clock.now() });
  e.webhooks.emit('approval_request.approver_decided', { object: 'approval_request', id: r.id, user_id: r.user_id, approver_user_id: userId, decision });
  if (decision === 'deny') {
    r.status = 'denied';
    e.webhooks.emit('approval_request.denied', { object: 'approval_request', id: r.id, user_id: r.user_id });
  } else if (r.decisions.filter((d: Obj) => d.decision === 'approve').length >= r.approvers.required) {
    r.status = 'approved';
    r.receipt = await receiptFor(e, r);
    e.webhooks.emit('approval_request.approved', { object: 'approval_request', id: r.id, user_id: r.user_id });
  }
  return { body: { object: 'approval_decision', approval_id: r.id, status: r.status, decision } };
}

export function approvalsHandlers(): RouteDef[] {
  const createFor = (pattern: string, userOf: (c: RouteContext) => string): RouteDef => ({ method: 'POST', pattern, handler: (c) => create(c, userOf(c)) });
  return [
    createFor('/v1/approval_requests', (c) => {
      if (typeof c.body.user_id !== 'string' || !c.body.user_id) throw bad('A user_id is required.', 'user_id');
      return c.body.user_id;
    }),
    createFor('/v1/users/:id/approval_requests', (c) => c.params.id ?? ''),
    {
      method: 'GET',
      pattern: '/v1/approval_requests',
      handler: (c) => {
        const e = c.engine;
        const q = (k: string) => c.query.get(k);
        const status = q('status');
        if (status && !['pending', 'approved', 'denied', 'expired', 'cancelled'].includes(status)) throw bad('status must be pending, approved, denied, expired or cancelled.', 'status');
        const epoch = (k: string): number | undefined => {
          const v = q(k);
          if (v === null) return undefined;
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0) throw bad(`${k} must be epoch milliseconds.`, k);
          return n;
        };
        const [after, before] = [epoch('created_after'), epoch('created_before')];
        const rows = st(e).requests.all().map((r) => settle(e, r)).filter((r) => (!status || r.status === status) && (!q('user_id') || r.user_id === q('user_id')) && (!q('reference') || r.reference === q('reference')) && (!q('approver_user_id') || approverIds(e, r).includes(q('approver_user_id')!)) && (after === undefined || r.created_at >= after) && (before === undefined || r.created_at <= before));
        return listReply(c, rows as Array<Obj & { id: string }>, (r) => ({ ...presentFull(r), receipt: undefined }));
      },
    },
    {
      method: 'GET',
      pattern: '/v1/approval_requests/:id',
      handler: async (c) => {
        const e = c.engine;
        const wait = c.query.get('wait_seconds') === null ? 0 : Number(c.query.get('wait_seconds'));
        if (!Number.isFinite(wait) || wait < 0 || wait > MAX_WAIT_S) throw bad(`wait_seconds must be 0 to ${MAX_WAIT_S}.`, 'wait_seconds');
        const deadline = Date.now() + wait * 1000;
        for (;;) {
          const r = requestOf(e, c.params.id);
          if (r.status !== 'pending' || Date.now() >= deadline) return { body: presentFull(r) };
          await new Promise((res) => setTimeout(res, Math.min(50, Math.max(1, deadline - Date.now()))));
        }
      },
    },
    {
      method: 'GET',
      pattern: '/v1/users/:id/approval_requests/:approvalId',
      handler: (c) => ({ body: presentFull(requestOf(c.engine, c.params.approvalId, c.params.id)) }),
    },
    {
      method: 'POST',
      pattern: '/v1/users/:id/approval_requests/:approvalId/cancel',
      handler: (c) => ({ body: presentFull(cancel(c.engine, requestOf(c.engine, c.params.approvalId, c.params.id))) }),
    },
    {
      method: 'POST',
      pattern: '/v1/approval_requests/:id/cancel',
      handler: (c) => ({ body: presentFull(cancel(c.engine, requestOf(c.engine, c.params.id))) }),
    },
    {
      // Spend an approved request once. A request made with a `binding` needs the same `binding` here.
      method: 'POST',
      pattern: '/v1/approval_requests/:id/consume',
      handler: (c) => {
        const e = c.engine;
        const r = requestOf(e, c.params.id);
        if (c.body.binding !== undefined && typeof c.body.binding !== 'string') throw bad('binding must be a string.', 'binding');
        if (r.status !== 'approved') throw new EmulatorError('CONFLICT', `This request is ${r.status}; only an approved request can be consumed.`);
        if (r.consumed_at) throw new EmulatorError('CONFLICT', 'This approval was already consumed.');
        if (r.binding && c.body.binding !== r.binding) throw bad('binding does not match the binding the request was created with.', 'binding');
        const out = presentFull(r);
        r.consumed_at = e.clock.now();
        return { body: { ...out, consumed_at: r.consumed_at } };
      },
    },
    // ── the approver's side (a session, never a secret key) ──
    {
      method: 'GET',
      pattern: '/v1/client/me/approvals',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const { userId } = await sessionFromBearer(c);
        const rows = st(e).requests.all().map((r) => settle(e, r)).filter((r) => r.status === 'pending' && approverIds(e, r).includes(userId) && !r.decisions.some((d: Obj) => d.approver_user_id === userId));
        return { body: { object: 'list', data: rows.map((r) => ({ object: 'approval', id: r.id, description: r.description, context: r.context, digest: r.digest, require_signature: r.require_signature, expires_at: r.expires_at })), has_more: false } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/client/me/approvals/:id',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const { userId } = await sessionFromBearer(c);
        const r = requestOf(e, c.params.id);
        if (!approverIds(e, r).includes(userId)) throw notFound('Approval request');
        return { body: { object: 'approval', id: r.id, status: r.status, description: r.description, context: r.context, digest: r.digest, require_signature: r.require_signature, expires_at: r.expires_at } };
      },
    },
    { method: 'POST', pattern: '/v1/client/me/approvals/:id/decision', public: true, handler: (c) => decide(c) },
    {
      method: 'GET',
      pattern: '/v1/client/me/approval_keys',
      public: true,
      handler: async (c) => {
        const { userId } = await sessionFromBearer(c);
        return { body: { object: 'list', data: st(c.engine).keys.filter((k) => k.user_id === userId).map((k) => ({ object: 'approval_key', id: k.id, label: k.label, thumbprint: k.thumbprint, created_at: k.created_at })), has_more: false } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/client/me/approval_keys',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const { userId } = await sessionFromBearer(c);
        const jwk = c.body.public_jwk;
        if (!jwk || typeof jwk !== 'object' || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || 'd' in jwk) throw bad('public_jwk must be a P-256 public key.', 'public_jwk');
        if (c.body.label !== undefined && (typeof c.body.label !== 'string' || c.body.label.length > 100)) throw bad('label is up to 100 characters.', 'label');
        const thumbprint = await jwkThumbprintOf(jwk);
        if (!thumbprint) throw bad('public_jwk could not be read.', 'public_jwk');
        const s = st(e);
        if (s.keys.find((k) => k.user_id === userId && k.thumbprint === thumbprint)) throw new EmulatorError('CONFLICT', 'That key is already registered.', 'public_jwk');
        if (s.keys.filter((k) => k.user_id === userId).length >= 10) throw new EmulatorError('CONFLICT', 'At most 10 approval keys per user.');
        const k = s.keys.insert({ user_id: userId, jwk, thumbprint, label: c.body.label ?? null, created_at: e.clock.now() });
        return { status: 201, body: { object: 'approval_key', id: k.id, label: k.label, thumbprint, created_at: k.created_at } };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/client/me/approval_keys/:id',
      public: true,
      handler: async (c) => {
        const { userId } = await sessionFromBearer(c);
        const k = st(c.engine).keys.get(c.params.id);
        if (!k || k.user_id !== userId) throw notFound('Approval key');
        st(c.engine).keys.delete(k.id);
        return { body: { object: 'approval_key', id: k.id, deleted: true } };
      },
    },
  ];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
import { auditChainGenesis, auditLinkHash, auditRowHash, type ChainedAuditRow } from '@atlasauth/backend';
import type { Engine, KeyInfo, RouteContext, RouteDef } from '../engine';
import { bytesToB64url } from '../crypto-util';
import { EmulatorError } from '../errors';
import { decodeJwt, verifyJws } from '../jws';
import type { Obj } from '../openapi';
import { Table, randomToken } from '../store';
import { emu4TrustBindingHandlers } from './emu4-trust-binding';
import { engineState, intIn, sessionFromBearer } from './support';

/**
 * Trust surfaces: the audit log every successful write leaves, the tamper-evident hash chain over it (status, links,
 * signed checkpoints, verification), one-time capability tickets, and the trusted devices a user remembers for MFA.
 * Session binding and device-bound sessions live in `emu4-trust-binding.ts`.
 */
const ROW_CAP = 20_000;
/** Rows must be this old before the chain links them (the real worker's settling delay). */
const SETTLE_MS = 60_000;
const CHECKPOINT_TYP = 'audit-checkpoint+jwt';
const MAX_INT = Number.MAX_SAFE_INTEGER;

interface Link {
  seq: number;
  audit_id: string;
  row_hash: string;
  link_hash: string;
}
interface Checkpoint {
  id: string;
  seq: number;
  link_hash: string;
  kid: string;
  alg: string;
  jws: string;
  signed_at: number;
}
interface Chain {
  enabled_at: number;
  interval_s: number;
  head_seq: number;
  head_hash: string;
  last_cp_seq: number;
  last_cp_at: number | null;
  links: Link[];
  cps: Checkpoint[];
  chained: Set<string>;
}

const st = engineState((e: Engine) => ({
  rows: [] as ChainedAuditRow[],
  byId: new Map<string, ChainedAuditRow>(),
  chain: null as Chain | null,
  tickets: new Map<string, Obj>(),
  devices: new Table('trusted_devices', e.clock.now, 'tdev'),
}));

// ── the audit log ──

export interface AuditInput {
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata?: Obj;
  ip?: string | null;
  user_agent?: string | null;
}

/** Append one audit row (what the real service writes for every mutation); the oldest rows fall off at 20000, like retention. */
export function recordAudit(e: Engine, a: AuditInput): ChainedAuditRow {
  const s = st(e);
  const row: ChainedAuditRow = { id: e.db.newId('audit'), actor_type: a.actor_type, actor_id: a.actor_id, action: a.action, target_type: a.target_type, target_id: a.target_id, ip: a.ip ?? null, user_agent: a.user_agent ?? null, metadata: a.metadata ?? {}, created_at: e.clock.now() };
  s.rows.push(row);
  s.byId.set(row.id, row);
  if (s.rows.length > ROW_CAP) s.byId.delete(s.rows.shift()!.id);
  return row;
}

const singular = (w: string): string => (/ies$/.test(w) ? `${w.slice(0, -3)}y` : /[^s]s$/.test(w) ? w.slice(0, -1) : w);
const past = (v: string): string => (/e$/.test(v) ? `${v}d` : /ed$/.test(v) ? v : /^(un)?(ban|pin|tag|log|rip)$/.test(v) ? `${v}${v.slice(-1)}ed` : `${v}ed`);

/** Paths that are reads, protocol traffic or already audited by their own handler. */
const NOT_AUDITED = /^\/(__emulator|\.well-known|oauth2|scim)|^\/v1\/(audit\/chain|client\/session_binding|client\/dbsc|tickets|client\/tickets)|\/binding$|\/tokens(\/[^/]+)?$|\/(verify|introspect|resolve|explain|simulate|evaluate|check|preview|test)$/;

/** Called by the engine after every successful write: leaves the audit row the real service would (names like `user.created`, `session.revoked`). */
export function auditMutation(e: Engine, w: { method: string; path: string; params: Record<string, string>; key: KeyInfo | null; body: unknown }): void {
  if (w.method === 'GET' || NOT_AUDITED.test(w.path)) return;
  const ids = new Set(Object.values(w.params));
  const segs = w.path.replace(/^\/v1\//, '').split('/').filter(Boolean);
  const idsInPath = segs.filter((x) => ids.has(x));
  const names = segs.filter((x) => !ids.has(x));
  const object = typeof (w.body as Obj | undefined)?.object === 'string' ? String((w.body as Obj).object) : null;
  const lastIsId = ids.has(segs[segs.length - 1] ?? '');
  const last = names[names.length - 1] ?? 'resource';
  const parent = names[names.length - 2];
  let type = singular(last);
  let verb = w.method === 'DELETE' ? 'deleted' : w.method === 'POST' && !lastIsId ? 'created' : 'updated';
  // `POST /things/:id/ban` is a verb on the thing; `POST /orgs/:id/memberships` creates a nested row (its answer names another object).
  if (w.method === 'POST' && !lastIsId && idsInPath.length > 0 && parent && object !== singular(last) && (object === null || object === singular(parent))) {
    type = singular(parent);
    verb = past(last);
  }
  const bodyId = typeof (w.body as Obj | undefined)?.id === 'string' ? String((w.body as Obj).id) : null;
  recordAudit(e, {
    actor_type: w.key ? 'api_key' : 'public',
    actor_id: w.key ? `emulator_key_${Math.max(0, e.keys.indexOf(w.key))}` : null,
    action: `${type}.${verb}`,
    target_type: type,
    target_id: idsInPath[idsInPath.length - 1] ?? bodyId,
    // The route, never the request body: bodies carry personal data and secrets.
    metadata: { method: w.method, path: w.path },
  });
}

// ── the chain ──

const jwksUri = (e: Engine): string => `${e.issuer}/.well-known/jwks.json`;
const linkHashAt = (e: Engine, ch: Chain, seq: number): string | undefined => (seq <= 0 ? auditChainGenesis(e.instanceId) : ch.links.find((l) => l.seq === seq)?.link_hash);
const noChain = (): EmulatorError => new EmulatorError('NOT_FOUND', 'The audit chain is not on.');
const cpView = (c: Checkpoint): Obj => ({ object: 'audit_chain_checkpoint', id: c.id, seq: c.seq, link_hash: c.link_hash, kid: c.kid, alg: c.alg, jws: c.jws, signed_at: c.signed_at });

function unchainedRows(e: Engine, ch: Chain, settleMs: number): ChainedAuditRow[] {
  const cutoff = e.clock.now() - settleMs;
  return st(e).rows.filter((r) => r.created_at >= ch.enabled_at && r.created_at < cutoff && !ch.chained.has(r.id));
}

/** Sign a checkpoint with the engine's current signing key; the header type is the documented `audit-checkpoint+jwt`. */
async function signCheckpoint(e: Engine, seq: number, linkHash: string): Promise<{ jws: string; kid: string; alg: string }> {
  // The token service keeps its keys private; a checkpoint needs a custom header type, so read the current key from it.
  const t: any = e.tokens;
  await t.ensure();
  const cur = t.current();
  const alg: string = cur.jwks.keys[0].alg;
  const enc = (o: Obj): string => bytesToB64url(new TextEncoder().encode(JSON.stringify(o)));
  const input = `${enc({ alg, kid: cur.kid, typ: CHECKPOINT_TYP })}.${enc({ instance_id: e.instanceId, seq, link_hash: linkHash, link_count: seq, iat: Math.floor(e.clock.now() / 1000) })}`;
  const ec = alg === 'ES256';
  let key = cur.privateKey;
  if (typeof key.export === 'function') key = await crypto.subtle.importKey('jwk', key.export({ format: 'jwk' }), ec ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign(ec ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' }, key, new TextEncoder().encode(input));
  return { jws: `${input}.${bytesToB64url(new Uint8Array(sig))}`, kid: cur.kid, alg };
}

interface Verdict {
  ok: boolean;
  checked: number;
  pruned: number;
  firstBreak: { seq: number; reason: 'row_modified' | 'link_mismatch' | 'gap' } | null;
  nextSeq: number;
  done: boolean;
}

/** Recompute the chain from `fromSeq` against the audit rows as stored now. */
function verifyLinks(e: Engine, ch: Chain, o: { fromSeq?: number; toSeq?: number; maxLinks?: number }): Verdict {
  const from = Math.max(1, o.fromSeq ?? 1);
  const maxLinks = Math.min(o.maxLinks ?? 20_000, 100_000);
  const to = Math.min(o.toSeq ?? ch.head_seq, ch.head_seq);
  let prev = linkHashAt(e, ch, from - 1);
  const v: Verdict = { ok: true, checked: 0, pruned: 0, firstBreak: null, nextSeq: from - 1, done: false };
  if (prev === undefined) return { ...v, ok: false, firstBreak: { seq: from - 1, reason: 'gap' } };
  let cursor = from - 1;
  const todo = ch.links.filter((l) => l.seq > cursor && l.seq <= to).sort((a, b) => a.seq - b.seq);
  for (const l of todo) {
    if (v.checked >= maxLinks) break;
    if (l.seq !== cursor + 1) return { ...v, ok: false, firstBreak: { seq: cursor + 1, reason: 'gap' } };
    const row = st(e).byId.get(l.audit_id);
    if (row) {
      if (auditRowHash(row) !== l.row_hash) return { ...v, ok: false, firstBreak: { seq: l.seq, reason: 'row_modified' } };
    } else v.pruned += 1;
    if (auditLinkHash(prev, l.seq, l.row_hash) !== l.link_hash) return { ...v, ok: false, firstBreak: { seq: l.seq, reason: 'link_mismatch' } };
    prev = l.link_hash;
    cursor = l.seq;
    v.checked += 1;
    v.nextSeq = cursor;
  }
  // The stored head must be the last link examined when the whole chain was walked.
  if (cursor >= ch.head_seq && ch.head_seq > 0 && prev !== ch.head_hash) return { ...v, ok: false, firstBreak: { seq: ch.head_seq, reason: 'link_mismatch' } };
  v.done = cursor >= to;
  return v;
}

/** Signature against the published keys and the claimed head against the stored link; a key that left the published set is `unverifiable`, not a break. */
async function checkCheckpoints(e: Engine, ch: Chain, cps: Checkpoint[]): Promise<{ checked: number; valid: number; unverifiable: number; mismatched: number }> {
  const keys = (await e.tokens.jwks()).keys;
  const out = { checked: 0, valid: 0, unverifiable: 0, mismatched: 0 };
  for (const c of cps) {
    out.checked += 1;
    const d = decodeJwt(c.jws);
    const jwk = keys.find((k) => k.kid === c.kid);
    const verified = !!(d && jwk && d.header.typ === CHECKPOINT_TYP && d.header.kid === c.kid && (await verifyJws(d, jwk)));
    const claims = verified ? d!.payload : null;
    if (!claims) out.unverifiable += 1;
    const claimed = claims ? claims.link_hash : c.link_hash;
    if (linkHashAt(e, ch, c.seq) !== c.link_hash || claimed !== c.link_hash || (claims && (claims.seq !== c.seq || claims.instance_id !== e.instanceId))) out.mismatched += 1;
    else if (claims) out.valid += 1;
  }
  return out;
}

function raiseTamper(e: Engine, detail: Obj): void {
  recordAudit(e, { actor_type: 'system', actor_id: 'audit_chain', action: 'audit_chain.tamper_detected', target_type: 'instance', target_id: e.instanceId, metadata: detail });
  e.webhooks.emit('audit_chain.tamper_detected', { object: 'audit_chain', ...detail });
}

async function makeCheckpoint(e: Engine, ch: Chain): Promise<Checkpoint> {
  const signed = await signCheckpoint(e, ch.head_seq, ch.head_hash);
  const cp: Checkpoint = { id: e.db.newId('acp'), seq: ch.head_seq, link_hash: ch.head_hash, kid: signed.kid, alg: signed.alg, jws: signed.jws, signed_at: e.clock.now() };
  ch.cps.push(cp);
  ch.last_cp_seq = cp.seq;
  ch.last_cp_at = cp.signed_at;
  return cp;
}

/**
 * One pass of the real worker: link the settled rows, then (when the checkpoint interval passed) verify what was added since
 * the last checkpoint and sign a new one. Nothing is signed over a chain that does not verify: `audit_chain.tamper_detected`
 * is raised instead. `settle: false` links every row now (the test helper); the routes call it with the real 60 s delay.
 */
export async function sweepChain(e: Engine, settle = true): Promise<{ appended: number; checkpoint: boolean; tampered: boolean; head_seq: number }> {
  const ch = st(e).chain;
  if (!ch) return { appended: 0, checkpoint: false, tampered: false, head_seq: 0 };
  const due = unchainedRows(e, ch, settle ? SETTLE_MS : -1).sort((a, b) => a.created_at - b.created_at);
  for (const r of due) {
    const seq = ch.head_seq + 1;
    const rowHash = auditRowHash(r);
    ch.head_hash = auditLinkHash(ch.head_hash, seq, rowHash);
    ch.head_seq = seq;
    ch.links.push({ seq, audit_id: r.id, row_hash: rowHash, link_hash: ch.head_hash });
    ch.chained.add(r.id);
  }
  const out = { appended: due.length, checkpoint: false, tampered: false, head_seq: ch.head_seq };
  if (ch.head_seq <= ch.last_cp_seq) return out;
  if (ch.last_cp_at !== null && e.clock.now() - ch.last_cp_at < ch.interval_s * 1000) return out;
  const last = ch.cps[ch.cps.length - 1];
  if (last && linkHashAt(e, ch, last.seq) !== last.link_hash) {
    raiseTamper(e, { reason: 'checkpointed_link_changed', seq: last.seq });
    return { ...out, tampered: true };
  }
  const verdict = verifyLinks(e, ch, { fromSeq: (last?.seq ?? 0) + 1, toSeq: ch.head_seq, maxLinks: 100_000 });
  if (!verdict.ok || !verdict.done) {
    if (!verdict.ok) raiseTamper(e, { reason: verdict.firstBreak?.reason ?? 'unknown', seq: verdict.firstBreak?.seq ?? null });
    return { ...out, tampered: !verdict.ok };
  }
  const cp = await makeCheckpoint(e, ch);
  e.webhooks.emit('audit_chain.checkpoint_signed', { object: 'audit_chain_checkpoint', seq: cp.seq, link_hash: cp.link_hash, kid: cp.kid, alg: cp.alg, signed_at: cp.signed_at });
  return { ...out, checkpoint: true };
}

function statusView(e: Engine): Obj {
  const ch = st(e).chain;
  return {
    object: 'audit_chain',
    enabled: !!ch,
    enabled_at: ch?.enabled_at ?? null,
    checkpoint_interval_seconds: ch?.interval_s ?? null,
    head_seq: ch?.head_seq ?? null,
    head_hash: ch && ch.head_seq > 0 ? ch.head_hash : null,
    genesis_hash: auditChainGenesis(e.instanceId),
    last_checkpoint_seq: ch?.last_cp_seq ?? null,
    last_checkpoint_at: ch?.last_cp_at ?? null,
    // Rows old enough to be chained that no link covers: 0 on a healthy chain.
    unchained_rows: ch ? unchainedRows(e, ch, SETTLE_MS * 5).length : 0,
    algorithm: { row: 'atlas.audit.row.v1', link: 'atlas.audit.link.v1', genesis: 'atlas.audit.genesis.v1', checkpoint_typ: CHECKPOINT_TYP },
    jwks_uri: jwksUri(e),
  };
}

const strictKeys = (c: RouteContext, allowed: string[]): void => {
  const bad = Object.keys(c.body).find((k) => !allowed.includes(k));
  if (bad && (c.engine.options.strict === true || c.request.headers.get('atlas-strict') === 'true')) throw new EmulatorError('UNKNOWN_FIELD', `Unknown field: ${bad}.`, bad);
};
const q = (c: RouteContext, k: string): string | undefined => c.query.get(k) ?? undefined;

// ── tickets ──

const TICKET_MAX_TTL_S = 24 * 60 * 60;
const ticketGone = (): EmulatorError => new EmulatorError('NOT_FOUND', 'This ticket is invalid, expired, or already redeemed.');

/** The consuming logic both surfaces share: unknown, expired and spent all answer the same 404; a binding mismatch is a 403 and spends nothing. */
function redeemTicket(e: Engine, secret: string, redeemer: { userId?: string; orgId?: string }): Obj {
  const t = st(e).tickets.get(secret);
  if (!t || t.expires_at <= e.clock.now()) throw ticketGone();
  if ((t.bound_user && t.bound_user !== redeemer.userId) || (t.bound_org && t.bound_org !== redeemer.orgId)) throw new EmulatorError('FORBIDDEN', 'This ticket is not redeemable in this context.');
  if (t.single_use && t.redeemed_at) throw ticketGone();
  t.redeemed_at = e.clock.now();
  return { object: 'ticket_redemption', id: t.id, payload: t.payload, single_use: t.single_use };
}

// ── trusted devices ──

const deviceView = (r: Obj): Obj => ({ object: 'trusted_device', id: r.id, device: r.device, created_at: r.created_at, last_used_at: r.last_used_at, expires_at: r.expires_at });
const liveDevices = (e: Engine, userId: string): Obj[] => st(e).devices.filter((r) => r.user_id === userId && r.expires_at > e.clock.now());

export function emu4TrustHandlers(): RouteDef[] {
  return [
    ...emu4TrustBindingHandlers(),

    // ── audit chain: status and switch ──
    {
      method: 'GET',
      pattern: '/v1/audit/chain',
      scope: 'audit:read',
      handler: async (c) => {
        await sweepChain(c.engine);
        return { body: statusView(c.engine) };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/audit/chain',
      scope: 'audit:write',
      handler: async (c) => {
        const e = c.engine;
        strictKeys(c, ['enabled', 'checkpoint_interval_seconds']);
        if (typeof c.body.enabled !== 'boolean') throw new EmulatorError('VALIDATION_FAILED', 'enabled must be true or false.', 'enabled');
        const interval = c.body.checkpoint_interval_seconds === undefined || c.body.checkpoint_interval_seconds === '' ? undefined : intIn(c.body.checkpoint_interval_seconds, 'checkpoint_interval_seconds', 60, 86_400);
        const before = st(e).chain;
        if (!c.body.enabled) {
          // The links are the evidence; the chain only ever grows.
          if (before) throw new EmulatorError('VALIDATION_FAILED', 'A chain that is on cannot be turned off: its links are the evidence. Contact support to retire an instance chain.', 'enabled');
        } else {
          st(e).chain ??= { enabled_at: e.clock.now(), interval_s: interval ?? 3600, head_seq: 0, head_hash: auditChainGenesis(e.instanceId), last_cp_seq: 0, last_cp_at: null, links: [], cps: [], chained: new Set() };
          if (interval) st(e).chain!.interval_s = interval;
        }
        recordAudit(e, { actor_type: 'api_key', actor_id: null, action: before ? 'audit_chain.updated' : 'audit_chain.enabled', target_type: 'instance', target_id: e.instanceId, metadata: { checkpoint_interval_seconds: interval ?? before?.interval_s ?? 3600 } });
        await sweepChain(e);
        return { body: statusView(e) };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/audit/chain/links',
      scope: 'audit:read',
      handler: async (c) => {
        const e = c.engine;
        const afterSeq = intIn(q(c, 'after_seq'), 'after_seq', 0, MAX_INT, 0);
        const limit = intIn(q(c, 'limit'), 'limit', 1, 1000, 200);
        await sweepChain(e);
        const links = (st(e).chain?.links ?? []).filter((l) => l.seq > afterSeq).sort((a, b) => a.seq - b.seq).slice(0, limit);
        return {
          body: {
            object: 'list',
            data: links.map((l) => ({ object: 'audit_chain_link', seq: l.seq, audit_id: l.audit_id, row_hash: l.row_hash, link_hash: l.link_hash, row: st(e).byId.get(l.audit_id) ?? null })),
            has_more: links.length === limit,
            next_after_seq: links.length ? links[links.length - 1]!.seq : afterSeq,
          },
        };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/audit/chain/checkpoints',
      scope: 'audit:read',
      handler: async (c) => {
        const e = c.engine;
        const afterSeq = intIn(q(c, 'after_seq'), 'after_seq', 0, MAX_INT, 0);
        const limit = intIn(q(c, 'limit'), 'limit', 1, 500, 100);
        await sweepChain(e);
        const rows = (st(e).chain?.cps ?? []).filter((x) => x.seq > afterSeq).sort((a, b) => a.seq - b.seq).slice(0, limit);
        return { body: { object: 'list', data: rows.map(cpView), has_more: rows.length === limit, jwks_uri: jwksUri(e) } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/audit/chain/checkpoints',
      scope: 'audit:write',
      handler: async (c) => {
        const e = c.engine;
        await sweepChain(e);
        const ch = st(e).chain;
        if (!ch) throw noChain();
        if (ch.head_seq === 0) throw new EmulatorError('VALIDATION_FAILED', 'The chain has no links yet.');
        const last = ch.cps[ch.cps.length - 1];
        if (last && last.seq === ch.head_seq) return { status: 200, body: cpView(last) };
        const v = verifyLinks(e, ch, { fromSeq: (last?.seq ?? 0) + 1, toSeq: ch.head_seq });
        if (!v.ok) throw new EmulatorError('CONFLICT', 'The chain does not verify, so it is not checkpointed. Run a verification for the details.');
        const cp = await makeCheckpoint(e, ch);
        recordAudit(e, { actor_type: 'api_key', actor_id: null, action: 'audit_chain.checkpoint_signed', target_type: 'instance', target_id: e.instanceId, metadata: { seq: cp.seq } });
        return { status: 201, body: cpView(cp) };
      },
    },
    {
      // Read only: recomputes the chain from the stored rows; pages through large chains with next_seq.
      method: 'POST',
      pattern: '/v1/audit/chain/verify',
      scope: 'audit:read',
      handler: async (c) => {
        const e = c.engine;
        strictKeys(c, ['from_seq', 'to_seq', 'max_links']);
        await sweepChain(e);
        const ch = st(e).chain;
        if (!ch) throw noChain();
        const fromSeq = c.body.from_seq === undefined ? undefined : intIn(c.body.from_seq, 'from_seq', 1, MAX_INT);
        const toSeq = c.body.to_seq === undefined ? undefined : intIn(c.body.to_seq, 'to_seq', 1, MAX_INT);
        const maxLinks = c.body.max_links === undefined ? undefined : intIn(c.body.max_links, 'max_links', 1, 100_000);
        const v = verifyLinks(e, ch, { fromSeq, toSeq, maxLinks });
        const cps = ch.cps.filter((x) => x.seq > Math.max(0, (fromSeq ?? 1) - 1) && x.seq <= (toSeq ?? MAX_INT)).slice(0, 500);
        const checkpoints = await checkCheckpoints(e, ch, cps);
        return { body: { object: 'audit_chain_verification', ok: v.ok && checkpoints.mismatched === 0, checked: v.checked, pruned: v.pruned, first_break: v.firstBreak, next_seq: v.nextSeq, done: v.done, checkpoints } };
      },
    },

    // ── audit chain: emulator controls ──
    {
      // The worker, on demand: links every audit row now (the routes only link rows older than 60 seconds), and signs a checkpoint when one is due.
      method: 'POST',
      pattern: '/__emulator/audit_chain/sweep',
      public: true,
      handler: async (c) => ({ body: { object: 'audit_chain_sweep', ...(await sweepChain(c.engine, c.body.settle === true)) } }),
    },
    {
      method: 'GET',
      pattern: '/__emulator/audit_chain/rows',
      public: true,
      handler: (c) => ({ body: { object: 'list', data: [...st(c.engine).rows].reverse(), has_more: false } }),
    },
    {
      // Edit the stored data the way an attacker with database access would, without touching the hashes.
      // kind: `row` (change an audit row's metadata), `link` (change a link hash), `drop_link` (remove a link), `prune_row` (what retention does: the link stays and still chains).
      method: 'POST',
      pattern: '/__emulator/audit_chain/tamper',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const kind = String(c.body.kind ?? '');
        if (!['row', 'link', 'drop_link', 'prune_row'].includes(kind)) throw new EmulatorError('VALIDATION_FAILED', 'kind must be one of row, link, drop_link, prune_row.', 'kind');
        const ch = st(e).chain;
        const link = c.body.seq !== undefined ? ch?.links.find((l) => l.seq === c.body.seq) : undefined;
        if ((kind === 'link' || kind === 'drop_link') && !link) throw new EmulatorError('NOT_FOUND', 'There is no link with that seq.', 'seq');
        const auditId: string | undefined = c.body.audit_id ?? link?.audit_id;
        const row = auditId ? st(e).byId.get(auditId) : undefined;
        if ((kind === 'row' || kind === 'prune_row') && !row) throw new EmulatorError('NOT_FOUND', 'There is no such audit row (give seq or audit_id).', 'audit_id');
        if (kind === 'row') row!.metadata = { ...(row!.metadata as Obj), tampered: true };
        else if (kind === 'link') link!.link_hash = link!.link_hash.replace(/^./, (x) => (x === '0' ? '1' : '0'));
        else if (kind === 'drop_link') ch!.links.splice(ch!.links.indexOf(link!), 1);
        else {
          st(e).byId.delete(row!.id);
          st(e).rows.splice(st(e).rows.indexOf(row!), 1);
        }
        return { body: { object: 'audit_chain_tamper', kind, seq: link?.seq ?? null, audit_id: auditId ?? null } };
      },
    },

    // ── one-time capability tickets ──
    {
      method: 'POST',
      pattern: '/v1/tickets',
      scope: 'tickets:write',
      handler: (c) => {
        const e = c.engine;
        const b = c.body;
        // The lifetime is required and clamped: an absent one would make a "one-time" ticket a long-lived bearer secret.
        if (typeof b.ttl_seconds !== 'number' || !Number.isFinite(b.ttl_seconds) || b.ttl_seconds <= 0) throw new EmulatorError('VALIDATION_FAILED', 'ttl_seconds must be a positive number of seconds.', 'ttl_seconds');
        if (b.single_use !== undefined && typeof b.single_use !== 'boolean') throw new EmulatorError('VALIDATION_FAILED', 'single_use must be a boolean.', 'single_use');
        if (b.bound_user !== undefined && typeof b.bound_user !== 'string') throw new EmulatorError('VALIDATION_FAILED', 'bound_user must be a user id.', 'bound_user');
        if (b.bound_org !== undefined && typeof b.bound_org !== 'string') throw new EmulatorError('VALIDATION_FAILED', 'bound_org must be an organization id.', 'bound_org');
        const now = e.clock.now();
        const secret = `tkt_${randomToken(32)}`;
        const t: Obj = { id: e.db.newId('tkt'), payload: b.payload ?? {}, single_use: b.single_use ?? true, bound_user: b.bound_user ?? null, bound_org: b.bound_org ?? null, created_at: now, expires_at: now + Math.min(Math.floor(b.ttl_seconds), TICKET_MAX_TTL_S) * 1000, redeemed_at: null };
        st(e).tickets.set(secret, t);
        recordAudit(e, { actor_type: 'api_key', actor_id: null, action: 'ticket.created', target_type: 'capability_ticket', target_id: t.id });
        // The plaintext is returned exactly once.
        return { status: 201, body: { object: 'ticket', id: t.id, ticket: secret, single_use: t.single_use, bound_user: t.bound_user, bound_org: t.bound_org, created_at: t.created_at, expires_at: t.expires_at } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/tickets/redeem',
      scope: 'tickets:write',
      handler: (c) => {
        const e = c.engine;
        if (typeof c.body.ticket !== 'string' || !c.body.ticket) throw new EmulatorError('VALIDATION_FAILED', 'A ticket is required.', 'ticket');
        // A backend caller asserts the redeemer context; the secret key is already the trust boundary.
        const out = redeemTicket(e, c.body.ticket, { userId: c.body.for_user, orgId: c.body.for_org });
        recordAudit(e, { actor_type: 'api_key', actor_id: null, action: 'ticket.redeemed', target_type: 'capability_ticket', target_id: String(out.id) });
        return { body: out };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/client/tickets/redeem',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const { userId } = await sessionFromBearer(c);
        if (typeof c.body.ticket !== 'string' || !c.body.ticket) throw new EmulatorError('VALIDATION_FAILED', 'A ticket is required.', 'ticket');
        // The redeemer is the session's own identity; an organization is accepted only after proving membership.
        let orgId: string | undefined;
        if (c.body.organization_id !== undefined) {
          if (typeof c.body.organization_id !== 'string') throw new EmulatorError('VALIDATION_FAILED', 'organization_id must be an organization id.', 'organization_id');
          if (!e.db.memberships.find((m) => m.user_id === userId && m.organization_id === c.body.organization_id)) throw new EmulatorError('FORBIDDEN', 'You are not a member of that organization.');
          orgId = c.body.organization_id;
        }
        const out = redeemTicket(e, c.body.ticket, { userId, orgId });
        recordAudit(e, { actor_type: 'user', actor_id: userId, action: 'ticket.redeemed', target_type: 'capability_ticket', target_id: String(out.id) });
        return { body: out };
      },
    },

    // ── trusted devices (the browsers a user remembered to skip MFA) ──
    {
      method: 'GET',
      pattern: '/v1/client/me/trusted_devices',
      public: true,
      handler: async (c) => {
        const { userId } = await sessionFromBearer(c);
        return { body: { object: 'list', data: liveDevices(c.engine, userId).map(deviceView) } };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/client/me/trusted_devices/:id',
      public: true,
      handler: async (c) => {
        const { userId } = await sessionFromBearer(c);
        // Scoped by user: someone else's device id is an unknown id.
        const d = st(c.engine).devices.get(c.params.id);
        if (!d || d.user_id !== userId) throw new EmulatorError('NOT_FOUND', 'Unknown trusted device.');
        st(c.engine).devices.delete(d.id);
        return { body: { object: 'trusted_device', id: d.id, deleted: true } };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/client/me/trusted_devices',
      public: true,
      handler: async (c) => {
        const { userId } = await sessionFromBearer(c);
        const mine = st(c.engine).devices.filter((r) => r.user_id === userId);
        for (const d of mine) st(c.engine).devices.delete(d.id);
        return { body: { object: 'trusted_device', deleted: true, count: mine.length } };
      },
    },
    {
      // Remember a device for a user (what "remember this device" does after MFA); the secret is returned once, as the cookie value would be.
      method: 'POST',
      pattern: '/__emulator/trusted_devices',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const user = e.db.users.get(String(c.body.user_id ?? ''));
        if (!user || user.deleted) throw new EmulatorError('NOT_FOUND', 'User not found.', 'user_id');
        const ttlDays = intIn(c.body.ttl_days, 'ttl_days', 1, 365, 30);
        const info = c.body.device && typeof c.body.device === 'object' ? c.body.device : {};
        const secret = randomToken(32);
        const now = e.clock.now();
        const row = st(e).devices.insert({ user_id: user.id, secret, device: info, created_at: now, last_used_at: null, expires_at: now + ttlDays * 86_400_000 });
        return { status: 201, body: { object: 'trusted_device_secret', id: row.id, secret, expires_at: row.expires_at } };
      },
    },
    {
      // Is this secret a live trust for this user (the MFA-skip check); a hit stamps last_used_at.
      method: 'POST',
      pattern: '/__emulator/trusted_devices/verify',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const d = st(e).devices.find((r) => r.user_id === c.body.user_id && r.secret === c.body.secret && r.expires_at > e.clock.now());
        if (d) d.last_used_at = e.clock.now();
        return { body: { object: 'trusted_device_check', trusted: !!d, id: d?.id ?? null } };
      },
    },
  ];
}

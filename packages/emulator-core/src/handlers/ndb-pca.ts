/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table, randomToken } from '../store';
import { audit, bad, canonical, conflict, hex, isObj, listOf } from './emu4-shared';
import { engineState } from './support';

/**
 * Proof-Carrying Authority and Shared Signals in the emulator: principals, grants and their authority statements, needs, step-ups,
 * constitutions, post-quantum pins, beacons, bond accounts, the undo ledger, guardian key rotation, intent maps and schemas,
 * workflow receipts, passkey approvers and their settings, the hosted action registry (imports, drafts, reviewers, sources,
 * templates, packs, versions, pins), and the SSF stream management API.
 * shortcut: no signature is verified (grant chains, principal and holder signatures, attestations, passkey assertions): the
 * emulator checks that each is present, well-formed and, where the real service binds it to an id, that the id matches. The
 * decisions that follow (wider needs a step-up, a spent step-up, widening a registry namespace needs a reviewer) are real.
 */
const READ = 'pca:read';
const WRITE = 'pca:write';
const B64U = /^[A-Za-z0-9_-]+$/;
const iso = (ms: number): string => new Date(ms).toISOString();
const str = (v: unknown, param: string, max = 512): string => {
  if (typeof v !== 'string' || v === '' || v.length > max) throw bad(`${param} is a non-empty string.`, param);
  return v;
};
const sig = (v: unknown, param = 'sig'): string => {
  if (typeof v !== 'string' || !B64U.test(v)) throw bad(`${param} is a base64url signature.`, param);
  return v;
};
const objArg = (v: unknown, param: string): Obj => {
  if (!isObj(v)) throw bad(`${param} is an object.`, param);
  return v;
};

interface Authority { verbs: string[]; resources: string[]; limits?: Obj; expires_at?: number }
interface Pca {
  principals: Map<string, Obj>;
  grants: Map<string, Obj>;
  needs: Table;
  stepUps: Map<string, Obj>;
  constitutions: Map<string, Obj>;
  pqPins: Map<string, Obj>;
  pqTombstones: Map<string, number>;
  beacons: Obj[];
  bonds: Map<string, number>;
  undo: Map<string, Obj>;
  guardian: Array<{ epoch: number; public_key: string; created_at: number; retired_at: number | null }>;
  maps: Map<string, Obj>;
  observations: Obj[];
  schemas: Map<string, Obj>;
  receipts: Map<string, Obj[]>;
  approvers: Table;
  enrolments: Table;
  settings: Obj;
  registry: Map<string, Obj>;
  drafts: Map<string, Obj>;
  sources: Table;
  reviewers: Table;
  reviewerEnrolments: Table;
  publisherKeys: Map<string, Obj>;
  intentLog: number;
}
const st = engineState((e: Engine): Pca => ({
  principals: new Map(), grants: new Map(), needs: new Table('pca_grant_needs', e.clock.now, 'need'), stepUps: new Map(), constitutions: new Map(), pqPins: new Map(), pqTombstones: new Map(), beacons: [], bonds: new Map(), undo: new Map(),
  guardian: [{ epoch: 1, public_key: randomToken(32), created_at: e.clock.now(), retired_at: null }], maps: new Map(), observations: [], schemas: new Map(), receipts: new Map(),
  approvers: new Table('pca_approvers', e.clock.now, 'apv'), enrolments: new Table('pca_approver_enrolments', e.clock.now, 'apve'),
  settings: { channels: { push: true, email: true, sms: false, slack: false, webhook: false }, default_member_channels: ['push', 'email'], ciba: null, slack_webhook_set: false, ciba_client_secret_set: false },
  registry: new Map(), drafts: new Map(), sources: new Table('pca_action_sources', e.clock.now, 'asrc'), reviewers: new Table('pca_action_reviewers', e.clock.now, 'arv'), reviewerEnrolments: new Table('pca_action_reviewer_enrolments', e.clock.now, 'arve'),
  publisherKeys: new Map(), intentLog: 0,
}));

// ── authority statements ──

const covers = (patterns: string[], r: string): boolean => patterns.some((p) => (p.endsWith('*') ? r.startsWith(p.slice(0, -1)) : p === r));
function authorityOf(v: unknown, param = 'authority'): Authority {
  const a = objArg(v, param);
  if (!Array.isArray(a.verbs) || !Array.isArray(a.resources) || [...a.verbs, ...a.resources].some((x) => typeof x !== 'string')) throw bad('authority needs verbs and resources: lists of strings.', param);
  if (a.limits !== undefined && (!isObj(a.limits) || Object.values(a.limits).some((n) => typeof n !== 'number' || n < 0))) throw bad('authority.limits are named non-negative numbers.', param);
  if (a.expires_at !== undefined && !Number.isInteger(a.expires_at)) throw bad('authority.expires_at is epoch milliseconds.', param);
  return { verbs: [...new Set(a.verbs as string[])], resources: [...new Set(a.resources as string[])], ...(a.limits ? { limits: a.limits } : {}), ...(a.expires_at !== undefined ? { expires_at: a.expires_at as number } : {}) };
}
/** Is `next` provably not wider than `cur`? */
function notWider(cur: Authority, next: Authority): boolean {
  if (!next.verbs.every((v) => cur.verbs.includes(v))) return false;
  if (!next.resources.every((r) => covers(cur.resources, r) || cur.resources.some((p) => p.endsWith('*') && r.endsWith('*') && r.startsWith(p.slice(0, -1))))) return false;
  for (const [k, n] of Object.entries(next.limits ?? {})) if (cur.limits && k in cur.limits && (n as number) > (cur.limits[k] as number)) return false;
  for (const k of Object.keys(cur.limits ?? {})) if (!(k in (next.limits ?? {}))) return false; // dropping a ceiling widens
  if (cur.expires_at !== undefined && (next.expires_at === undefined || next.expires_at > cur.expires_at)) return false;
  return true;
}
const union = (a: Authority, b: Authority): Authority => ({
  verbs: [...new Set([...a.verbs, ...b.verbs])], resources: [...new Set([...a.resources, ...b.resources])],
  ...(a.limits || b.limits ? { limits: Object.fromEntries([...new Set([...Object.keys(a.limits ?? {}), ...Object.keys(b.limits ?? {})])].map((k) => [k, Math.max((a.limits?.[k] as number) ?? 0, (b.limits?.[k] as number) ?? 0)])) } : {}),
  ...(a.expires_at !== undefined && b.expires_at !== undefined ? { expires_at: Math.max(a.expires_at, b.expires_at) } : {}),
});

const grantOf = (e: Engine, ref: string | undefined): Obj => {
  const g = st(e).grants.get(ref ?? '');
  if (!g) throw notFound('Grant');
  return g;
};
const epochView = (e: Engine): Obj => ({ guardian_epoch: st(e).guardian[st(e).guardian.length - 1]!.epoch, issued_at: e.clock.now(), revoked: [...st(e).grants.values()].filter((g) => g.status === 'revoked').length });
const grantView = (g: Obj): Obj => ({ object: 'pca_grant', grant_ref: g.grant_ref, status: g.status, principal: g.principal, agent: g.agent, chain_digest: g.chain_digest });
const authView = (g: Obj, extra: Obj = {}): Obj => ({ object: 'pca_grant_authority', grant_ref: g.grant_ref, rev: g.rev, status: g.authority ? 'active' : 'none', authority: g.authority, authority_digest: g.authority_digest, ...extra });

/** A step-up challenge is single use: it must exist for this grant, be approved, unexpired and unspent. It is spent here. */
function spendStepUp(e: Engine, g: Obj, ref: unknown): void {
  const s = typeof ref === 'string' ? st(e).stepUps.get(ref) : undefined;
  if (!s || s.grant_ref !== g.grant_ref) throw new EmulatorError('FORBIDDEN', 'A widening needs a step-up of this grant: POST /v1/pca/grants/{grantRef}/step-up and have the principal approve it.', 'step_up_ref');
  if (!s.approved || s.spent || s.expires_at <= e.clock.now()) throw new EmulatorError('FORBIDDEN', 'That step-up is not approved, was already used or has expired.', 'step_up_ref');
  s.spent = true;
}

function grantRoutes(): RouteDef[] {
  const need = (e: Engine, id: string | undefined): Obj => {
    const n = st(e).needs.get(id);
    if (!n) throw notFound('Need request');
    return n;
  };
  const needView = (n: Obj): Obj => ({ object: 'pca_grant_need', id: n.id, grant_ref: n.grant_ref, status: n.status, needs: n.needs, rev: n.rev, created_at: n.created_at, ...(n.decided_at ? { decided_at: n.decided_at } : {}) });
  const successor = (e: Engine, old: Obj, ref: unknown, authority: Authority): Obj => {
    const next = typeof ref === 'string' ? st(e).grants.get(ref) : undefined;
    if (!next) throw bad('new_grant_ref must name a registered grant: register the successor first (POST /v1/pca/grants).', 'new_grant_ref');
    if (next.principal !== old.principal || next.agent !== old.agent) throw bad('The successor must have the same principal and holder.', 'new_grant_ref');
    old.status = 'superseded';
    Object.assign(next, { rev: 0, authority, authority_digest: undefined, supersedes: old.grant_ref });
    return next;
  };
  return [
    {
      // Self-authenticating in the real service; here the grant is registered as sent (see the module note).
      method: 'POST', pattern: '/v1/pca/grants', public: true, handler: async (c) => {
        const e = c.engine;
        const grant = objArg(c.body.grant, 'grant');
        sig(c.body.holder_pop, 'holder_pop');
        const principal = str(grant.iss ?? grant.issuer ?? grant.principal, 'grant.iss');
        const agent = str(grant.sub ?? grant.holder ?? grant.aud, 'grant.sub');
        const ref = typeof grant.id === 'string' ? grant.id : typeof grant.cap_id === 'string' ? grant.cap_id : await hex(canonical(grant));
        if (st(e).grants.has(ref)) throw conflict('That grant is already registered.');
        const pinned = st(e).principals.get(principal);
        if (pinned?.status === 'disabled') throw new EmulatorError('FORBIDDEN', 'The issuer principal is disabled.');
        st(e).grants.set(ref, { grant_ref: ref, status: 'active', principal, agent, grant, chain_digest: await hex(canonical(grant)), tier: pinned ? 'verified' : 'unverified', rev: 0, authority: null, authority_digest: null, revoked_capabilities: 0, created_at: e.clock.now() });
        return { status: 201, body: { object: 'pca_grant', grant_ref: ref, status: 'active', tier: pinned ? 'verified' : 'unverified' } };
      },
    },
    { method: 'POST', pattern: '/v1/pca/principals', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const pub = str(c.body.principal_pub, 'principal_pub');
      const type = c.body.subject_type;
      if (type !== 'user' && type !== 'org' && type !== 'machine') throw bad('subject_type is user, org or machine.', 'subject_type');
      const id = str(c.body.subject_id, 'subject_id');
      const exists = type === 'user' ? e.db.users.get(id) && !e.db.users.get(id)!.deleted : type === 'org' ? e.db.organizations.get(id) : e.db.machines.get(id);
      if (!exists) throw bad(`No ${type} ${id} in this instance.`, 'subject_id');
      if (st(e).principals.get(pub)?.status === 'active') throw conflict('That principal key is already enrolled.');
      const row = { object: 'pca_principal', principal_pub: pub, subject_type: type, subject_id: id, status: 'active', created_at: e.clock.now() };
      st(e).principals.set(pub, row);
      audit(e, c, 'pca.principal_enrolled', 'pca_principal', pub, { subject_type: type, subject_id: id });
      return { status: 201, body: row };
    } },
    { method: 'GET', pattern: '/v1/pca/principals', scope: READ, handler: (c) => ({ body: listOf([...st(c.engine).principals.values()]) }) },
    { method: 'DELETE', pattern: '/v1/pca/principals/:principalPub', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const p = st(e).principals.get(c.params.principalPub!);
      if (!p) throw notFound('Principal');
      p.status = 'disabled';
      audit(e, c, 'pca.principal_disabled', 'pca_principal', p.principal_pub, {});
      return { body: { object: 'pca_principal', principal_pub: p.principal_pub, status: 'disabled' } };
    } },
    { method: 'GET', pattern: '/v1/pca/grants', scope: READ, handler: (c) => {
      const q = c.query;
      const status = q.get('status');
      if (status && status !== 'active' && status !== 'revoked') throw bad('status is active or revoked.', 'status');
      const limit = Math.min(200, Math.max(1, Number(q.get('limit') ?? 50) || 50));
      const rows = [...st(c.engine).grants.values()].filter((g) => (!q.get('principal') || g.principal === q.get('principal')) && (!q.get('agent') || g.agent === q.get('agent')) && (!status || g.status === status)).sort((a, b) => (a.grant_ref < b.grant_ref ? -1 : 1));
      const cursor = q.get('cursor');
      const start = cursor ? rows.findIndex((g) => g.grant_ref === cursor) + 1 : 0;
      const page = rows.slice(start, start + limit);
      const more = start + limit < rows.length;
      return { body: { object: 'list', data: page.map(grantView), ...(more ? { next_cursor: page[page.length - 1]!.grant_ref } : {}) } };
    } },
    { method: 'GET', pattern: '/v1/pca/grants/:grantRef', scope: READ, handler: (c) => {
      const g = grantOf(c.engine, c.params.grantRef);
      return { body: { ...grantView(g), grant: g.grant, remaining_budget: {}, revoked_capabilities: g.revoked_capabilities, revocation_epoch: epochView(c.engine) } };
    } },
    { method: 'DELETE', pattern: '/v1/pca/grants/:grantRef', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const g = grantOf(e, c.params.grantRef);
      const scope = c.query.get('scope') ?? 'grant';
      if (scope !== 'grant' && scope !== 'agent') throw bad('scope is grant or agent.', 'scope');
      const targets = scope === 'agent' ? [...st(e).grants.values()].filter((x) => x.principal === g.principal && x.agent === g.agent && x.status === 'active') : [g];
      const revoked: string[] = [];
      for (const t of targets) if (t.status !== 'revoked') (t.status = 'revoked', t.revoked_at = e.clock.now(), revoked.push(t.grant_ref));
      audit(e, c, 'pca.grant_revoked', 'pca_grant', g.grant_ref, { scope });
      e.webhooks.emit('pca.grant_revoked', { object: 'pca_grant', grant_ref: g.grant_ref, revoked });
      return { body: { object: 'pca_grant_revocation', revoked, revocation_epoch: epochView(e) } };
    } },
    { method: 'PUT', pattern: '/v1/pca/grants/:grantRef/authority', scope: WRITE, handler: async (c) => {
      const e = c.engine;
      const g = grantOf(e, c.params.grantRef);
      const a = authorityOf(c.body.authority);
      sig(c.body.sig);
      if (g.authority) throw conflict('This grant is already managed: change it with amend.');
      Object.assign(g, { authority: a, rev: 0, authority_digest: await hex(canonical(a)) });
      return { status: 201, body: authView(g) };
    } },
    { method: 'POST', pattern: '/v1/pca/grants/:grantRef/step-up', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const g = grantOf(e, c.params.grantRef);
      const id = e.db.newId('stepup');
      const row = { grant_ref: g.grant_ref, nonce: randomToken(16), expires_at: e.clock.now() + 300_000, approved: false, spent: false };
      st(e).stepUps.set(id, row);
      return { status: 201, body: { object: 'pca_grant_step_up', step_up_ref: id, nonce: row.nonce, expires_at: iso(row.expires_at) } };
    } },
    { method: 'POST', pattern: '/v1/pca/grants/:grantRef/step-up/:challengeId/approve', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const g = grantOf(e, c.params.grantRef);
      const s = st(e).stepUps.get(c.params.challengeId!);
      if (!s || s.grant_ref !== g.grant_ref) throw notFound('Step-up challenge');
      sig(c.body.sig);
      if (s.expires_at <= e.clock.now()) throw new EmulatorError('FORBIDDEN', 'That step-up has expired.');
      if (s.approved) throw conflict('That step-up was already approved.');
      s.approved = true;
      return { body: { object: 'pca_grant_step_up', step_up_ref: c.params.challengeId, approved: true } };
    } },
    { method: 'POST', pattern: '/v1/pca/grants/:grantRef/amend', scope: WRITE, handler: async (c) => {
      const e = c.engine;
      const g = grantOf(e, c.params.grantRef);
      const b = c.body;
      if (!g.authority) throw conflict('This grant has no authority statement yet: enrol it with PUT /v1/pca/grants/{grantRef}/authority.');
      if (b.action !== 'narrow' && b.action !== 'merge' && b.action !== 'replace') throw bad('action is narrow, merge or replace.', 'action');
      const given = authorityOf(b.authority);
      if (b.signed_by !== undefined && b.signed_by !== 'holder' && b.signed_by !== 'principal') throw bad('signed_by is holder or principal.', 'signed_by');
      sig(b.sig);
      const cur = g.authority as Authority;
      const next = b.action === 'merge' ? union(cur, given) : given;
      const digest = await hex(canonical(next));
      if (notWider(cur, next)) {
        g.rev += 1;
        Object.assign(g, { authority: next, authority_digest: digest });
        return { body: authView(g, { created: false }) };
      }
      if (b.action === 'narrow') throw bad('That change is wider than the current authority: it is not a narrowing.', 'authority');
      if (b.signed_by !== 'principal') throw new EmulatorError('FORBIDDEN', 'A change that widens needs the principal signature (signed_by: principal).', 'signed_by');
      spendStepUp(e, g, b.step_up_ref);
      const succ = successor(e, g, b.new_grant_ref, next);
      succ.authority_digest = digest;
      return { status: 200, body: authView(succ, { created: true, supersedes: g.grant_ref }) };
    } },
    { method: 'POST', pattern: '/v1/pca/grants/:grantRef/needs', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const g = grantOf(e, c.params.grantRef);
      if (!Array.isArray(c.body.needs) || c.body.needs.length === 0 || c.body.needs.length > 50) throw bad('needs is a list of 1 to 50 needs.', 'needs');
      const needs = c.body.needs.map((n: unknown, i: number) => {
        const o = objArg(n, `needs.${i}`);
        return { verb: str(o.verb, `needs.${i}.verb`), resource: str(o.resource, `needs.${i}.resource`), ...(o.limits ? { limits: objArg(o.limits, `needs.${i}.limits`) } : {}), adjustable: o.adjustable === true };
      });
      if (c.body.sig !== undefined) sig(c.body.sig);
      const row = st(e).needs.insert({ grant_ref: g.grant_ref, status: 'pending', needs, rev: g.rev, created_at: e.clock.now() } as any);
      return { status: 201, body: needView(row) };
    } },
    { method: 'GET', pattern: '/v1/pca/grants/:grantRef/needs', scope: READ, handler: (c) => {
      const e = c.engine;
      const g = grantOf(e, c.params.grantRef);
      const s = c.query.get('status');
      if (s && !['pending', 'approved', 'denied'].includes(s)) throw bad('status is pending, approved or denied.', 'status');
      return { body: listOf(st(e).needs.filter((n) => n.grant_ref === g.grant_ref && (!s || n.status === s)).map(needView)) };
    } },
    { method: 'POST', pattern: '/v1/pca/needs/:needId/approve', scope: WRITE, handler: async (c) => {
      const e = c.engine;
      const n = need(e, c.params.needId);
      if (n.status !== 'pending') throw conflict(`That need request is already ${n.status}.`);
      const g = grantOf(e, n.grant_ref);
      if (!g.authority) throw conflict('This grant has no authority statement to widen.');
      sig(c.body.sig);
      if (!Array.isArray(c.body.approved) || c.body.approved.length !== n.needs.length) throw bad('approved lists the same needs, in order.', 'approved');
      c.body.approved.forEach((a: any, i: number) => {
        const o = n.needs[i];
        if (!isObj(a) || a.verb !== o.verb || a.resource !== o.resource) throw bad(`approved[${i}] must name the same verb and resource.`, 'approved');
        for (const [k, v] of Object.entries(a.limits ?? {})) if (!o.adjustable ? v !== o.limits?.[k] : typeof v !== 'number' || v > (o.limits?.[k] ?? Infinity)) throw bad(`approved[${i}].limits.${k}: an amount may only be lowered, on an adjustable need.`, 'approved');
      });
      spendStepUp(e, g, c.body.step_up_ref);
      const cur = g.authority as Authority;
      const next = union(cur, { verbs: n.needs.map((x: Obj) => x.verb), resources: n.needs.map((x: Obj) => x.resource), limits: Object.assign({}, ...c.body.approved.map((a: Obj) => a.limits ?? {})) });
      const succ = successor(e, g, c.body.new_grant_ref, next);
      succ.authority_digest = await hex(canonical(next));
      Object.assign(n, { status: 'approved', decided_at: e.clock.now() });
      return { status: 201, body: { object: 'pca_grant_authority', grant_ref: succ.grant_ref, supersedes: g.grant_ref, authority: next } };
    } },
    { method: 'POST', pattern: '/v1/pca/needs/:needId/deny', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const n = need(e, c.params.needId);
      if (n.status !== 'pending') throw conflict(`That need request is already ${n.status}.`);
      if (c.body.sig !== undefined) sig(c.body.sig);
      Object.assign(n, { status: 'denied', decided_at: e.clock.now() });
      return { body: { object: 'pca_grant_need', id: n.id, status: 'denied' } };
    } },
  ];
}

// ── constitutions, pins, beacons, bonds, receipts, guardian, undo ──

function trustRoutes(): RouteDef[] {
  const head = (e: Engine) => st(e).guardian[st(e).guardian.length - 1]!;
  const undoView = (r: Obj): Obj => ({ object: 'pca_undo_record', record: Object.fromEntries(Object.entries(r.record).filter(([k]) => k !== 'pcactn')), pending_veto: r.pending_veto ?? null });
  const UNDO_IDENTITY = ['id', 'audience', 'grant_ref', 'holder', 'principal', 'compensation', 'window_end', 'pcactn'];
  return [
    { method: 'POST', pattern: '/v1/pca/constitutions', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const g = grantOf(e, str(c.body.grant_ref, 'grant_ref'));
      const k = objArg(c.body.constitution, 'constitution');
      const id = str(k.id, 'constitution.id');
      sig(k.sig, 'constitution.sig');
      if (!Array.isArray(k.invariants) || k.invariants.length === 0) throw bad('constitution.invariants is a non-empty list.', 'constitution');
      if (k.principal !== g.principal) throw bad("The constitution must be signed by the grant's principal.", 'constitution');
      const prior = st(e).constitutions.get(g.grant_ref);
      if (prior && prior.constitution_id !== id) throw conflict('A different constitution is already set for this grant: it is immutable.');
      const row = prior ?? { object: 'pca_constitution', grant_ref: g.grant_ref, constitution: k, constitution_id: id, registered_at: iso(e.clock.now()), monitor: null, progress: null };
      st(e).constitutions.set(g.grant_ref, row);
      return { status: 201, body: row };
    } },
    { method: 'GET', pattern: '/v1/pca/constitutions', public: true, handler: (c) => {
      const row = st(c.engine).constitutions.get(str(c.query.get('grant_ref'), 'grant_ref'));
      if (!row) throw notFound('Constitution');
      return { body: row };
    } },
    { method: 'POST', pattern: '/v1/pca/pq-pins', public: true, handler: (c) => {
      const e = c.engine;
      const b = objArg(c.body.binding, 'binding');
      const ed = str(b.ed, 'binding.ed');
      const pq = str(b.pq, 'binding.pq', 8192);
      if (!Number.isInteger(b.epoch) || b.epoch < 1) throw bad('binding.epoch is a positive integer.', 'binding');
      if (b.aud !== e.instanceId) throw bad("binding.aud is this instance's id.", 'binding');
      sig(b.sig, 'binding.sig');
      if (st(e).principals.get(ed)?.status !== 'active') throw bad('The identity must be an enrolled, active principal.', 'binding');
      const prior = st(e).pqPins.get(ed);
      if (prior) throw conflict('A pin is registered for this identity: delete it to rotate, then register a higher epoch.');
      if (b.epoch <= (st(e).pqTombstones.get(ed) ?? 0)) throw conflict('The epoch must be higher than the one last removed.');
      const row = { object: 'pca_pq_pin', identity: ed, pq_pk: pq, epoch: b.epoch, aud: b.aud, sig: b.sig };
      st(e).pqPins.set(ed, row);
      return { status: 201, body: row };
    } },
    { method: 'GET', pattern: '/v1/pca/pq-pins', public: true, handler: (c) => {
      const row = st(c.engine).pqPins.get(str(c.query.get('identity'), 'identity'));
      if (!row) throw notFound('PQ pin');
      return { body: row };
    } },
    { method: 'DELETE', pattern: '/v1/pca/pq-pins/:identity', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const row = st(e).pqPins.get(c.params.identity!);
      if (!row) throw notFound('PQ pin');
      st(e).pqPins.delete(row.identity);
      st(e).pqTombstones.set(row.identity, row.epoch);
      return { body: { object: 'pca_pq_pin', identity: row.identity, deleted: true } };
    } },
    { method: 'POST', pattern: '/v1/pca/beacons', scope: WRITE, handler: async (c) => {
      const e = c.engine;
      const now = e.clock.now();
      let beacon: Obj;
      let kind: 'principal' | 'operator';
      if (c.body.beacon !== undefined) {
        // principal path: a v2 beacon signed with the grant principal's key
        const b = objArg(c.body.beacon, 'beacon');
        sig(b.sig, 'beacon.sig');
        if (b.v !== 2 || typeof b.scope !== 'string' || !Number.isInteger(b.not_after) || typeof b.issuer !== 'string') throw bad('beacon is {v: 2, instance, scope, epoch, seq, issued_at, not_after, issuer, sig}.', 'beacon');
        if (b.scope !== '*' && st(e).grants.get(b.scope)?.principal !== b.issuer) throw bad('A principal beacon covers a grant that principal issued, or *.', 'beacon');
        beacon = b;
        kind = 'principal';
      } else {
        const scope = c.body.scope ?? '*';
        if (scope !== '*') grantOf(e, str(scope, 'scope'));
        const validity = c.body.validity_ms ?? 300_000;
        if (!Number.isInteger(validity) || validity < 1 || validity > 3_600_000) throw bad('validity_ms is 1 to 3600000.', 'validity_ms');
        beacon = { v: 2, instance: e.instanceId, scope, epoch: Math.floor(now / 60_000), seq: st(e).beacons.length + 1, issued_at: now, not_after: now + validity, issuer: 'operator' };
        beacon.sig = await e.tokens.signClaims({ beacon: canonical(beacon) }, Math.ceil(validity / 1000));
        kind = 'operator';
      }
      const ref = await hex(canonical(beacon));
      st(e).beacons.push({ beacon, beacon_ref: ref, issuer_kind: kind });
      return { status: 201, body: { object: 'pca_beacon', beacon, beacon_ref: ref, issuer_kind: kind } };
    } },
    { method: 'GET', pattern: '/v1/pca/beacons', public: true, handler: (c) => {
      const e = c.engine;
      const now = e.clock.now();
      const ref = c.query.get('grant_ref');
      const data = st(e).beacons.filter((b) => !ref || b.beacon.scope === ref || b.beacon.scope === '*').map((b) => ({ object: 'pca_beacon', ...b, live: b.beacon.not_after > now }));
      return { body: { object: 'list', data, now, epoch_ms: 60_000, max_validity_ms: 3_600_000, mode: null } };
    } },
    { method: 'POST', pattern: '/v1/pca/bond-accounts', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const account = str(c.body.account, 'account');
      if (typeof c.body.amount !== 'number' || !(c.body.amount > 0)) throw bad('amount is a positive number.', 'amount');
      const balance = (st(e).bonds.get(account) ?? 0) + c.body.amount;
      st(e).bonds.set(account, balance);
      audit(e, c, 'pca.bond_credited', 'pca_bond_account', account, { amount: c.body.amount });
      return { body: { object: 'pca_bond_account', account, balance } };
    } },
    { method: 'GET', pattern: '/v1/pca/bond-accounts', scope: READ, handler: (c) => {
      const account = str(c.query.get('account'), 'account');
      return { body: { object: 'pca_bond_account', account, balance: st(c.engine).bonds.get(account) ?? 0 } };
    } },
    { method: 'POST', pattern: '/v1/pca/workflow-receipts', scope: WRITE, handler: async (c) => {
      const e = c.engine;
      const g = grantOf(e, str(c.body.grant_ref, 'grant_ref'));
      const wf = objArg(c.body.workflow, 'workflow');
      const body = objArg(wf.body, 'workflow.body');
      sig(wf.sig, 'workflow.sig');
      const step = str(c.body.step, 'step');
      if (!Array.isArray(body.steps) || !body.steps.some((s: any) => s?.id === step)) throw bad('step is not a step of this workflow.', 'step');
      if (c.body.outcome !== 'ok' && c.body.outcome !== 'failed') throw bad('outcome is ok or failed.', 'outcome');
      str(c.body.params_digest, 'params_digest');
      const outputs = objArg(c.body.outputs, 'outputs');
      const wfDigest = await hex(canonical(body));
      const chain = [...(st(e).receipts.get(`${g.grant_ref}|${wfDigest}`) ?? [])];
      if (chain.some((r) => r.step === step)) throw conflict('A receipt for that step already exists.');
      const receipt: Obj = { v: 1, grant_ref: g.grant_ref, workflow: wfDigest, step, outcome: c.body.outcome, params_digest: c.body.params_digest, outputs, prev: chain.length ? await hex(canonical(chain[chain.length - 1])) : null, issued_at: e.clock.now(), guardian_epoch: head(e).epoch };
      receipt.sig = await e.tokens.signClaims({ receipt: await hex(canonical(receipt)) }, 3600);
      chain.push(receipt);
      st(e).receipts.set(`${g.grant_ref}|${wfDigest}`, chain);
      return { status: 201, body: { object: 'pca_workflow_receipt', grant_ref: g.grant_ref, receipt, receipts: chain } };
    } },
    { method: 'GET', pattern: '/v1/pca/guardian/keys', public: true, handler: (c) => {
      const keys = st(c.engine).guardian;
      const cur = keys[keys.length - 1]!;
      return { body: { object: 'pca_guardian_keys', current_epoch: cur.epoch, current_public_key: cur.public_key, keys: keys.map((k) => ({ epoch: k.epoch, public_key: k.public_key, created_at: iso(k.created_at), retired_at: k.retired_at ? iso(k.retired_at) : null })) } };
    } },
    { method: 'POST', pattern: '/v1/pca/guardian/rotate', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const keys = st(e).guardian;
      const prev = keys[keys.length - 1]!;
      prev.retired_at = e.clock.now();
      const next = { epoch: prev.epoch + 1, public_key: randomToken(32), created_at: e.clock.now(), retired_at: null };
      keys.push(next);
      audit(e, c, 'pca.guardian_rotated', 'pca_guardian', String(next.epoch), {});
      return { status: 201, body: { object: 'pca_guardian', epoch: next.epoch, public_key: next.public_key, previous: { epoch: prev.epoch, public_key: prev.public_key }, keys: keys.map((k) => ({ epoch: k.epoch, public_key: k.public_key, created_at: iso(k.created_at), retired_at: k.retired_at ? iso(k.retired_at) : null })) } };
    } },
    // undo ledger
    { method: 'POST', pattern: '/v1/pca/undo/records', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const r = objArg(c.body.record, 'record');
      const id = str(r.id, 'record.id');
      grantOf(e, str(r.grant_ref, 'record.grant_ref'));
      if (!Number.isInteger(r.window_end) || !Number.isInteger(r.ver) || !Array.isArray(r.receipts)) throw bad('record needs window_end, ver and receipts.', 'record');
      const prior = st(e).undo.get(id);
      if (prior) {
        if (canonical(prior.record) !== canonical(r)) throw conflict('A different record already uses this id.');
        return { status: 201, body: undoView(prior) };
      }
      const row = { record: r, pending_veto: null };
      st(e).undo.set(id, row);
      return { status: 201, body: undoView(row) };
    } },
    { method: 'GET', pattern: '/v1/pca/undo/records/:id', scope: READ, handler: (c) => {
      const row = st(c.engine).undo.get(c.params.id!);
      if (!row) throw notFound('Undo record');
      return { body: undoView(row) };
    } },
    { method: 'PUT', pattern: '/v1/pca/undo/records/:id', scope: WRITE, handler: (c) => {
      const row = st(c.engine).undo.get(c.params.id!);
      if (!row) throw notFound('Undo record');
      const r = objArg(c.body.record, 'record');
      for (const k of UNDO_IDENTITY) if (canonical(r[k] ?? null) !== canonical(row.record[k] ?? null)) throw conflict(`The record identity cannot change (${k}).`);
      if (!Number.isInteger(r.ver) || r.ver <= row.record.ver) throw conflict('ver must increase.');
      const prefix = (row.record.receipts as unknown[]).map((x) => canonical(x));
      if (!Array.isArray(r.receipts) || prefix.some((p, i) => canonical(r.receipts[i]) !== p)) throw conflict('The stored receipts must be a prefix of the new chain.');
      row.record = r;
      if (r.state === 'vetoed') row.pending_veto = null;
      return { body: undoView(row) };
    } },
    { method: 'POST', pattern: '/v1/pca/undo/:id/veto', public: true, handler: async (c) => {
      const e = c.engine;
      const row = st(e).undo.get(c.params.id!);
      if (!row) throw notFound('Undo record');
      const token = c.body.token;
      if (typeof token !== 'string' && !isObj(token)) throw bad('token is the encoded undo token or the token object.', 'token');
      if (row.record.window_end <= e.clock.now()) throw new EmulatorError('FORBIDDEN', 'The undo window has ended.');
      if (row.pending_veto) throw conflict('A veto is already waiting on this record.');
      row.pending_veto = { at: e.clock.now(), via: 'token', by: row.record.principal, evidence: await hex(typeof token === 'string' ? token : canonical(token)), token: typeof token === 'string' ? token : canonical(token) };
      return { status: 202, body: { object: 'pca_undo_veto', record_id: c.params.id, status: 'pending', veto: { at: row.pending_veto.at, via: 'token', by: row.pending_veto.by, evidence: row.pending_veto.evidence } } };
    } },
    { method: 'GET', pattern: '/v1/pca/undo/vetoes', scope: READ, handler: (c) => {
      const limit = Number(c.query.get('limit') ?? 100);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw bad('limit is 1 to 200.', 'limit');
      const data = [...st(c.engine).undo.values()].filter((r) => r.pending_veto).sort((a, b) => a.pending_veto.at - b.pending_veto.at).slice(0, limit).map((r) => ({ object: 'pca_undo_veto', record_id: r.record.id, grant_ref: r.record.grant_ref, state: r.record.state ?? 'pending', ver: r.record.ver, window_end: r.record.window_end, veto: r.pending_veto }));
      return { body: { object: 'list', data } };
    } },
    // intent maps and schemas
    { method: 'POST', pattern: '/v1/pca/intent/maps', public: true, handler: async (c) => {
      const e = c.engine;
      const m = objArg(c.body.map, 'map');
      if (m.v !== 1 || m.kind !== 'pca-intent-map') throw bad('map is {v: 1, kind: "pca-intent-map", ...}.', 'map');
      const metrics = objArg(m.metrics, 'map.metrics');
      for (const k of ['fidelity_ppm', 'residual_risk_ppm']) if (!Number.isInteger(metrics[k]) || metrics[k] < 0 || metrics[k] > 1_000_000) throw bad(`map.metrics.${k} is an integer in parts per million.`, 'map');
      const digest = await hex(canonical(m));
      const row = { object: 'pca_intent_map', digest, intent_ref: m.intent_ref ?? null, fidelity_ppm: metrics.fidelity_ppm, residual_risk_ppm: metrics.residual_risk_ppm, map: m, attestation: c.body.attestation ?? null, anchor: { index: st(e).intentLog++, commit: await hex(`${digest}|${st(e).intentLog}`) } };
      if (!st(e).maps.has(digest)) st(e).maps.set(digest, row);
      return { status: 201, body: st(e).maps.get(digest) };
    } },
    { method: 'GET', pattern: '/v1/pca/intent/maps/:digest', public: true, handler: (c) => {
      const row = st(c.engine).maps.get(c.params.digest!);
      if (!row) throw notFound('Intent map');
      return { body: { object: row.object, digest: row.digest, intent_ref: row.intent_ref, fidelity_ppm: row.fidelity_ppm, residual_risk_ppm: row.residual_risk_ppm, map: row.map, attestation: row.attestation } };
    } },
    { method: 'POST', pattern: '/v1/pca/intent/observations', public: true, handler: async (c) => {
      const e = c.engine;
      const o = objArg(c.body.observation, 'observation');
      if (!st(e).maps.has(str(o.map_digest, 'observation.map_digest'))) throw notFound('Intent map');
      if (o.y !== 0 && o.y !== 1) throw bad('observation.y is 0 (divergence) or 1 (confirmed).', 'observation');
      sig(o.sig, 'observation.sig');
      const digest = await hex(canonical(o));
      const row = { object: 'pca_intent_observation', digest, observation: o, anchor: { index: st(e).intentLog++, commit: await hex(`${digest}|${st(e).intentLog}`) }, at: e.clock.now() };
      st(e).observations.push(row);
      return { status: 201, body: row };
    } },
    { method: 'GET', pattern: '/v1/pca/intent/maps/:digest/observations', scope: READ, handler: (c) => {
      const e = c.engine;
      if (!st(e).maps.has(c.params.digest!)) throw notFound('Intent map');
      const limit = Number(c.query.get('limit') ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw bad('limit is 1 to 200.', 'limit');
      const rows = st(e).observations.filter((o) => o.observation.map_digest === c.params.digest);
      const after = c.query.get('after');
      const start = after ? rows.findIndex((o) => o.digest === after) + 1 : 0;
      const data = rows.slice(start, start + limit).map((o) => ({ object: o.object, digest: o.digest, observation: o.observation, anchor: o.anchor }));
      const more = start + limit < rows.length;
      return { body: { object: 'list', data, next_cursor: more ? data[data.length - 1]!.digest : null } };
    } },
    { method: 'POST', pattern: '/v1/pca/intent/schemas', scope: WRITE, handler: async (c) => {
      const e = c.engine;
      const s = objArg(c.body.schema, 'schema');
      if (s.v !== 1 || s.kind !== 'pca-action-schema') throw bad('schema is {v: 1, kind: "pca-action-schema", ...}.', 'schema');
      const keys = c.body.keys;
      if (!Array.isArray(keys) || keys.length === 0) throw bad('keys lists the site schema keys from its discovery document.', 'keys');
      const signing = objArg(s.sig, 'schema.sig');
      if (!keys.some((k: any) => k?.kid === signing.kid)) throw bad('schema.sig.kid is not among the keys.', 'keys');
      str(s.aud, 'schema.aud');
      const digest = await hex(canonical(s));
      const row = { object: 'pca_intent_schema', digest, aud: s.aud, version: String(s.version ?? ''), schema: s, anchor: { index: st(e).intentLog++, commit: await hex(`${digest}|${st(e).intentLog}`) } };
      if (!st(e).schemas.has(digest)) st(e).schemas.set(digest, row);
      return { status: 201, body: st(e).schemas.get(digest) };
    } },
    { method: 'GET', pattern: '/v1/pca/intent/schemas/:digest', public: true, handler: (c) => {
      const row = st(c.engine).schemas.get(c.params.digest!);
      if (!row) throw notFound('Action schema');
      return { body: { object: row.object, digest: row.digest, aud: row.aud, version: row.version, schema: row.schema } };
    } },
  ];
}

// ── passkey approvers ──

const CHANNELS = ['push', 'email', 'sms', 'ciba'];
const channelList = (v: unknown, param = 'channels'): string[] => {
  if (!Array.isArray(v) || v.some((x) => !CHANNELS.includes(x))) throw bad(`${param} is a list of: ${CHANNELS.join(', ')}.`, param);
  return [...new Set(v as string[])];
};
const approverView = (a: Obj): Obj => ({ object: 'pca_approver', id: a.id, principal_pub: a.principal_pub, subject_type: a.subject_type, subject_id: a.subject_id, display_name: a.display_name ?? null, quorum: a.quorum, status: a.status, created_at: iso(a.created_at), members: a.members.map((m: Obj) => ({ id: m.id, display_name: m.display_name ?? null, user_id: m.user_id ?? null, email: m.email ?? null, phone: m.phone ?? null, channels: m.channels, status: m.status, created_at: iso(m.created_at) })), credentials: a.credentials.map((x: Obj) => ({ id: x.id, member_id: x.member_id, name: x.name ?? null, transports: x.transports ?? [], aaguid: x.aaguid ?? null, status: x.status, created_at: iso(x.created_at), last_used_at: null, revoked_at: x.revoked_at ? iso(x.revoked_at) : null })) });
const settingsView = (s: Obj): Obj => ({ object: 'pca_approval_settings', channels: s.channels, default_member_channels: s.default_member_channels, ciba: s.ciba ? { ...s.ciba, client_secret_set: s.ciba_client_secret_set } : null, slack_webhook_set: s.slack_webhook_set });

function approverRoutes(): RouteDef[] {
  const one = (e: Engine, id: string | undefined): Obj => {
    const a = st(e).approvers.get(id);
    if (!a) throw notFound('Approver');
    return a;
  };
  const MEMBER_FIELDS = ['channels', 'email', 'phone', 'display_name', 'status'];
  return [
    { method: 'POST', pattern: '/v1/pca/approvers/enrolments', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const b = c.body;
      const row: Obj = { created_at: e.clock.now(), expires_at: e.clock.now() + 86_400_000, used: false, display_name: b.display_name ?? null, email: b.email ?? null, phone: b.phone ?? null, user_id: b.user_id ?? null, channels: b.channels === undefined ? [...st(e).settings.default_member_channels] : channelList(b.channels) };
      if (b.approver_id !== undefined) {
        const a = one(e, b.approver_id);
        if (b.member_id !== undefined && !a.members.some((m: Obj) => m.id === b.member_id)) throw notFound('Member');
        Object.assign(row, { approver_id: a.id, member_id: b.member_id ?? null });
      } else {
        const type = b.subject_type;
        if (type !== 'user' && type !== 'org' && type !== 'machine') throw bad('A new approver needs subject_type (user, org or machine) and subject_id.', 'subject_type');
        const sid = str(b.subject_id, 'subject_id');
        const exists = type === 'user' ? e.db.users.get(sid) && !e.db.users.get(sid)!.deleted : type === 'org' ? e.db.organizations.get(sid) : e.db.machines.get(sid);
        if (!exists) throw bad(`No ${type} ${sid} in this instance.`, 'subject_id');
        Object.assign(row, { subject_type: type, subject_id: sid });
      }
      const en = st(e).enrolments.insert(row as any);
      return { status: 201, body: { object: 'pca_approver_enrolment', id: en.id, enrolment_url: `${e.issuer}/pca/approvals/enrol?token=${randomToken(24)}`, expires_at: iso(en.expires_at), approver_id: en.approver_id ?? null, member_id: en.member_id ?? null } };
    } },
    // Emulator control: the person opens the link and registers a passkey.
    { method: 'POST', pattern: '/__emulator/pca/approver_enrolments/:id/complete', public: true, handler: (c) => {
      const e = c.engine;
      const en = st(e).enrolments.get(c.params.id);
      if (!en || en.used || en.expires_at <= e.clock.now()) throw notFound('Enrolment');
      en.used = true;
      const now = e.clock.now();
      const member = { id: e.db.newId('apvm'), display_name: en.display_name, user_id: en.user_id, email: en.email, phone: en.phone, channels: en.channels, status: 'active', created_at: now };
      const cred = { id: e.db.newId('apvc'), member_id: member.id, name: c.body.name ?? null, transports: [], aaguid: null, status: 'active', created_at: now, revoked_at: null };
      let a = en.approver_id ? st(e).approvers.get(en.approver_id) : undefined;
      if (a) {
        if (en.member_id) cred.member_id = en.member_id;
        else a.members.push(member);
        a.credentials.push(cred);
      } else a = st(e).approvers.insert({ principal_pub: randomToken(32), subject_type: en.subject_type, subject_id: en.subject_id, display_name: en.display_name, quorum: 1, status: 'active', created_at: now, members: [member], credentials: [cred] } as any);
      return { status: 201, body: approverView(a!) };
    } },
    { method: 'GET', pattern: '/v1/pca/approvers', scope: READ, handler: (c) => ({ body: { object: 'list', data: st(c.engine).approvers.all().map(approverView) } }) },
    { method: 'GET', pattern: '/v1/pca/approvers/:id', scope: READ, handler: (c) => ({ body: approverView(one(c.engine, c.params.id)) }) },
    { method: 'PATCH', pattern: '/v1/pca/approvers/:id', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const a = one(e, c.params.id);
      const b = c.body;
      if (b.quorum !== undefined) {
        const active = a.members.filter((m: Obj) => m.status === 'active').length;
        if (!Number.isInteger(b.quorum) || b.quorum < 1 || b.quorum > Math.max(active, 1)) throw bad(`quorum is 1 to the number of active members (${active}).`, 'quorum');
        a.quorum = b.quorum;
      }
      if (b.display_name !== undefined) a.display_name = b.display_name;
      if (b.status !== undefined) {
        if (b.status !== 'active' && b.status !== 'disabled') throw bad('status is active or disabled.', 'status');
        a.status = b.status;
      }
      audit(e, c, 'pca.approver_updated', 'pca_approver', a.id, {});
      return { body: approverView(a) };
    } },
    { method: 'PATCH', pattern: '/v1/pca/approvers/:id/members/:memberId', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const a = one(e, c.params.id);
      const m = a.members.find((x: Obj) => x.id === c.params.memberId);
      if (!m) throw notFound('Member');
      const b = c.body;
      const unknown = Object.keys(b).find((k) => !MEMBER_FIELDS.includes(k));
      if (unknown) throw bad(`Unrecognised field ${unknown}. Expected any of ${MEMBER_FIELDS.join(', ')}.`, unknown);
      if (b.channels !== undefined) m.channels = channelList(b.channels);
      for (const k of ['email', 'phone', 'display_name']) if (b[k] !== undefined) m[k] = b[k];
      if (b.status !== undefined) {
        if (b.status !== 'active' && b.status !== 'disabled') throw bad('status is active or disabled.', 'status');
        m.status = b.status;
        const active = a.members.filter((x: Obj) => x.status === 'active').length;
        if (a.quorum > Math.max(active, 1)) a.quorum = Math.max(active, 1);
      }
      audit(e, c, 'pca.approver_member_updated', 'pca_approver', a.id, { member_id: m.id });
      return { body: approverView(a) };
    } },
    { method: 'DELETE', pattern: '/v1/pca/approvers/:id/credentials/:credentialId', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const a = one(e, c.params.id);
      const cred = a.credentials.find((x: Obj) => x.id === c.params.credentialId);
      if (!cred) throw notFound('Credential');
      if (cred.status !== 'revoked') Object.assign(cred, { status: 'revoked', revoked_at: e.clock.now() });
      audit(e, c, 'pca.approver_credential_revoked', 'pca_approver', a.id, { credential_id: cred.id });
      return { body: approverView(a) };
    } },
    { method: 'GET', pattern: '/v1/pca/approvals/settings', scope: READ, handler: (c) => ({ body: settingsView(st(c.engine).settings) }) },
    { method: 'PUT', pattern: '/v1/pca/approvals/settings', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const s = st(e).settings;
      const b = c.body;
      const next: Obj = { ...s };
      if (b.channels !== undefined) {
        const ch = objArg(b.channels, 'channels');
        for (const [k, v] of Object.entries(ch)) if (!(k in s.channels) || typeof v !== 'boolean') throw bad('channels are push, email, sms, slack and webhook, each true or false.', 'channels');
        next.channels = { ...s.channels, ...ch };
      }
      if (b.default_member_channels !== undefined) next.default_member_channels = channelList(b.default_member_channels, 'default_member_channels');
      if (b.ciba !== undefined) next.ciba = b.ciba === null ? null : { ...objArg(b.ciba, 'ciba') };
      if (b.slack_webhook_url !== undefined) {
        if (b.slack_webhook_url !== null && !/^https:\/\/hooks\.slack\.com\//.test(String(b.slack_webhook_url))) throw bad('slack_webhook_url is a hooks.slack.com incoming-webhook URL.', 'slack_webhook_url');
        next.slack_webhook_set = b.slack_webhook_url !== null;
      }
      if (b.ciba_client_secret !== undefined) next.ciba_client_secret_set = b.ciba_client_secret !== null;
      if (next.channels.slack && !next.slack_webhook_set) throw bad('The slack channel needs a slack_webhook_url.', 'channels');
      Object.assign(s, next);
      audit(e, c, 'pca.approval_settings_updated', 'pca_approval_settings', e.instanceId, {});
      return { body: settingsView(s) };
    } },
  ];
}

// ── the hosted action registry ──

const NS_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const KINDS = ['openapi', 'mcp', 'graphql', 'grpc', 'asyncapi', 'jsonschema'];
const SCHEDULES = ['off', 'hourly', 'daily'];
const nsOfVerb = (verb: string): string => verb.split('.')[0]!;
const cmpVer = (a: string, b: string): number => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
};

/** The definitions a source document yields. shortcut: openapi, mcp (a tools/list result) and jsonschema; the other kinds are refused. */
function definitionsOf(kind: string, text: string, ns: string, verb?: string): { defs: Obj[]; todo: Obj[] } {
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    throw bad('The source is not JSON (the emulator reads JSON documents).', 'source');
  }
  const defs: Obj[] = [];
  const todo: Obj[] = [];
  const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'op';
  if (kind === 'openapi') {
    if (!isObj(doc.paths)) throw bad('An OpenAPI document has paths.', 'source');
    for (const [path, item] of Object.entries<any>(doc.paths)) {
      for (const [method, op] of Object.entries<any>(item ?? {})) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method) || !isObj(op)) continue;
        const name = slug(op.operationId ?? `${method}_${path}`);
        defs.push({ verb: `${ns}.${name}`, ns, title: op.summary ?? op.operationId ?? `${method.toUpperCase()} ${path}`, description: op.description ?? null, effects: method === 'get' ? ['read'] : method === 'delete' ? ['delete'] : ['write'], params: Object.fromEntries((op.parameters ?? []).filter((p: any) => p?.name).map((p: any) => [p.name, p.schema ?? {}])), reversibility: { class: method === 'get' ? 'none' : 'unknown' }, compensates: null, traits: [] });
        if (!op.operationId) todo.push({ where: `${method.toUpperCase()} ${path}`, code: 'no_operation_id', message: 'No operationId: the verb was derived from the method and path.' });
      }
    }
  } else if (kind === 'mcp') {
    const tools = Array.isArray(doc) ? doc : doc.tools ?? doc.result?.tools;
    if (!Array.isArray(tools)) throw bad('An MCP source is a tools/list result: { tools: [...] }.', 'source');
    for (const t of tools) if (typeof t?.name === 'string') defs.push({ verb: `${ns}.${slug(t.name)}`, ns, title: t.title ?? t.name, description: t.description ?? null, effects: t.annotations?.readOnlyHint ? ['read'] : ['write'], params: t.inputSchema?.properties ?? {}, reversibility: { class: 'unknown' }, compensates: null, traits: [] });
  } else if (kind === 'jsonschema') {
    if (!verb) throw bad('jsonschema needs verb.', 'verb');
    defs.push({ verb: verb.includes('.') ? verb : `${ns}.${slug(verb)}`, ns, title: doc.title ?? verb, description: doc.description ?? null, effects: ['write'], params: doc.properties ?? {}, reversibility: { class: 'unknown' }, compensates: null, traits: [] });
  } else throw bad(`The emulator reads ${['openapi', 'mcp', 'jsonschema'].join(', ')} sources; ${kind} is not available here.`, 'from');
  if (defs.length === 0) throw bad('The source holds no operations.', 'source');
  return { defs, todo };
}

const defDigest = (d: Obj): Promise<string> => hex(canonical({ verb: d.verb, title: d.title, effects: d.effects, params: d.params, reversibility: d.reversibility, traits: d.traits }));
/** How a definition moved: narrower, wider (more effects or traits), or incomparable. */
function diffDef(old: Obj | undefined, next: Obj): { class: string; reasons: string[] } {
  if (!old) return { class: 'added', reasons: [] };
  if (canonical(old) === canonical(next)) return { class: 'equal', reasons: [] };
  const sub = (a: string[], b: string[]): boolean => a.every((x) => b.includes(x));
  const eo = old.effects ?? [];
  const en = next.effects ?? [];
  const to = old.traits ?? [];
  const tn = next.traits ?? [];
  const wideEff = !sub(en, eo);
  const wideTr = !sub(tn, to);
  if (wideEff || wideTr) return { class: sub(eo, en) ? 'widen' : 'incomparable', reasons: [...(wideEff ? [`effects ${eo.join(',')} -> ${en.join(',')}`] : []), ...(wideTr ? ['traits added'] : [])] };
  return { class: sub(en, eo) && sub(tn, to) ? 'narrow' : 'incomparable', reasons: ['definition changed'] };
}

function registryRoutes(): RouteDef[] {
  const SK = '/v1/pca/action-registry';
  const ns = (v: unknown): string => {
    if (typeof v !== 'string' || !NS_RE.test(v)) throw bad('ns is a lowercase namespace (letters, digits, _; at most 32).', 'ns');
    return v;
  };
  const head = (e: Engine, n: string): Obj | undefined => st(e).registry.get(n);
  const activeVersion = (r: Obj): Obj | undefined => r.versions.find((v: Obj) => v.version === r.active_version);
  const headView = (r: Obj, changes: Obj[] = []): Obj => ({ object: 'pca_action_head', ns: r.ns, active_version: r.active_version, pinned: r.pinned, changes });
  const verSummary = (v: Obj): Obj => ({ version: v.version, digest: v.digest, prev: v.prev, status: v.status, published_by: v.published_by, created_at: iso(v.created_at), changes: v.changes });
  const draftView = (d: Obj): Obj => ({ verb: d.verb, ns: d.ns, origin: d.origin, change: d.change ?? null, source_id: d.source_id ?? null, def: d.def, def_digest: d.def_digest ?? null, state: d.state, review: d.review ?? {}, card_text: `${d.def.title}: ${(d.def.effects ?? []).join(', ') || 'no effects declared'}.`, lint: [], rules: d.rules ?? null, rules_text: [], rules_lint: [], rules_review: null, rules_review_needed: false, registry_traits: [], diff_vs_active: d.diff ?? { class: 'added', reasons: [] }, rules_diff_vs_active: { class: 'equal', reasons: [] }, updated_by: d.updated_by ?? null, updated_at: iso(d.updated_at) });
  const activeDef = (e: Engine, verb: string): Obj | undefined => {
    const r = head(e, nsOfVerb(verb));
    return r ? activeVersion(r)?.pack.actions.find((a: Obj) => a.verb === verb) : undefined;
  };
  const draftFor = async (e: Engine, c: RouteContext | null, def: Obj, origin: string, extra: Obj = {}): Promise<Obj> => {
    const old = activeDef(e, def.verb);
    const d = { verb: def.verb, ns: def.ns, origin, def, def_digest: await defDigest(def), state: origin === 'template' || origin === 'import' || origin === 'sync' ? 'unreviewed' : 'authored', diff: diffDef(old, def), updated_by: c ? (c.key ? `apikey_${c.key.key.slice(-8)}` : null) : null, updated_at: e.clock.now(), ...extra };
    st(e).drafts.set(def.verb, d);
    return d;
  };
  const reviewerKids = (e: Engine): string[] => st(e).reviewers.filter((r) => r.status === 'active').map((r) => r.kid);
  const publish = async (e: Engine, c: RouteContext, n: string, actions: Obj[], deprecated: string[], by: string, opts: { pack?: Obj; rules?: Obj; traits?: Obj; reviewerKid?: string } = {}): Promise<Obj> => {
    let r = head(e, n);
    const base: Obj[] = r ? [...(activeVersion(r)?.pack.actions ?? [])] : [];
    const merged = new Map(base.map((a) => [a.verb, a]));
    const changes: Obj[] = [];
    for (const a of actions) {
      const d = diffDef(merged.get(a.verb), a);
      if (d.class === 'equal') continue;
      changes.push({ verb: a.verb, class: d.class, reasons: d.reasons, rules: { class: 'equal', reasons: [] }, reviewed: a.state === 'confirmed' });
      merged.set(a.verb, a);
    }
    for (const v of deprecated) if (merged.has(v)) (merged.set(v, { ...merged.get(v), deprecated: true }), changes.push({ verb: v, class: 'deprecated', reasons: [], reviewed: false }));
    const widening = changes.filter((x) => (x.class === 'widen' || x.class === 'incomparable') && !x.reviewed);
    if (widening.length && !(opts.reviewerKid && reviewerKids(e).includes(opts.reviewerKid))) {
      throw new EmulatorError('CONFLICT', 'Publishing would widen actions that no reviewer confirmed.', undefined, { meta: { reason_code: 'widen_unreviewed', verbs: widening.map((x) => x.verb) } });
    }
    if (changes.length === 0 && r) throw conflict('Nothing changed since the active version.');
    const last = r ? [...r.versions].sort((a: Obj, b: Obj) => cmpVer(b.version, a.version))[0]!.version : null;
    let version = typeof opts.pack?.version === 'string' ? opts.pack.version : last ? last.replace(/\d+$/, (m: string) => String(Number(m) + 1)) : '1.0.0';
    if (!SEMVER.test(version)) throw bad('pack.version is MAJOR.MINOR.PATCH.', 'pack');
    if (last && cmpVer(version, last) <= 0) throw conflict(`Version ${version} is not newer than ${last}.`);
    if (!r) st(e).registry.set(n, (r = { ns: n, versions: [], active_version: version, pinned: false, updated_at: e.clock.now() }));
    const pack = { ns: n, version, actions: [...merged.values()] };
    const row = { version, digest: await hex(canonical(pack)), prev: last, status: r.pinned ? 'staged' : 'active', published_by: by, created_at: e.clock.now(), changes, pack, rules: opts.rules ?? {}, traits: opts.traits ?? {}, deprecated: [...merged.values()].filter((a) => a.deprecated).map((a) => a.verb) };
    r.versions.push(row);
    if (!r.pinned) r.active_version = version;
    r.updated_at = e.clock.now();
    audit(e, c, 'pca.actions_published', 'pca_action_namespace', n, { version });
    e.webhooks.emit('pca.actions_published', { object: 'pca_action_version', ns: n, version, digest: row.digest });
    return { object: 'pca_action_version', ns: n, version, digest: row.digest, prev: last, status: row.status, changes, published_drafts: 0 };
  };
  const stateOf = (a: Obj): string => (a.deprecated ? 'deprecated' : a.state === 'confirmed' ? 'confirmed' : 'unconfirmed');
  const sourceView = (s: Obj): Obj => ({ object: 'pca_action_source', id: s.id, ns: s.ns, kind: s.kind, uri: s.uri, verb: s.verb ?? null, schedule: s.schedule, last_synced_at: s.last_synced_at ? iso(s.last_synced_at) : null, next_run_at: s.schedule === 'off' ? null : iso((s.last_synced_at ?? s.created_at) + (s.schedule === 'hourly' ? 3_600_000 : 86_400_000)), last_status: s.last_status ?? null, last_error: s.last_error ?? null, failures: s.failures ?? 0, operations: s.operations ?? 0, created_at: iso(s.created_at) });
  const reviewerView = (r: Obj): Obj => ({ object: 'pca_action_reviewer', id: r.id, kid: r.kid ?? null, pk: r.pk ?? null, display_name: r.display_name ?? null, email: r.email ?? null, user_id: r.user_id ?? null, status: r.status, created_at: iso(r.created_at), credentials: (r.credentials ?? []).map((x: Obj) => ({ id: x.id, name: x.name ?? null, transports: [], status: 'active', created_at: iso(x.created_at), last_used_at: null })) });
  const load = async (e: Engine, kind: string, uri: string): Promise<string> => {
    const res = await (e.options.fetch ?? fetch)(uri, { headers: { accept: 'application/json' } });
    if (!res.ok) throw bad(`The source answered ${res.status}.`, 'url');
    return res.text();
  };
  const sourceText = async (e: Engine, b: Obj, kind: string): Promise<string> => {
    if (typeof b.source === 'string') return b.source;
    if (typeof b.url !== 'string' || !b.url.startsWith('https://')) throw bad('Send an https url or the document text in source.', 'url');
    return load(e, kind, b.url);
  };
  const TEMPLATES = [
    { id: 'ecommerce', title: 'E-commerce', description: 'Orders, refunds and inventory.', ns: 'shop', actions: [{ verb: 'shop.refund_order', title: 'Refund an order', effects: ['write', 'money'], params: { order_id: {}, amount: {} }, reversibility: { class: 'irreversible' }, traits: ['money'] }, { verb: 'shop.get_order', title: 'Read an order', effects: ['read'], params: { order_id: {} }, reversibility: { class: 'none' }, traits: [] }] },
    { id: 'fintech', title: 'Fintech', description: 'Transfers and statements.', ns: 'bank', actions: [{ verb: 'bank.transfer', title: 'Transfer funds', effects: ['write', 'money'], params: { to: {}, amount: {} }, reversibility: { class: 'irreversible' }, traits: ['money'] }] },
    { id: 'healthcare', title: 'Healthcare', description: 'Records and appointments.', ns: 'care', actions: [{ verb: 'care.read_record', title: 'Read a patient record', effects: ['read'], params: { patient_id: {} }, reversibility: { class: 'none' }, traits: ['pii'] }] },
    { id: 'saas_admin', title: 'SaaS admin', description: 'Users and plans.', ns: 'admin', actions: [{ verb: 'admin.suspend_user', title: 'Suspend a user', effects: ['write'], params: { user_id: {} }, reversibility: { class: 'reversible' }, traits: [] }] },
    { id: 'developer_tools', title: 'Developer tools', description: 'Repositories and deploys.', ns: 'dev', actions: [{ verb: 'dev.deploy', title: 'Deploy a service', effects: ['write'], params: { service: {}, ref: {} }, reversibility: { class: 'reversible' }, traits: [] }] },
  ];

  return [
    { method: 'GET', pattern: SK, scope: READ, handler: (c) => {
      const e = c.engine;
      const regs = [...st(e).registry.values()];
      return { body: { object: 'pca_action_registry', registry_mode: regs.length > 0, namespaces: regs.map((r) => { const v = activeVersion(r); return { ns: r.ns, active_version: r.active_version, digest: v?.digest, pinned: r.pinned, updated_at: iso(r.updated_at), counts: { actions: v?.pack.actions.length ?? 0, confirmed: v?.pack.actions.filter((a: Obj) => a.state === 'confirmed').length ?? 0 } }; }), publisher_keys: [...st(e).publisherKeys.values()], reviewer_keys: st(e).reviewers.filter((r) => r.status === 'active').map((r) => ({ kid: r.kid, pk: r.pk, reviewer_id: r.id, display_name: r.display_name ?? null })) } };
    } },
    { method: 'POST', pattern: `${SK}/publisher-keys`, scope: WRITE, handler: (c) => {
      const e = c.engine;
      const kid = str(c.body.kid, 'kid', 128);
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(kid) || kid.startsWith('rv_')) throw bad('kid is letters, digits and . _ : - and never starts with rv_.', 'kid');
      const pk = sig(c.body.pk, 'pk');
      if (st(e).publisherKeys.has(kid) || [...st(e).publisherKeys.values()].some((k) => k.pk === pk) || st(e).reviewers.find((r) => r.pk === pk)) throw conflict('That key is already pinned.');
      const row = { object: 'pca_action_publisher_key', kid, pk, display_name: c.body.display_name ?? null, created_at: iso(e.clock.now()) };
      st(e).publisherKeys.set(kid, row);
      audit(e, c, 'pca.publisher_key_pinned', 'pca_publisher_key', kid, {});
      return { status: 201, body: row };
    } },
    { method: 'DELETE', pattern: `${SK}/publisher-keys/:kid`, scope: WRITE, handler: (c) => {
      if (!st(c.engine).publisherKeys.delete(c.params.kid!)) throw notFound('Publisher key');
      audit(c.engine, c, 'pca.publisher_key_revoked', 'pca_publisher_key', c.params.kid!, {});
      return { status: 204 };
    } },
    { method: 'POST', pattern: `${SK}/packs`, scope: WRITE, handler: async (c) => {
      const e = c.engine;
      const pack = objArg(c.body.pack, 'pack');
      const n = ns(pack.ns);
      if (!Array.isArray(pack.actions) || pack.actions.length === 0) throw bad('pack.actions lists the definitions.', 'pack');
      for (const a of pack.actions) if (!isObj(a) || typeof a.verb !== 'string' || nsOfVerb(a.verb) !== n) throw bad(`Every action verb starts with "${n}.".`, 'pack');
      sig(pack.sig, 'pack.sig');
      if (!st(e).publisherKeys.has(String(pack.kid ?? ''))) throw new EmulatorError('FORBIDDEN', 'pack.kid is not a pinned publisher key.', 'pack');
      const actions = pack.actions.map((a: Obj) => ({ ...a, ns: n, state: 'unconfirmed' }));
      const res = await publish(e, c, n, actions, [], 'secret_key', { pack, rules: isObj(c.body.rules) ? c.body.rules : {}, traits: isObj(c.body.traits) ? c.body.traits : {}, reviewerKid: typeof pack.reviewer_kid === 'string' ? pack.reviewer_kid : undefined });
      return { status: 201, body: res };
    } },
    { method: 'GET', pattern: `${SK}/namespaces/:ns/versions`, scope: READ, handler: (c) => {
      const r = head(c.engine, c.params.ns!);
      if (!r) throw notFound('Namespace');
      return { body: { data: [...r.versions].sort((a: Obj, b: Obj) => cmpVer(b.version, a.version)).map(verSummary) } };
    } },
    { method: 'GET', pattern: `${SK}/namespaces/:ns/versions/:version`, scope: READ, handler: (c) => {
      const v = head(c.engine, c.params.ns!)?.versions.find((x: Obj) => x.version === c.params.version);
      if (!v) throw notFound('Version');
      return { body: { object: 'pca_action_version', ns: c.params.ns, ...verSummary(v), pack: v.pack, rules: v.rules, traits: v.traits, deprecated: v.deprecated } };
    } },
    { method: 'GET', pattern: `${SK}/namespaces/:ns/diff`, scope: READ, handler: (c) => {
      const r = head(c.engine, c.params.ns!);
      if (!r) throw notFound('Namespace');
      const from = c.query.get('from');
      const to = c.query.get('to');
      if (!from || !SEMVER.test(from) || !to || !SEMVER.test(to)) throw bad('from and to are MAJOR.MINOR.PATCH versions.', 'from');
      const a = r.versions.find((x: Obj) => x.version === from);
      const b = r.versions.find((x: Obj) => x.version === to);
      if (!a || !b) throw notFound('Version');
      const verbs = new Set<string>([...a.pack.actions.map((x: Obj) => x.verb), ...b.pack.actions.map((x: Obj) => x.verb)]);
      const changes: Obj[] = [];
      for (const v of verbs) {
        const o = a.pack.actions.find((x: Obj) => x.verb === v);
        const n = b.pack.actions.find((x: Obj) => x.verb === v);
        const d = n ? diffDef(o, n) : { class: 'removed', reasons: [] };
        if (d.class !== 'equal') changes.push({ verb: v, class: d.class, reasons: d.reasons, rules: { class: 'equal', reasons: [] }, reviewed: n?.state === 'confirmed' });
      }
      const unreviewed = changes.filter((x) => (x.class === 'widen' || x.class === 'incomparable') && !x.reviewed);
      return { body: { ok: unreviewed.length === 0, from, to, ...(unreviewed.length ? { code: 'widen_unreviewed', message: 'These actions widen and no reviewer confirmed them.', verbs: unreviewed.map((x) => x.verb) } : {}), changes } };
    } },
    { method: 'PUT', pattern: `${SK}/namespaces/:ns/pin`, scope: WRITE, handler: (c) => {
      const e = c.engine;
      const r = head(e, c.params.ns!);
      if (!r) throw notFound('Namespace');
      const version = c.body.version;
      if (typeof version !== 'string' || !SEMVER.test(version)) throw bad('version is MAJOR.MINOR.PATCH.', 'version');
      const v = r.versions.find((x: Obj) => x.version === version);
      if (!v) throw notFound('Version');
      for (const x of r.versions) x.status = x.version === version ? 'active' : 'staged';
      Object.assign(r, { active_version: version, pinned: true, updated_at: e.clock.now() });
      audit(e, c, 'pca.namespace_pinned', 'pca_action_namespace', r.ns, { version });
      return { body: headView(r, v.changes) };
    } },
    { method: 'DELETE', pattern: `${SK}/namespaces/:ns/pin`, scope: WRITE, handler: (c) => {
      const r = head(c.engine, c.params.ns!);
      if (!r) throw notFound('Namespace');
      r.pinned = false;
      audit(c.engine, c, 'pca.namespace_unpinned', 'pca_action_namespace', r.ns, {});
      return { body: headView(r) };
    } },
    { method: 'GET', pattern: `${SK}/actions`, scope: READ, handler: (c) => {
      const e = c.engine;
      const q = c.query.get('q')?.toLowerCase();
      const state = c.query.get('state');
      const only = c.query.get('ns');
      if (state && !['confirmed', 'unconfirmed', 'stale', 'deprecated'].includes(state)) throw bad('state is confirmed, unconfirmed, stale or deprecated.', 'state');
      const limit = Math.min(200, Math.max(1, Number(c.query.get('limit') ?? 50) || 50));
      const rows: Obj[] = [];
      for (const r of st(e).registry.values()) {
        if (only && r.ns !== only) continue;
        const v = activeVersion(r);
        for (const a of v?.pack.actions ?? []) {
          if (state && stateOf(a) !== state) continue;
          if (q && ![a.verb, a.title, a.description, ...(a.aliases ?? [])].filter(Boolean).join(' ').toLowerCase().includes(q)) continue;
          rows.push({ verb: a.verb, ns: r.ns, version: r.active_version, title: a.title, state: stateOf(a), traits: a.traits ?? [], risk: (a.effects ?? []).length });
        }
      }
      return { body: { data: rows.slice(0, limit) } };
    } },
    { method: 'GET', pattern: `${SK}/actions/:verb`, scope: READ, handler: async (c) => {
      const e = c.engine;
      const verb = c.params.verb!;
      const a = activeDef(e, verb);
      if (!a) throw notFound('Action');
      const r = head(e, nsOfVerb(verb))!;
      const history = r.versions.filter((v: Obj) => v.changes.some((x: Obj) => x.verb === verb)).map((v: Obj) => { const ch = v.changes.find((x: Obj) => x.verb === verb); return { version: v.version, class: ch.class, reasons: ch.reasons, rules: { class: 'equal', reasons: [] } }; });
      return { body: { object: 'pca_action', verb, ns: r.ns, version: r.active_version, state: stateOf(a), def: a, def_digest: await defDigest(a), card: { text: `${a.title}: ${(a.effects ?? []).join(', ')}.`, lines: [] }, effective: { traits: a.traits ?? [], hint: null }, rules: null, rules_text: [], compiled_rules: null, history } };
    } },
    { method: 'POST', pattern: `${SK}/actions/:verb/review`, scope: WRITE, handler: async (c) => {
      const e = c.engine;
      const verb = c.params.verb!;
      const a = activeDef(e, verb);
      if (!a) throw notFound('Action');
      if (st(e).drafts.has(verb)) throw conflict('A draft of this action is already in the review queue.');
      const d = await draftFor(e, c, { ...a, state: undefined, deprecated: undefined }, 'edit');
      audit(e, c, 'pca.action_review_opened', 'pca_action', verb, {});
      return { body: draftView(d) };
    } },
    { method: 'POST', pattern: `${SK}/imports`, scope: WRITE, handler: async (c) => {
      const e = c.engine;
      const b = c.body;
      const n = ns(b.ns);
      if (typeof b.from !== 'string' || !KINDS.includes(b.from)) throw bad(`from is one of ${KINDS.join(', ')}.`, 'from');
      if (b.schedule !== undefined && !SCHEDULES.includes(b.schedule)) throw bad(`schedule is one of ${SCHEDULES.join(', ')}.`, 'schedule');
      const text = await sourceText(e, b, b.from);
      const { defs, todo } = definitionsOf(b.from, text, n, b.verb);
      const verbs: string[] = [];
      for (const def of defs) {
        const old = activeDef(e, def.verb);
        if (old && canonical({ ...old, state: undefined }) === canonical({ ...def, state: undefined })) continue; // equal to the current definition
        await draftFor(e, c, def, 'import');
        verbs.push(def.verb);
      }
      let source_id: string | undefined;
      if (b.track === true) {
        if (typeof b.url !== 'string') throw bad('track needs the url to keep.', 'track');
        source_id = st(e).sources.insert({ ns: n, kind: b.from, uri: b.url, verb: b.verb ?? null, schedule: b.schedule ?? 'off', last_synced_at: e.clock.now(), last_status: 'ok', failures: 0, operations: defs.length, created_at: e.clock.now(), digests: Object.fromEntries(await Promise.all(defs.map(async (d) => [d.verb, await defDigest(d)]))) } as any).id;
      }
      audit(e, c, 'pca.actions_imported', 'pca_action_namespace', n, { imported: verbs.length });
      return { status: 201, body: { object: 'pca_action_import', imported: verbs.length, verbs, todo, ...(source_id ? { source_id } : {}) } };
    } },
    { method: 'GET', pattern: `${SK}/drafts`, scope: READ, handler: (c) => {
      const only = c.query.get('ns');
      const rank = (d: Obj): number => ({ unreviewed: 0, suggested: 1, authored: 2, stale: 3, confirmed: 4 } as Record<string, number>)[d.state] ?? 5;
      const rows = [...st(c.engine).drafts.values()].filter((d) => !only || d.ns === only).sort((a, b) => rank(a) - rank(b) || (a.verb < b.verb ? -1 : 1));
      return { body: { object: 'list', data: rows.map(draftView) } };
    } },
    { method: 'GET', pattern: `${SK}/drafts/:verb`, scope: READ, handler: (c) => {
      const d = st(c.engine).drafts.get(c.params.verb!);
      if (!d) throw notFound('Draft');
      return { body: draftView(d) };
    } },
    { method: 'PATCH', pattern: `${SK}/drafts/:verb`, scope: WRITE, handler: async (c) => {
      const e = c.engine;
      const d = st(e).drafts.get(c.params.verb!);
      if (!d) throw notFound('Draft');
      const FIELDS = ['title', 'description', 'effects', 'params', 'reversibility', 'compensates', 'traits', 'rules'];
      const unknown = Object.keys(c.body).find((k) => !FIELDS.includes(k));
      if (unknown) throw bad(`Unrecognised field ${unknown}. Expected any of ${FIELDS.join(', ')}.`, unknown);
      for (const k of ['effects', 'traits']) if (c.body[k] !== undefined && (!Array.isArray(c.body[k]) || c.body[k].some((x: unknown) => typeof x !== 'string'))) throw bad(`${k} is a list of strings.`, k);
      if (c.body.params !== undefined) objArg(c.body.params, 'params');
      const { rules, ...rest } = c.body;
      d.def = { ...d.def, ...rest };
      if (rules !== undefined) d.rules = rules;
      // Any edit drops a confirmation: the definition is unreviewed again.
      Object.assign(d, { def_digest: await defDigest(d.def), diff: diffDef(activeDef(e, d.verb), d.def), state: 'authored', updated_at: e.clock.now(), updated_by: `apikey_${c.key?.key.slice(-8) ?? ''}` });
      audit(e, c, 'pca.action_draft_edited', 'pca_action_draft', d.verb, {});
      return { body: draftView(d) };
    } },
    { method: 'DELETE', pattern: `${SK}/drafts/:verb`, scope: WRITE, handler: (c) => {
      if (!st(c.engine).drafts.delete(c.params.verb!)) throw notFound('Draft');
      audit(c.engine, c, 'pca.action_draft_removed', 'pca_action_draft', c.params.verb!, {});
      return { body: { object: 'pca_action_draft', verb: c.params.verb, deleted: true } };
    } },
    { method: 'POST', pattern: `${SK}/drafts/:verb/confirm`, scope: WRITE, handler: async (c) => {
      const e = c.engine;
      const d = st(e).drafts.get(c.params.verb!);
      if (!d) throw notFound('Draft');
      const a = objArg(c.body.attestation, 'attestation');
      const asr = objArg(c.body.assertion, 'assertion');
      for (const k of ['def_digest', 'traits_digest', 'facts_digest', 'reviewer_kid']) str(a[k], `attestation.${k}`);
      if (!Array.isArray(a.final_traits) || !Array.isArray(a.dismissed)) throw bad('attestation needs final_traits and dismissed.', 'attestation');
      sig(a.sig, 'attestation.sig');
      for (const k of ['credential_id', 'authenticatorData', 'clientDataJSON', 'signature']) sig(asr[k], `assertion.${k}`);
      const now = Math.floor(e.clock.now() / 1000);
      if (!Number.isInteger(a.ts) || a.ts < now - 600 || a.ts > now + 120) throw bad('attestation.ts is at most 10 minutes old and 2 minutes ahead.', 'attestation');
      if (a.def_digest !== d.def_digest) throw conflict('The attestation is over a different definition: the draft changed since the reviewer saw it.');
      const reviewer = st(e).reviewers.find((r) => r.kid === a.reviewer_kid && r.status === 'active');
      if (!reviewer || !(reviewer.credentials ?? []).some((x: Obj) => x.id === asr.credential_id)) throw new EmulatorError('FORBIDDEN', 'The assertion is not from an active passkey of an active reviewer.', 'assertion');
      Object.assign(d, { state: 'confirmed', updated_at: e.clock.now(), def: { ...d.def, traits: a.final_traits, state: 'confirmed' }, confirmed_by: reviewer.id });
      audit(e, c, 'pca.action_draft_confirmed', 'pca_action_draft', d.verb, { reviewer_kid: a.reviewer_kid });
      return { body: draftView(d) };
    } },
    { method: 'POST', pattern: `${SK}/publish`, scope: WRITE, handler: async (c) => {
      const e = c.engine;
      const n = ns(c.body.ns);
      const drafts = [...st(e).drafts.values()].filter((d) => d.ns === n);
      if (drafts.length === 0) throw conflict('That namespace has no drafts to publish.');
      const actions = drafts.filter((d) => d.change !== 'removed').map((d) => ({ ...d.def, state: d.state === 'confirmed' ? 'confirmed' : 'unconfirmed' }));
      const res = await publish(e, c, n, actions, drafts.filter((d) => d.change === 'removed').map((d) => d.verb), 'secret_key');
      for (const d of drafts) st(e).drafts.delete(d.verb);
      return { body: { ...res, published_drafts: drafts.length } };
    } },
    { method: 'POST', pattern: `${SK}/reviewers/enrolments`, scope: WRITE, handler: (c) => {
      const e = c.engine;
      const b = c.body;
      if (b.user_id !== undefined && !e.db.users.get(String(b.user_id))) throw bad('No such user.', 'user_id');
      if (b.email !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email))) throw bad('email is an address.', 'email');
      const rv = st(e).reviewers.insert({ display_name: b.display_name ?? null, email: b.email ?? null, user_id: b.user_id ?? null, status: 'pending', created_at: e.clock.now(), credentials: [] } as any);
      const en = st(e).reviewerEnrolments.insert({ reviewer_id: rv.id, expires_at: e.clock.now() + 86_400_000 } as any);
      audit(e, c, 'pca.reviewer_enrolment_created', 'pca_action_reviewer', rv.id, {});
      return { status: 201, body: { object: 'pca_action_reviewer_enrolment', id: en.id, enrolment_url: `${e.issuer}/pca/action-reviewers/enrol?token=${randomToken(24)}`, expires_at: iso(en.expires_at), reviewer_id: rv.id } };
    } },
    // Emulator control: the reviewer creates a passkey and a reviewer key on the hosted page.
    { method: 'POST', pattern: '/__emulator/pca/reviewers/:id/activate', public: true, handler: (c) => {
      const e = c.engine;
      const rv = st(e).reviewers.get(c.params.id);
      if (!rv) throw notFound('Reviewer');
      const pk = randomToken(32);
      Object.assign(rv, { status: 'active', kid: `rv_${rv.id}`, pk });
      rv.credentials.push({ id: randomToken(16), name: c.body.name ?? null, created_at: e.clock.now() });
      return { body: reviewerView(rv) };
    } },
    { method: 'GET', pattern: `${SK}/reviewers`, scope: READ, handler: (c) => ({ body: { object: 'list', data: st(c.engine).reviewers.all().map(reviewerView) } }) },
    { method: 'DELETE', pattern: `${SK}/reviewers/:id`, scope: WRITE, handler: (c) => {
      const rv = st(c.engine).reviewers.get(c.params.id);
      if (!rv) throw notFound('Reviewer');
      rv.status = 'disabled';
      rv.credentials = [];
      audit(c.engine, c, 'pca.reviewer_removed', 'pca_action_reviewer', rv.id, {});
      return { body: reviewerView(rv) };
    } },
    { method: 'GET', pattern: `${SK}/sources`, scope: READ, handler: (c) => ({ body: { object: 'list', data: st(c.engine).sources.all().map(sourceView) } }) },
    { method: 'POST', pattern: `${SK}/sources`, scope: WRITE, handler: (c) => {
      const e = c.engine;
      const b = c.body;
      const n = ns(b.ns);
      if (typeof b.from !== 'string' || !KINDS.includes(b.from)) throw bad(`from is one of ${KINDS.join(', ')}.`, 'from');
      if (typeof b.url !== 'string' || !b.url.startsWith('https://')) throw bad('url is an https URL.', 'url');
      if (b.schedule !== undefined && !SCHEDULES.includes(b.schedule)) throw bad(`schedule is one of ${SCHEDULES.join(', ')}.`, 'schedule');
      const row = st(e).sources.insert({ ns: n, kind: b.from, uri: b.url, verb: b.verb ?? null, schedule: b.schedule ?? 'off', last_synced_at: null, last_status: null, failures: 0, operations: 0, created_at: e.clock.now(), digests: {} } as any);
      audit(e, c, 'pca.action_source_added', 'pca_action_source', row.id, {});
      return { status: 201, body: sourceView(row) };
    } },
    { method: 'PATCH', pattern: `${SK}/sources/:id`, scope: WRITE, handler: (c) => {
      const row = st(c.engine).sources.get(c.params.id);
      if (!row) throw notFound('Source');
      const b = c.body;
      if (b.url !== undefined) {
        if (typeof b.url !== 'string' || !b.url.startsWith('https://')) throw bad('url is an https URL.', 'url');
        row.uri = b.url;
      }
      if (b.verb !== undefined) row.verb = b.verb;
      if (b.schedule !== undefined) {
        if (!SCHEDULES.includes(b.schedule)) throw bad(`schedule is one of ${SCHEDULES.join(', ')}.`, 'schedule');
        row.schedule = b.schedule;
      }
      audit(c.engine, c, 'pca.action_source_changed', 'pca_action_source', row.id, {});
      return { body: sourceView(row) };
    } },
    { method: 'DELETE', pattern: `${SK}/sources/:id`, scope: WRITE, handler: (c) => {
      if (!st(c.engine).sources.delete(c.params.id!)) throw notFound('Source');
      audit(c.engine, c, 'pca.action_source_removed', 'pca_action_source', c.params.id!, {});
      return { body: { object: 'pca_action_source', id: c.params.id, deleted: true } };
    } },
    { method: 'POST', pattern: `${SK}/sources/:id/sync`, scope: WRITE, handler: async (c) => {
      const e = c.engine;
      const row = st(e).sources.get(c.params.id);
      if (!row) throw notFound('Source');
      let entries: Obj[] = [];
      const drafted: string[] = [];
      try {
        const { defs } = definitionsOf(row.kind, await load(e, row.kind, row.uri), row.ns, row.verb ?? undefined);
        const seen = new Set<string>();
        for (const def of defs) {
          seen.add(def.verb);
          const digest = await defDigest(def);
          const prev = row.digests[def.verb];
          const change = !prev ? 'added' : prev === digest ? 'unchanged' : 'changed';
          entries.push({ verb: def.verb, change, diff: diffDef(activeDef(e, def.verb), def) });
          if (change !== 'unchanged') (await draftFor(e, c, def, 'sync', { source_id: row.id, change }), drafted.push(def.verb));
          row.digests[def.verb] = digest;
        }
        for (const verb of Object.keys(row.digests)) {
          if (seen.has(verb)) continue;
          const old = activeDef(e, verb);
          entries.push({ verb, change: 'removed', diff: { class: 'removed', reasons: [] } });
          if (old) (await draftFor(e, c, old, 'sync', { source_id: row.id, change: 'removed' }), drafted.push(verb));
          delete row.digests[verb];
        }
        Object.assign(row, { last_synced_at: e.clock.now(), last_status: drafted.length ? 'changes' : 'ok', last_error: null, failures: 0, operations: defs.length });
      } catch (err) {
        Object.assign(row, { last_status: 'error', last_error: (err as Error).message, failures: (row.failures ?? 0) + 1 });
        entries = [];
      }
      return { body: { object: 'pca_action_sync', source_id: row.id, ns: row.ns, entries, needs_review: drafted.length > 0, drafted } };
    } },
    { method: 'GET', pattern: `${SK}/templates`, scope: READ, handler: () => ({ body: { object: 'list', data: TEMPLATES.map((t) => ({ id: t.id, title: t.title, description: t.description, ns: t.ns, actions: t.actions.length, traits: [...new Set(t.actions.flatMap((a) => a.traits))] })) } }) },
    { method: 'POST', pattern: `${SK}/templates/:id/apply`, scope: WRITE, handler: async (c) => {
      const e = c.engine;
      const t = TEMPLATES.find((x) => x.id === c.params.id);
      if (!t) throw notFound('Template');
      const n = c.body.ns === undefined ? t.ns : ns(c.body.ns);
      const out: Obj[] = [];
      for (const a of t.actions) out.push(draftView(await draftFor(e, c, { ...a, ns: n, verb: `${n}.${a.verb.split('.')[1]}`, description: null, compensates: null }, 'template')));
      audit(e, c, 'pca.template_applied', 'pca_action_namespace', n, { template: t.id });
      return { status: 201, body: { object: 'list', data: out } };
    } },
  ];
}

// ── Shared Signals Framework: stream management (OpenID SSF 1.0, section 8.1) ──

const SSF_PUSH = 'https://schemas.openid.net/secevent/risc/delivery-method/push';
const SSF_POLL = 'https://schemas.openid.net/secevent/risc/delivery-method/poll';
const SSF_EVENTS = ['https://schemas.openid.net/secevent/caep/event-type/session-revoked', 'https://schemas.openid.net/secevent/caep/event-type/credential-change', 'https://schemas.openid.net/secevent/caep/event-type/risk-level-change', 'https://schemas.openid.net/secevent/caep/event-type/assurance-level-change', 'https://schemas.openid.net/secevent/ssf/event-type/verification'];
const ssfState = engineState((): Map<string, Obj> => new Map());

function ssfRoutes(): RouteDef[] {
  const receiver = (c: RouteContext): string => c.key?.key ?? 'anonymous';
  const configOf = (s: Obj): Obj => ({ stream_id: s.id, iss: s.iss, aud: s.aud, events_supported: SSF_EVENTS, events_delivered: s.events_delivered, delivery: s.delivery, ...(s.description !== undefined ? { description: s.description } : {}) });
  const streamOf = (c: RouteContext, id: unknown): Obj => {
    const s = ssfState(c.engine).get(typeof id === 'string' ? id : '');
    if (!s || s.receiver !== receiver(c)) throw notFound('Stream'); // another receiver's stream is a 404
    return s;
  };
  const events = (v: unknown): string[] => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad('events_requested is a list of event type URIs.', 'events_requested');
    return v as string[];
  };
  const delivery = (v: unknown): Obj => {
    const d = objArg(v, 'delivery');
    const method = d.method ?? SSF_POLL;
    if (method === SSF_PUSH) {
      if (typeof d.endpoint_url !== 'string' || !d.endpoint_url.startsWith('https://')) throw bad('Push delivery needs an https endpoint_url.', 'delivery');
      return { method, endpoint_url: d.endpoint_url };
    }
    if (method !== SSF_POLL) throw bad(`delivery.method is ${SSF_PUSH} or ${SSF_POLL}.`, 'delivery');
    return { method };
  };
  const apply = (s: Obj, b: Obj, replace: boolean): void => {
    if (b.events_requested !== undefined || replace) {
      s.events_requested = b.events_requested === undefined ? [] : events(b.events_requested);
      s.events_delivered = s.events_requested.length ? s.events_requested.filter((x: string) => SSF_EVENTS.includes(x)) : [...SSF_EVENTS];
    }
    if (b.description !== undefined || replace) s.description = b.description;
    if (b.delivery !== undefined) {
      const d = delivery(b.delivery);
      if (d.method !== s.delivery.method) throw bad('The delivery method cannot change.', 'delivery');
      s.delivery = d.method === SSF_POLL ? s.delivery : d;
    }
  };
  const mintSet = async (e: Engine, s: Obj, events: Obj, subject?: Obj): Promise<void> => {
    const jti = e.db.newId('set');
    const jwt = await e.tokens.signClaims({ iss: s.iss, aud: s.aud, jti, events, ...(subject ? { sub_id: subject } : {}) }, 3600);
    s.queue.set(jti, jwt);
  };
  const guarded = (c: RouteContext, b: Obj): Obj => streamOf(c, b.stream_id);
  return [
    { method: 'GET', pattern: '/v1/ssf/metadata', scope: READ, handler: (c) => {
      const o = `${c.engine.issuer}/v1/ssf`;
      return { body: { issuer: c.engine.issuer, jwks_uri: `${c.engine.issuer}/.well-known/jwks.json`, delivery_methods_supported: [SSF_PUSH, SSF_POLL], configuration_endpoint: `${o}/configuration`, status_endpoint: `${o}/status`, verification_endpoint: `${o}/verification`, add_subject_endpoint: `${o}/add_subject`, remove_subject_endpoint: `${o}/remove_subject`, default_subjects: 'NONE' } };
    } },
    { method: 'POST', pattern: '/v1/ssf/configuration', scope: WRITE, handler: (c) => {
      const e = c.engine;
      if ([...ssfState(e).values()].some((s) => s.receiver === receiver(c))) throw conflict('This receiver already has a stream (one per receiver).');
      const id = e.db.newId('ssfs');
      const d = c.body.delivery === undefined ? { method: SSF_POLL } : delivery(c.body.delivery);
      const s: Obj = { id, receiver: receiver(c), iss: e.issuer, aud: `urn:atlas:ssf:receiver:${receiver(c).slice(-8)}`, delivery: d.method === SSF_POLL ? { method: SSF_POLL, endpoint_url: `${e.issuer}/v1/ssf/streams/${id}/poll` } : d, events_requested: [], events_delivered: [...SSF_EVENTS], status: 'enabled', subjects: new Map<string, boolean>(), queue: new Map<string, string>(), created_at: e.clock.now() };
      apply(s, c.body, false);
      ssfState(e).set(id, s);
      return { status: 201, body: configOf(s) };
    } },
    { method: 'GET', pattern: '/v1/ssf/configuration', scope: READ, handler: (c) => {
      const id = c.query.get('stream_id');
      if (id) return { body: configOf(streamOf(c, id)) };
      return { body: [...ssfState(c.engine).values()].filter((s) => s.receiver === receiver(c)).map(configOf) };
    } },
    { method: 'PATCH', pattern: '/v1/ssf/configuration', scope: WRITE, handler: (c) => {
      const s = guarded(c, c.body);
      for (const k of ['iss', 'aud', 'events_supported', 'events_delivered']) if (c.body[k] !== undefined && canonical(c.body[k]) !== canonical(k === 'events_supported' ? SSF_EVENTS : s[k])) throw bad(`${k} is transmitter-supplied and cannot be changed.`, k);
      apply(s, c.body, false);
      return { body: configOf(s) };
    } },
    { method: 'PUT', pattern: '/v1/ssf/configuration', scope: WRITE, handler: (c) => {
      const s = guarded(c, c.body);
      apply(s, c.body, true); // a missing receiver-supplied member is deleted
      return { body: configOf(s) };
    } },
    { method: 'DELETE', pattern: '/v1/ssf/configuration', scope: WRITE, handler: (c) => {
      const s = streamOf(c, c.query.get('stream_id'));
      ssfState(c.engine).delete(s.id);
      return { status: 204 };
    } },
    { method: 'POST', pattern: '/v1/ssf/add_subject', scope: WRITE, handler: (c) => {
      const s = guarded(c, c.body);
      s.subjects.set(canonical(objArg(c.body.subject, 'subject')), c.body.verified !== false);
      return { status: 200 };
    } },
    { method: 'POST', pattern: '/v1/ssf/remove_subject', scope: WRITE, handler: (c) => {
      const s = guarded(c, c.body);
      s.subjects.delete(canonical(objArg(c.body.subject, 'subject'))); // an unknown subject is ignored
      return { status: 204 };
    } },
    { method: 'POST', pattern: '/v1/ssf/verification', scope: WRITE, handler: async (c) => {
      const s = guarded(c, c.body);
      if (c.body.state !== undefined && typeof c.body.state !== 'string') throw bad('state is a string.', 'state');
      await mintSet(c.engine, s, { [SSF_EVENTS[4]!]: c.body.state === undefined ? {} : { state: c.body.state } });
      return { status: 204 };
    } },
    { method: 'POST', pattern: '/v1/ssf/streams/:streamId/poll', scope: WRITE, handler: (c) => {
      const s = streamOf(c, c.params.streamId);
      if (s.delivery.method !== SSF_POLL) throw bad('This stream delivers by push.', 'streamId');
      if (c.body.ack !== undefined && (!Array.isArray(c.body.ack) || c.body.ack.some((x: unknown) => typeof x !== 'string'))) throw bad('ack is a list of jti.', 'ack');
      for (const jti of c.body.ack ?? []) s.queue.delete(jti);
      for (const jti of Object.keys(c.body.setErrs ?? {})) s.queue.delete(jti); // a SET the receiver reported invalid is not offered again
      const max = Math.min(100, Math.max(0, Number.isInteger(c.body.maxEvents) ? c.body.maxEvents : 100));
      const entries = [...s.queue.entries()];
      return { body: { sets: Object.fromEntries(entries.slice(0, max)), moreAvailable: entries.length > max } };
    } },
  ];
}

export function ndbPcaHandlers(): RouteDef[] {
  return [...grantRoutes(), ...trustRoutes(), ...approverRoutes(), ...registryRoutes(), ...ssfRoutes()];
}

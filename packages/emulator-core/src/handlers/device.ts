/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext, RouteDef } from '../engine';
import { bytesToB64url, isDeviceKey, jwkThumbprint, sha256, verifyDeviceSignature } from '../crypto-util';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { randomToken } from '../store';
import { DPOP_IAT_WINDOW_S, forwardedCertThumbprint, verifyDpopProof } from '../jws';
import { delegationForMint } from './emu4-authz-trust';
import { machineRateLimitClaim, runActionTrigger } from './emu3-misc';
import { listReply, need } from './util';

const CHALLENGE_TTL_MS = 5 * 60_000;
const MACHINE_TOKEN_TTL_S = 600;
const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no look-alikes
const hashOf = async (s: string): Promise<string> => bytesToB64url(await sha256(s));

interface DeviceState {
  nonces: Map<string, { machineId: string; expiresAt: number; spent: boolean }>;
  /** token hash / normalised user code hash -> enrolment token row id */
  lookup: Map<string, string>;
  agentConfig: Obj;
}
const defaultAgentConfig = (): Obj => ({ enabled: false, allow_anonymous: false, allow_service_auth: false, allow_refresh: false, untrusted_scopes: [], trusted_scopes: [], claim_ttl_seconds: 600, auto_approve_rules: [] });
const states = new WeakMap<Engine, DeviceState>();
const st = (e: Engine): DeviceState => {
  let s = states.get(e);
  if (!s) states.set(e, (s = { nonces: new Map(), lookup: new Map(), agentConfig: defaultAgentConfig() }));
  return s;
};
export const resetDevice = (e: Engine): void => {
  states.delete(e);
  dpopStore.delete(e);
};

/** The unified `grants` claim entry (machine and agent grants share one shape). */
export const tokenGrant = (g: { type: 'machine' | 'agent'; id: string; resource: string; scopes: string[]; kind?: string | null; constraints?: Obj | null; expiresAt?: number | null }): Obj => ({
  type: g.type,
  id: g.id,
  resource: g.resource,
  scopes: [...g.scopes],
  ...(g.kind ? { kind: g.kind } : {}),
  ...(g.constraints ? { constraints: g.constraints } : {}),
  ...(g.expiresAt ? { exp: Math.floor(g.expiresAt / 1000) } : {}),
});

/** A resource server by identifier or id (the generic CRUD layer stores them), or a bare identifier when none is stored. */
export function resourceServerOf(e: Engine, ref: string): { id: string | null; identifier: string; row: Obj | null } {
  const row = e.generic.get('resource_servers')?.find((r) => r.id === ref || r.identifier === ref) ?? null;
  return row ? { id: row.id, identifier: row.identifier ?? row.id, row } : { id: null, identifier: ref, row: null };
}

const deviceView = (e: Engine, m: Obj): Obj =>
  e.shape('Machine', {
    object: 'machine',
    id: m.id,
    name: m.name,
    organization_id: m.organization_id ?? null,
    owner_user_id: m.owner_user_id ?? null,
    status: m.status,
    effective_status: m.status,
    metadata: m.metadata ?? {},
    created_at: m.created_at,
    updated_at: m.updated_at,
  });

const userCode = (): string => {
  const raw = crypto.getRandomValues(new Uint8Array(8));
  return [...raw].map((b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]).join('');
};
const normCode = (s: string): string => s.replace(/[\s-]/g, '').toUpperCase();

async function resolveEnrolment(e: Engine, presented: string): Promise<Obj> {
  const key = /^[A-Za-z]{4}[\s-]?[A-Za-z]{4}$/.test(presented.trim()) ? `code:${await hashOf(normCode(presented))}` : `tok:${await hashOf(presented.trim())}`;
  const row = e.db.enrolmentTokens.get(st(e).lookup.get(key));
  if (!row) throw new EmulatorError('ENROLMENT_TOKEN_INVALID', 'The enrolment token is not valid.');
  if (row.expires_at <= e.clock.now()) throw new EmulatorError('ENROLMENT_TOKEN_EXPIRED', 'The enrolment token has expired.');
  if (row.uses >= row.max_uses) throw new EmulatorError('ENROLMENT_TOKEN_EXHAUSTED', 'The enrolment token has no uses left.');
  return row;
}

const presentEnrolmentToken = (t: Obj): Obj => ({
  object: 'machine_enrolment_token',
  id: t.id,
  format: t.format,
  organization_id: t.organization_id ?? null,
  max_uses: t.max_uses,
  uses: t.uses,
  max_machines: t.max_machines ?? null,
  requires_approval: t.requires_approval === true,
  single_session: t.single_session === true,
  owner_user_id: t.owner_user_id ?? null,
  data: t.data ?? {},
  expires_at: t.expires_at,
  created_at: t.created_at,
});

// ── agents ─────────────────────────────────────────────────────────────

export const presentAgent = (m: Obj): Obj => ({
  object: 'agent',
  id: m.id,
  name: m.name,
  identity: m.agent?.identity ?? null,
  tier: m.agent?.tier ?? null,
  status: m.status,
  owner_user_id: m.owner_user_id ?? null,
  organization_id: m.organization_id ?? null,
  claimed_at: m.agent?.claimed_at ?? null,
  created_at: m.created_at,
});
export const presentAccessRequest = (r: Obj): Obj => ({
  object: 'agent_access_request',
  id: r.id,
  agent_id: r.machine_id,
  kind: r.kind,
  resource: r.resource,
  scopes: r.scopes,
  reason: r.reason ?? null,
  status: r.status,
  constraints: r.constraints ?? null,
  auto_approved: r.auto_approved === true,
  decided_by: r.decided_by ?? null,
  decided_at: r.decided_at ?? null,
  expires_at: r.expires_at ?? null,
  created_at: r.created_at,
});

/** An agent grant is an approved, unexpired access request. The usage routes (`/v1/grants/agent/:id/...`) resolve through this. */
export function agentGrant(e: Engine, id: string | undefined): Obj | undefined {
  const r = e.db.agentRequests.get(id);
  if (!r || r.status !== 'approved') return undefined;
  return { id: r.id, machine_id: r.machine_id, resource_server_id: r.resource, scopes: r.scopes, constraints: r.constraints ?? null, expires_at: r.expires_at ?? null, kind: r.kind, created_at: r.created_at, updated_at: r.decided_at ?? r.created_at };
}
const liveAgentGrants = (e: Engine, machineId: string): Obj[] =>
  e.db.agentRequests
    .filter((r) => r.machine_id === machineId && r.status === 'approved' && !(r.expires_at && r.expires_at <= e.clock.now()))
    .map((r) => agentGrant(e, r.id)!);

const ruleMatches = (rules: Obj[], kind: string, resource: string): boolean =>
  (rules ?? []).some((r) => (r.kind === undefined || r.kind === kind) && (r.resource === undefined || r.resource === resource || (typeof r.resource === 'string' && r.resource.endsWith('*') && resource.startsWith(r.resource.slice(0, -1)))));

const agentRow = (e: Engine, id: string | undefined): Obj => {
  const m = e.db.machines.get(id);
  if (!m || m.deleted || !m.agent) throw notFound('Agent');
  return m;
};

export function deviceHandlers(): RouteDef[] {
  const agentCfg = (e: Engine): Obj => st(e).agentConfig;
  const enabled = (e: Engine): Obj => {
    const c = agentCfg(e);
    // A disabled instance is a plain 404 so its existence is not revealed.
    if (!c.enabled) throw notFound('Instance');
    return c;
  };
  const agentByCredentials = (e: Engine, id: unknown, secret: unknown): Obj => {
    if (typeof id !== 'string' || !id) throw new EmulatorError('VALIDATION_FAILED', 'An `agent_id` is required.', 'agent_id');
    if (typeof secret !== 'string' || !secret) throw new EmulatorError('VALIDATION_FAILED', 'An `agent_secret` is required.', 'agent_secret');
    const m = e.db.machines.get(id);
    if (!m || m.deleted || !m.agent || m.secret !== secret || m.status !== 'active') throw new EmulatorError('UNAUTHENTICATED', 'Invalid agent credentials.');
    return m;
  };
  const scopesFor = (cfg: Obj, tier: string): string[] => (tier === 'trusted' ? cfg.trusted_scopes : cfg.untrusted_scopes) ?? [];
  const decide = (e: Engine, r: Obj, status: 'approved' | 'denied', by: string, extra: { expiresInSeconds?: number; constraints?: Obj | null; auto?: boolean } = {}): Obj => {
    r.status = status;
    r.decided_by = by;
    r.decided_at = e.clock.now();
    r.auto_approved = extra.auto === true;
    if (extra.expiresInSeconds) r.expires_at = e.clock.now() + extra.expiresInSeconds * 1000;
    if (extra.constraints) r.constraints = extra.constraints;
    e.webhooks.emit('agent.access_decided', presentAccessRequest(r));
    return r;
  };

  return [
    // ── machine device-key flow (public: the presented credential is the authentication) ──
    {
      method: 'POST',
      pattern: '/v1/machine_enrolment_tokens',
      handler: async (c) => {
        const e = c.engine;
        const format = c.body.format === 'user_code' ? 'user_code' : 'token';
        let maxUses = typeof c.body.max_uses === 'number' ? c.body.max_uses : 1;
        let ttl = typeof c.body.expires_in_seconds === 'number' ? c.body.expires_in_seconds : 3600;
        if (format === 'user_code') {
          if (maxUses > 1) throw new EmulatorError('VALIDATION_FAILED', 'A user_code is single use.', 'max_uses');
          maxUses = 1;
          ttl = typeof c.body.expires_in_seconds === 'number' ? c.body.expires_in_seconds : 600;
          if (ttl < 300 || ttl > 900) throw new EmulatorError('VALIDATION_FAILED', 'expires_in_seconds must be 300 to 900 for a user_code.', 'expires_in_seconds');
        }
        if (c.body.owner_user_id && !e.db.users.get(c.body.owner_user_id)) throw new EmulatorError('NOT_FOUND', 'owner_user_id is not a user.', 'owner_user_id');
        if (c.body.organization_id && !e.db.organizations.get(c.body.organization_id)) throw new EmulatorError('NOT_FOUND', 'organization_id is not an organization.', 'organization_id');
        const secret = `met_${randomToken(24)}`;
        const code = format === 'user_code' ? userCode() : null;
        const now = e.clock.now();
        const row = e.db.enrolmentTokens.insert({
          format,
          organization_id: c.body.organization_id ?? null,
          max_uses: maxUses,
          uses: 0,
          max_machines: c.body.max_machines ?? null,
          requires_approval: c.body.requires_approval === true,
          single_session: c.body.single_session === true,
          owner_user_id: c.body.owner_user_id ?? null,
          data: c.body.data ?? {},
          expires_at: now + ttl * 1000,
          created_at: now,
        });
        st(e).lookup.set(code ? `code:${await hashOf(code)}` : `tok:${await hashOf(secret)}`, row.id);
        return { status: 201, body: { ...presentEnrolmentToken(row), ...(code ? { user_code: `${code.slice(0, 4)}-${code.slice(4)}` } : { secret }) } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/machine_enrolment_tokens',
      handler: (c) => {
        const org = c.query.get('organization_id');
        return listReply(c, c.engine.db.enrolmentTokens.filter((t) => org === null || (org === 'null' ? !t.organization_id : t.organization_id === org)), presentEnrolmentToken);
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/machine_enrolment_tokens/:id',
      handler: (c) => {
        const t = c.engine.db.enrolmentTokens.get(c.params.id);
        if (!t) throw notFound('Enrolment token');
        c.engine.db.enrolmentTokens.delete(t.id);
        return { body: { object: 'machine_enrolment_token', id: t.id, deleted: true } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/machines/enroll',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const presented = String(need(c.body, 'enrolment_token'));
        const pem = String(need(c.body, 'public_key_pem'));
        if (!(await isDeviceKey(pem))) throw new EmulatorError('VALIDATION_FAILED', 'public_key_pem must be an SPKI PEM Ed25519, ECDSA P-256 or RSA public key.', 'public_key_pem');
        const tok = await resolveEnrolment(e, presented);
        const deviceKey: string | null = typeof c.body.device_key === 'string' ? c.body.device_key : null;
        const now = e.clock.now();
        const superseded = deviceKey ? e.db.machines.filter((m) => !m.deleted && m.device_key === deviceKey && m.status !== 'revoked') : [];
        // The cap counts this token's live machines, after a re-enrolment frees its own slot.
        const mine = e.db.machines.filter((m) => !m.deleted && m.enrolment_token_id === tok.id && m.status !== 'revoked' && !superseded.some((x) => x.id === m.id));
        if (tok.max_machines && mine.length >= tok.max_machines) throw new EmulatorError('FORBIDDEN', `This enrolment token is capped at ${tok.max_machines} machines.`);
        for (const prior of superseded) {
          prior.status = 'revoked';
          prior.updated_at = now;
          e.changed({ type: 'machine.revoked', data: { ...deviceView(e, prior), reason: 'superseded' }, resource: 'machine', id: prior.id, op: 'update' });
        }
        if (!superseded.length) tok.uses += 1; // a supersede spends no extra use
        const status = tok.requires_approval ? 'pending' : 'active';
        const m = e.db.machines.insert({
          name: typeof c.body.name === 'string' ? c.body.name : 'device',
          owner_user_id: tok.owner_user_id ?? null,
          organization_id: tok.organization_id ?? null,
          status,
          metadata: { ...(tok.data ?? {}), ...(c.body.metadata ?? {}) },
          secret: e.tokens.secret('mk'),
          public_key_pem: pem,
          public_key_jkt: await jwkThumbprint(pem),
          device_key: deviceKey,
          enrolment_token_id: tok.id,
          enrolled_at: now,
          created_at: now,
          updated_at: now,
        });
        e.changed({ type: 'machine.enrolled', data: deviceView(e, m), resource: 'machine', id: m.id, op: 'create' });
        return { status: 201, body: { object: 'machine', id: m.id, name: m.name, organization_id: m.organization_id, status, public_key_jkt: m.public_key_jkt, device_key: deviceKey, enrolled_at: now, approval_required: status === 'pending' } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/machines/redeem',
      public: true,
      handler: async (c) => {
        const tok = await resolveEnrolment(c.engine, String(need(c.body, 'enrolment_token')));
        tok.uses += 1;
        return { body: { object: 'machine_enrolment_redemption', id: tok.id, data: tok.data ?? {}, owner_user_id: tok.owner_user_id ?? null, organization_id: tok.organization_id ?? null } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/machines/challenge',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const m = e.db.machines.get(String(need(c.body, 'machine_id')));
        if (!m || m.deleted) throw notFound('Machine');
        if (!m.public_key_pem) throw new EmulatorError('VALIDATION_FAILED', 'This machine has no registered key; enrol it first.', 'machine_id');
        const nonce = `${randomToken(24)}.${e.clock.now() + CHALLENGE_TTL_MS}`;
        st(e).nonces.set(nonce, { machineId: m.id, expiresAt: e.clock.now() + CHALLENGE_TTL_MS, spent: false });
        return { body: { object: 'machine_challenge', nonce, expires_in_seconds: CHALLENGE_TTL_MS / 1000 } };
      },
    },
    { method: 'POST', pattern: '/v1/machines/token', public: true, handler: (c) => machineToken(c) },
    // ── agents ──
    { method: 'GET', pattern: '/v1/agent_registration', handler: (c) => ({ body: { object: 'agent_registration', ...agentCfg(c.engine) } }) },
    {
      method: 'PUT',
      pattern: '/v1/agent_registration',
      handler: (c) => {
        const cfg = agentCfg(c.engine);
        for (const k of Object.keys(defaultAgentConfig())) if (k in c.body) cfg[k] = c.body[k];
        return { body: { object: 'agent_registration', ...cfg } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/agents/register',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const cfg = enabled(e);
        const identity = c.body.identity;
        if (identity === 'refresh') {
          if (!cfg.allow_refresh) throw new EmulatorError('FORBIDDEN', 'Refresh registration is not enabled.');
          const m = agentByCredentials(e, c.body.agent_id, c.body.agent_secret);
          m.secret = e.tokens.secret('mk');
          m.updated_at = e.clock.now();
          return { status: 200, body: { ...presentAgent(m), scopes: scopesFor(cfg, m.agent.tier), secret: m.secret } };
        }
        if (identity !== 'anonymous' && identity !== 'service_auth') throw new EmulatorError('VALIDATION_FAILED', '`identity` must be anonymous, service_auth or refresh.', 'identity');
        const name = typeof c.body.name === 'string' ? c.body.name.trim() : '';
        if (!name || name.length > 120) throw new EmulatorError('VALIDATION_FAILED', 'A `name` of 1-120 characters is required.', 'name');
        let tier = 'untrusted';
        let owner: string | null = null;
        if (identity === 'anonymous') {
          if (!cfg.allow_anonymous) throw new EmulatorError('FORBIDDEN', 'Anonymous agent registration is not enabled.');
        } else {
          if (!cfg.allow_service_auth) throw new EmulatorError('FORBIDDEN', 'Service-authenticated agent registration is not enabled.');
          // The caller proves it is the tenant's backend with a secret key; the agent starts trusted.
          const key = e.authenticateKey(c.request);
          if (key.scopes && !key.scopes.includes('machines:write') && !key.scopes.includes('*')) throw new EmulatorError('SCOPE_MISSING', 'This key lacks the `machines:write` scope.', undefined, { meta: { required_scope: 'machines:write' } });
          tier = 'trusted';
          if (typeof c.body.owner_user_id === 'string') {
            if (!e.db.users.get(c.body.owner_user_id)) throw new EmulatorError('VALIDATION_FAILED', 'Unknown user.', 'owner_user_id');
            owner = c.body.owner_user_id;
          }
        }
        const now = e.clock.now();
        const secret = e.tokens.secret('mk');
        const m = e.db.machines.insert({ name, owner_user_id: owner, organization_id: c.body.organization_id ?? null, status: 'active', metadata: c.body.metadata ?? {}, secret, agent: { identity, tier }, created_at: now, updated_at: now });
        return { status: 201, body: { ...presentAgent(m), scopes: scopesFor(cfg, tier), secret } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/agents/token',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const cfg = enabled(e);
        const m = agentByCredentials(e, c.body.agent_id, c.body.agent_secret);
        const tier: string = m.agent.tier;
        const scopes = scopesFor(cfg, tier);
        const grants = liveAgentGrants(e, m.id);
        const token = await e.tokens.signClaims(
          {
            sub: m.id,
            jti: e.db.newId('m2mToken'),
            token_use: 'm2m',
            agent_tier: tier,
            scope: scopes.join(' '),
            ...(m.organization_id ? { org_id: m.organization_id } : {}),
            grants: grants.map((g) => tokenGrant({ type: 'agent', id: g.id, resource: g.resource_server_id, scopes: g.scopes, kind: g.kind, constraints: g.constraints, expiresAt: g.expires_at })),
            agent_grants: grants.map((g) => ({ grant_id: g.id, grant_type: 'agent', kind: g.kind, resource: g.resource_server_id, scopes: g.scopes, ...(g.constraints ? { constraints: g.constraints } : {}) })),
            ...(m.owner_user_id ? { act_for: m.owner_user_id } : {}),
          },
          MACHINE_TOKEN_TTL_S,
        );
        return { headers: { 'cache-control': 'no-store' }, body: { object: 'agent_token', token, token_type: 'Bearer', expires_in: MACHINE_TOKEN_TTL_S, agent_id: m.id, tier, scope: scopes.join(' ') } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/agents/claim',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const cfg = enabled(e);
        const m = agentByCredentials(e, c.body.agent_id, c.body.agent_secret);
        if (m.owner_user_id) throw new EmulatorError('CONFLICT', 'This agent is already claimed.');
        const code = userCode();
        m.agent.claim = { code, expires_at: e.clock.now() + cfg.claim_ttl_seconds * 1000 };
        return { headers: { 'cache-control': 'no-store' }, body: { object: 'agent_claim', agent_id: m.id, user_code: code, expires_in: cfg.claim_ttl_seconds, claim_endpoint: '/v1/client/me/agents/claim' } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/agents/access_requests',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const cfg = enabled(e);
        const m = agentByCredentials(e, c.body.agent_id, c.body.agent_secret);
        if (c.body.kind !== 'tool' && c.body.kind !== 'connection') throw new EmulatorError('VALIDATION_FAILED', '`kind` must be tool or connection.', 'kind');
        const resource = typeof c.body.resource === 'string' ? c.body.resource.trim() : '';
        if (!resource || resource.length > 200) throw new EmulatorError('VALIDATION_FAILED', 'A `resource` of 1-200 characters is required.', 'resource');
        const scopes = c.body.scopes ?? [];
        if (!Array.isArray(scopes) || !scopes.every((x: unknown) => typeof x === 'string' && x.length > 0 && x.length <= 100)) throw new EmulatorError('VALIDATION_FAILED', '`scopes` must be an array of strings.', 'scopes');
        if (e.db.agentRequests.filter((r) => r.machine_id === m.id && r.status === 'pending').length >= 20) throw new EmulatorError('RATE_LIMITED', 'Too many pending access requests for this agent.');
        const r = e.db.agentRequests.insert({ machine_id: m.id, kind: c.body.kind, resource, scopes, constraints: c.body.constraints ?? null, reason: c.body.reason ?? null, status: 'pending', auto_approved: false, created_at: e.clock.now() });
        // Only a claimed (trusted) agent can be auto-approved: an unclaimed one has no accountable owner.
        if (m.agent.tier === 'trusted' && ruleMatches(cfg.auto_approve_rules, r.kind, r.resource)) decide(e, r, 'approved', 'auto_approve_rule', { auto: true });
        else e.webhooks.emit('agent.access_requested', { ...presentAccessRequest(r), agent: presentAgent(m) });
        return { status: 201, body: presentAccessRequest(r) };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/agent_access_requests',
      handler: (c) => {
        const status = c.query.get('status');
        const agent = c.query.get('agent_id');
        return listReply(c, c.engine.db.agentRequests.filter((r) => (!status || r.status === status) && (!agent || r.machine_id === agent)), presentAccessRequest);
      },
    },
    ...(['approve', 'deny'] as const).map(
      (verb): RouteDef => ({
        method: 'POST',
        pattern: `/v1/agent_access_requests/:id/${verb}`,
        handler: (c) => {
          const e = c.engine;
          const r = e.db.agentRequests.get(c.params.id);
          if (!r) throw notFound('Access request');
          const secs = c.body.expires_in_seconds;
          if (secs !== undefined && (!Number.isInteger(secs) || secs < 60 || secs > 31_536_000)) throw new EmulatorError('VALIDATION_FAILED', '`expires_in_seconds` must be an integer between 60 and 31536000.', 'expires_in_seconds');
          if (r.status !== 'pending') throw new EmulatorError('CONFLICT', 'This request is no longer pending.');
          return { body: presentAccessRequest(decide(e, r, verb === 'approve' ? 'approved' : 'denied', c.body.decided_by ?? 'api_key', { expiresInSeconds: secs, constraints: c.body.constraints })) };
        },
      }),
    ),
    {
      method: 'GET',
      pattern: '/v1/agents',
      handler: (c) => {
        const owner = c.query.get('owner_user_id');
        const tier = c.query.get('tier');
        return listReply(c, c.engine.db.machines.filter((m) => !m.deleted && m.agent && (!owner || m.owner_user_id === owner) && (!tier || m.agent.tier === tier)), presentAgent);
      },
    },
    { method: 'GET', pattern: '/v1/agents/:id', handler: (c) => ({ body: presentAgent(agentRow(c.engine, c.params.id)) }) },
    {
      method: 'POST',
      pattern: '/v1/agents/:id/claim',
      handler: (c) => {
        const e = c.engine;
        const m = agentRow(e, c.params.id);
        const uid = String(need(c.body, 'user_id'));
        if (!e.db.users.get(uid)) throw new EmulatorError('VALIDATION_FAILED', 'Unknown user.', 'user_id');
        m.agent = { identity: m.agent.identity, tier: 'trusted', claimed_at: e.clock.now() };
        m.owner_user_id = uid;
        return { body: presentAgent(m) };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/agents/:id/owner',
      handler: (c) => {
        const e = c.engine;
        const m = agentRow(e, c.params.id);
        const uid = c.body.user_id ?? null;
        if (uid !== null && !e.db.users.get(uid)) throw new EmulatorError('VALIDATION_FAILED', 'Unknown user.', 'user_id');
        m.owner_user_id = uid;
        return { body: presentAgent(m) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/agents/:id/revoke_access',
      handler: (c) => {
        const e = c.engine;
        const m = agentRow(e, c.params.id);
        const grants = e.db.agentRequests.filter((x) => x.machine_id === m.id && x.status === 'approved');
        for (const r of grants) r.status = 'revoked';
        if (c.body.disable === true) m.status = 'revoked';
        return { body: { ...presentAgent(m), revoked_grants: grants.length } };
      },
    },
  ];
}

/** What a request proved about the key or certificate it holds, for sender-constrained tokens (`cnf`). */
export interface ProvedBinding {
  jkt?: string;
  x5t?: string;
}

/** Throws the validation error a machine's `token_binding` demands when `proved` does not satisfy it. */
export function enforceTokenBinding(m: Obj, proved: ProvedBinding): void {
  const b = m.token_binding ?? 'none';
  if (b === 'dpop' && !proved.jkt) throw new EmulatorError('VALIDATION_FAILED', "This machine's tokens must be DPoP-bound: send a DPoP proof.", 'dpop');
  if (b === 'mtls' && !proved.x5t) throw new EmulatorError('VALIDATION_FAILED', "This machine's tokens must be certificate-bound: present a client certificate.", 'mtls');
  if (b === 'any' && !proved.jkt && !proved.x5t) throw new EmulatorError('VALIDATION_FAILED', "This machine's tokens must be sender-constrained: send a DPoP proof or present a client certificate.", 'dpop');
}

export const cnfOf = (p: ProvedBinding): Obj | undefined => (p.jkt || p.x5t ? { ...(p.jkt ? { jkt: p.jkt } : {}), ...(p.x5t ? { 'x5t#S256': p.x5t } : {}) } : undefined);

/**
 * Mint a machine token for `m` from the request fields (`audience`, `scopes`, `organization_id`). Every route that
 * issues one (signed challenge, federation) goes through here, so claims never differ by way in. `beforeIssue` runs after
 * every refusal and before the token is signed (the challenge route spends its nonce there).
 */
export async function issueMachineToken(
  c: RouteContext,
  m: Obj,
  req: Obj,
  opts: { proved?: ProvedBinding; maxTtlSeconds?: number; extraClaims?: Obj; beforeIssue?: () => void } = {},
): Promise<{ body: Obj }> {
  const e = c.engine;
  let bound: { rs: ReturnType<typeof resourceServerOf>; grant: Obj; scopes: string[] } | null = null;
  const audience = typeof req.audience === 'string' ? req.audience : null;
  if (audience) {
    const rs = resourceServerOf(e, audience);
    const now = e.clock.now();
    const grant = e.db.grants.find((g) => !g.revoked_at && g.machine_id === m.id && (g.resource_server_id === rs.id || g.resource_server_id === rs.identifier) && !(g.expires_at && g.expires_at <= now));
    if (!grant) throw new EmulatorError('FORBIDDEN', 'This machine has no grant for that resource server.');
    const asked: string[] = Array.isArray(req.scopes) ? req.scopes : [];
    const scopes = asked.length ? asked : [...grant.scopes];
    const outside = scopes.filter((s) => !grant.scopes.includes(s));
    if (outside.length) throw new EmulatorError('FORBIDDEN', `The grant does not include: ${outside.join(' ')}.`, 'scopes');
    bound = { rs, grant, scopes };
  } else if (req.scopes || req.scope_presets) throw new EmulatorError('VALIDATION_FAILED', '`scopes` needs an `audience`.', 'audience');

  // A machine that holds agent delegations mints only under a live one, narrowed to its scopes.
  const del = delegationForMint(e, m.id, req);
  if (del && bound) {
    bound.scopes = bound.scopes.filter((x) => del.scopes.includes(x));
    if (!bound.scopes.length) throw new EmulatorError('FORBIDDEN', 'The delegation does not include any of the requested scopes.', 'scopes');
  }

  let orgId: string | null = m.organization_id ?? null;
  const orgClaims: Obj = {};
  if (req.organization_id) {
    orgId = String(req.organization_id);
    const mm = e.generic.get('organizations/machine_memberships')?.find((x) => x._parent === orgId && x.machine_id === m.id);
    if (orgId !== m.organization_id && !mm) throw new EmulatorError('FORBIDDEN', 'The machine is not a member of that organization.', 'organization_id');
    const org = e.db.organizations.get(orgId);
    if (org) Object.assign(orgClaims, { org_slug: org.slug, ...(mm?.role ? { org_role: mm.role } : {}) });
  }
  opts.beforeIssue?.();
  // After the credential is spent: the bound pre_token Actions run (a deny refuses the mint), and only for a token bound to an API.
  const preToken = bound ? runActionTrigger(e, 'pre_token', { tokenType: 'machine', machineId: m.id, audience: bound.rs.identifier, scope: bound.scopes.join(' '), organizationId: orgId }).claims : {};
  const rl = machineRateLimitClaim(e, m.id);
  const ttl = Math.min(MACHINE_TOKEN_TTL_S, opts.maxTtlSeconds ?? MACHINE_TOKEN_TTL_S, del?.ttlSeconds ?? MACHINE_TOKEN_TTL_S);
  const cnf = cnfOf(opts.proved ?? {});
  const token = await e.tokens.signClaims(
    {
      sub: m.id,
      jti: e.db.newId('m2mToken'),
      token_use: 'm2m',
      ...(orgId ? { org_id: orgId } : {}),
      ...orgClaims,
      ...(cnf ? { cnf } : {}),
      ...(opts.extraClaims ?? {}),
      ...(del?.claims ?? {}),
      ...preToken,
      ...orgClaims,
      ...(bound
        ? {
            aud: bound.rs.identifier,
            scope: bound.scopes.join(' '),
            grant_id: bound.grant.id,
            grant_type: 'machine',
            grants: [tokenGrant({ type: 'machine', id: bound.grant.id, resource: bound.rs.identifier, scopes: bound.scopes, constraints: bound.grant.constraints, expiresAt: bound.grant.expires_at })],
            ...(bound.grant.constraints ? { constraints: bound.grant.constraints } : {}),
          }
        : {}),
      // The limit the API should apply to this machine, when a policy or override covers it.
      ...(rl ? { rl } : {}),
    },
    ttl,
  );
  m.metadata = { ...(m.metadata ?? {}), last_seen_at: e.clock.now() };
  return {
    body: {
      object: 'machine_token',
      token,
      token_type: opts.proved?.jkt ? 'DPoP' : 'Bearer',
      expires_in: ttl,
      machine_id: m.id,
      ...(bound ? { audience: bound.rs.identifier, scope: bound.scopes.join(' '), ...(bound.grant.constraints ? { constraints: bound.grant.constraints } : {}) } : {}),
      ...(orgClaims.org_role ? { organization_id: orgId, org_role: orgClaims.org_role } : {}),
    },
  };
}

/** The binding a request proves on a machine route: a DPoP proof (htm POST, htu this URL, single-use jti) and/or a forwarded client certificate. */
export async function provedBindingOf(c: RouteContext): Promise<ProvedBinding> {
  const e = c.engine;
  const proved: ProvedBinding = {};
  const raw = c.request.headers.get('dpop');
  if (raw !== null) {
    try {
      const r = await verifyDpopProof({ proof: raw, htm: 'POST', htu: c.request.url, nowMs: e.clock.now() });
      const seen = dpopSeen(e);
      const key = `${r.jkt}:${r.jti}`;
      if (seen.has(key)) throw new Error('The DPoP proof has already been used.');
      seen.set(key, e.clock.now() + (DPOP_IAT_WINDOW_S + 5) * 1000);
      for (const [k, until] of seen) if (until <= e.clock.now()) seen.delete(k);
      proved.jkt = r.jkt;
    } catch (err) {
      throw new EmulatorError('VALIDATION_FAILED', (err as Error).message, 'dpop');
    }
  }
  const x5t = await forwardedCertThumbprint(c.request.headers);
  if (x5t === null) throw new EmulatorError('VALIDATION_FAILED', 'The forwarded client certificate could not be read.', 'mtls');
  if (x5t) proved.x5t = x5t;
  return proved;
}

async function machineToken(c: RouteContext): Promise<{ body: Obj }> {
  const e = c.engine;
  const machineId = String(need(c.body, 'machine_id')).trim();
  const nonce = String(need(c.body, 'nonce')).trim();
  const signature = String(need(c.body, 'signature')).trim();
  const m = e.db.machines.get(machineId);
  if (!m || m.deleted) throw notFound('Machine');
  if (m.status !== 'active' || !m.public_key_pem) throw new EmulatorError('FORBIDDEN', 'This machine is not permitted to mint tokens.');
  const rec = st(e).nonces.get(nonce);
  if (!rec || rec.machineId !== m.id || rec.spent || rec.expiresAt <= e.clock.now()) throw new EmulatorError('VALIDATION_FAILED', 'The challenge nonce is invalid or expired.', 'nonce');
  // The security boundary: a bad signature means the caller does not hold the private key.
  if (!(await verifyDeviceSignature(m.public_key_pem, nonce, signature))) throw new EmulatorError('VALIDATION_FAILED', 'The signature does not verify against the registered key.', 'signature');
  // A binding the machine demands is checked before the nonce is spent, so a corrected request can retry.
  const proved = await provedBindingOf(c);
  enforceTokenBinding(m, proved);
  return issueMachineToken(c, m, c.body, { proved, beforeIssue: () => void (rec.spent = true) });
}

const dpopSeen = (e: Engine): Map<string, number> => {
  let s = dpopStore.get(e);
  if (!s) dpopStore.set(e, (s = new Map()));
  return s;
};
const dpopStore = new WeakMap<Engine, Map<string, number>>();

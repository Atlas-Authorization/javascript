/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { randomToken } from '../store';
import { discoveryDocument } from './oauth';
import { revokeSession } from './round2';
import { listReply, need } from './util';

const memberOrgRole = (e: Engine, userId: string, orgId: string | null | undefined): Obj => {
  if (!orgId) return {};
  const m = e.db.memberships.find((x) => x.user_id === userId && x.organization_id === orgId);
  if (!m) throw new EmulatorError('FORBIDDEN', 'The user is not a member of that organization.', 'organization_id');
  const role = e.db.roles.find((r) => r.key === m.role);
  const org = e.db.organizations.get(orgId);
  return { org_id: orgId, org_slug: org?.slug, org_role: m.role, org_permissions: role?.permissions ?? [] };
};

const presentSession = (s: Obj): Obj => ({
  object: 'session',
  id: s.id,
  user_id: s.user_id,
  status: s.status,
  organization_id: s.organization_id ?? null,
  created_at: s.created_at,
  expires_at: s.expires_at,
  last_active_at: s.last_active_at,
});

/** A replay of a just-rotated token within this window is a client that lost the reply, not theft (the real service uses 30 s). */
export const REFRESH_GRACE_MS = 30_000;

interface RefreshRec {
  sessionId: string;
  /** Set once the token is spent: when, and which token replaced it. */
  rotatedAt?: number;
  successor?: string;
}
const refreshTokens = new WeakMap<Engine, Map<string, RefreshRec>>();
const refreshMap = (e: Engine) => {
  let m = refreshTokens.get(e);
  if (!m) refreshTokens.set(e, (m = new Map()));
  return m;
};
export const resetSessions = (e: Engine): void => void refreshTokens.delete(e);

export function issueRefreshToken(e: Engine, sessionId: string, token?: string): string {
  const t = token ?? `rt_${randomToken(32)}`;
  refreshMap(e).set(t, { sessionId });
  return t;
}

/**
 * Rotate a refresh token, like the real service: the old one is spent and a new one issued. A replay of the
 * spent token inside the grace window is idempotent (a fresh JWT and the token already issued, no second
 * rotation); outside it the replay is theft: the session is revoked and REFRESH_REUSE_DETECTED answers.
 */
export async function refreshSession(e: Engine, token: string): Promise<{ jwt: string; refresh_token: string; expires_in: number; session_id: string }> {
  const rec = refreshMap(e).get(token);
  if (!rec) throw new EmulatorError('UNAUTHENTICATED', 'That session is no longer valid.');
  const s = e.db.sessions.get(rec.sessionId);
  if (!s || s.status === 'revoked') throw new EmulatorError('SESSION_REVOKED', 'The session is no longer active.');
  const now = e.clock.now();
  if (s.expires_at <= now) throw new EmulatorError('SESSION_EXPIRED', 'The session has expired.');
  const mint = async () => (await e.tokens.mintSession({ userId: s.user_id, sessionId: s.id, organizationId: s.organization_id, claims: memberOrgRole(e, s.user_id, s.organization_id) }));
  if (rec.rotatedAt !== undefined) {
    if (now - rec.rotatedAt <= REFRESH_GRACE_MS && rec.successor) {
      const minted = await mint();
      return { jwt: minted.jwt, refresh_token: rec.successor, expires_in: minted.expiresIn, session_id: s.id };
    }
    revokeSession(e, s, 'refresh_token_reuse');
    throw new EmulatorError('REFRESH_REUSE_DETECTED', 'This session was ended for security reasons. Please sign in again.');
  }
  s.last_active_at = now;
  const minted = await mint();
  const next = issueRefreshToken(e, s.id);
  rec.rotatedAt = now;
  rec.successor = next;
  return { jwt: minted.jwt, refresh_token: next, expires_in: minted.expiresIn, session_id: s.id };
}

export function sessionsHandlers(): RouteDef[] {
  const SESSION_TTL = 7 * 86_400_000;
  return [
    {
      method: 'GET',
      pattern: '/.well-known/jwks.json',
      public: true,
      handler: async (c) => ({ body: await c.engine.tokens.jwks() }),
    },
    { method: 'GET', pattern: '/.well-known/openid-configuration', public: true, handler: (c) => ({ body: discoveryDocument(c.engine) }) },
    {
      // The real Frontend API route (same path, credential sources and answer): the refresh credential is the
      // `__atlas_rt` cookie, the `x-refresh-token` header or the `refresh_token` body field; a cookieless caller gets
      // the rotated token back in the body. The session id in the path must be the token's session.
      method: 'POST',
      pattern: '/v1/client/sessions/:id/tokens',
      public: true,
      handler: async (c) => {
        const cookie = /(?:^|;\s*)__atlas_rt=([^;]+)/.exec(c.request.headers.get('cookie') ?? '')?.[1];
        const header = c.request.headers.get('x-refresh-token');
        const bodyToken = typeof c.body.refresh_token === 'string' ? c.body.refresh_token : undefined;
        const presented = cookie ? decodeURIComponent(cookie) : (header ?? bodyToken);
        if (!presented) throw new EmulatorError('UNAUTHENTICATED', 'No refresh token was presented.');
        const out = await refreshSession(c.engine, presented);
        if (out.session_id !== c.params.id) throw notFound('Session');
        const attrs = 'Path=/; HttpOnly; SameSite=Lax';
        return {
          body: { object: 'session_tokens', jwt: out.jwt, session_id: out.session_id, expires_in: out.expires_in, ...(cookie ? {} : { refresh_token: out.refresh_token }) },
          headers: { 'set-cookie': [`__session=${out.jwt}; ${attrs}; Max-Age=${out.expires_in}`, `__atlas_rt=${encodeURIComponent(out.refresh_token)}; ${attrs}`] },
        };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/sessions',
      handler: async (c) => {
        const e = c.engine;
        const userId = String(need(c.body, 'user_id'));
        const u = e.db.users.get(userId);
        if (!u || u.deleted) throw new EmulatorError('NOT_FOUND', 'User not found.', 'user_id');
        if (u.banned) throw new EmulatorError('BANNED', 'The user is banned.');
        const orgId: string | null = c.body.organization_id ?? null;
        const orgClaims = memberOrgRole(e, userId, orgId);
        const now = e.clock.now();
        const s = e.db.sessions.insert({ user_id: userId, organization_id: orgId, status: 'active', created_at: now, expires_at: now + SESSION_TTL, last_active_at: now });
        const minted = await e.tokens.mintSession({ userId, sessionId: s.id, organizationId: orgId, claims: { ...orgClaims, ...(c.body.actor?.sub ? { act: { sub: c.body.actor.sub } } : {}) } });
        return { status: 200, body: { ...presentSession(s), jwt: minted.jwt, refresh_token: issueRefreshToken(e, s.id), expires_in: minted.expiresIn } };
      },
    },
    { method: 'GET', pattern: '/v1/sessions', handler: (c) => {
      const q = (k: string) => c.query.get(k);
      const sessions = c.engine.db.sessions.filter((s) => (!q('user_id') || s.user_id === q('user_id')) && (!q('organization_id') || s.organization_id === q('organization_id')) && (q('active') === null || (s.status === 'active') === (q('active') === 'true')) && (!q('created_after') || s.created_at >= Date.parse(q('created_after')!)) && (!q('created_before') || s.created_at <= Date.parse(q('created_before')!)));
      return listReply(c, sessions, presentSession);
    } },
    {
      method: 'GET',
      pattern: '/v1/sessions/:id',
      handler: (c) => {
        const s = c.engine.db.sessions.get(c.params.id);
        if (!s) throw notFound('Session');
        return { body: presentSession(s) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/sessions/:id/revoke',
      handler: (c) => {
        const s = c.engine.db.sessions.get(c.params.id);
        if (!s) throw notFound('Session');
        revokeSession(c.engine, s, 'admin');
        return { body: presentSession(s) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/sessions/:id/tokens/:template',
      handler: async (c) => {
        const e = c.engine;
        const s = e.db.sessions.get(c.params.id);
        if (!s || s.status !== 'active') throw notFound('Session');
        const name = c.params.template ?? 'session';
        let claims: Obj = memberOrgRole(e, s.user_id, s.organization_id);
        let ttl = 60;
        if (name !== 'session') {
          const t = e.generic.get('jwt_templates')?.find((r) => r.name === name);
          if (!t) throw notFound('JWT template');
          claims = { ...claims, ...(t.claims ?? {}) };
          if (typeof t.lifetime_seconds === 'number') ttl = t.lifetime_seconds;
          else if (typeof t.settings?.lifetime_seconds === 'number') ttl = t.settings.lifetime_seconds;
        }
        const minted = await e.tokens.mintSession({ userId: s.user_id, sessionId: s.id, organizationId: s.organization_id, claims, ttlSeconds: ttl });
        return { body: { object: 'token', jwt: minted.jwt } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/tokens/verify',
      handler: async (c) => {
        const e = c.engine;
        const token = String(need(c.body, 'token'));
        const r = await e.tokens.verify(token);
        if (!r.ok) return { body: { object: 'token_verification', verified: false, reason: r.reason } };
        const sid = String(r.claims.sid ?? '');
        const s = e.db.sessions.get(sid);
        if (s && s.status !== 'active') return { body: { object: 'token_verification', verified: false, reason: 'revoked' } };
        return { body: { object: 'token_verification', verified: true, user_id: r.claims.sub, session_id: sid, organization_id: r.claims.org_id ?? null, organization_role: r.claims.org_role ?? null } };
      },
    },
    { method: 'GET', pattern: '/v1/instance/signing_keys', handler: async (c) => ({ body: { object: 'list', data: await c.engine.tokens.signingKeys() } }) },
    {
      method: 'POST',
      pattern: '/v1/instance/signing_keys/rotate',
      handler: async (c) => {
        const alg = c.body.alg === 'ES256' ? 'ES256' : 'RS256';
        const r = await c.engine.tokens.rotate(alg);
        c.engine.webhooks.emit('signing_key.rotated', { kid: r.kid, previous_kid: r.previous_kid, emergency: false, retires_at: null });
        return { body: { object: 'signing_key_rotation', ...r } };
      },
    },
  ];
}

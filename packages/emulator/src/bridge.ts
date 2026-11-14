/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AtlasMock } from '@atlasauth/msw';
import { adoptMembership, adoptOrganization, adoptSession, adoptUser, type Engine } from '@atlasauth/emulator-core';

/**
 * One state for the emulator's two surfaces. The Frontend API mock (`/v1/client/*`, sign-in and sign-up flows) and the
 * Backend API engine (everything else) each keep their own tables; this copies records across by id, in both directions,
 * so a user created over the Backend API can sign in through the Frontend API and a session the sign-in mints can be
 * refreshed, listed and revoked over the Backend API. The side that changed last wins (`updated_at` / `updatedAt`).
 * Run it before and after every request; it is cheap and idempotent.
 */
const orgRole = (r: string): string => (r.includes(':') ? r : `org:${r}`);
const mockRole = (r: string): string => r.replace(/^org:/, '');

export function syncState(mock: AtlasMock, engine: Engine): void {
  // users
  for (const mu of mock.users) {
    const eu = engine.db.users.get(mu.id);
    if (!eu) {
      adoptUser(engine, {
        id: mu.id,
        emails: mu.emails.map((m) => ({ id: m.id, email_address: m.email, verified: m.verified })),
        primary_email_address_id: mu.primaryEmailId ?? mu.emails.find((m) => m.primary)?.id ?? null,
        first_name: mu.firstName,
        last_name: mu.lastName,
        username: mu.username,
        external_id: mu.externalId,
        image_url: mu.imageUrl,
        password: mu.password,
        public_metadata: mu.publicMetadata,
        private_metadata: mu.privateMetadata,
        unsafe_metadata: mu.unsafeMetadata,
        banned: mu.banned,
        created_at: mu.createdAt,
        updated_at: mu.updatedAt,
      });
      if (mu.deletedAt) engine.db.users.update(mu.id, { deleted: true });
      continue;
    }
    if (mu.updatedAt > eu.updated_at) {
      Object.assign(eu, { first_name: mu.firstName, last_name: mu.lastName, username: mu.username, external_id: mu.externalId, public_metadata: mu.publicMetadata, unsafe_metadata: mu.unsafeMetadata, private_metadata: mu.privateMetadata, banned: mu.banned, deleted: mu.deletedAt ? true : eu.deleted, updated_at: mu.updatedAt });
      if (typeof mu.password === 'string') Object.assign(eu, { has_password: true, password_plain: mu.password });
    } else if (eu.updated_at > mu.updatedAt) {
      Object.assign(mu, { firstName: eu.first_name ?? null, lastName: eu.last_name ?? null, username: eu.username ?? null, externalId: eu.external_id ?? null, publicMetadata: eu.public_metadata ?? {}, unsafeMetadata: eu.unsafe_metadata ?? {}, privateMetadata: eu.private_metadata ?? {}, banned: eu.banned === true, deletedAt: eu.deleted ? (mu.deletedAt ?? eu.updated_at) : null, updatedAt: eu.updated_at });
      if (typeof eu.password_plain === 'string') mu.password = eu.password_plain;
    }
  }
  for (const eu of engine.db.users.all()) {
    let mu = mock.findUser(eu.id, true);
    if (!mu) {
      const primary = (eu.emails as any[]).find((m) => m.id === eu.primary_email_address_id) ?? eu.emails[0];
      mu = mock.addUser({
        id: eu.id,
        email: primary?.email_address,
        emailVerified: primary?.verified,
        password: typeof eu.password_plain === 'string' ? eu.password_plain : undefined,
        firstName: eu.first_name ?? undefined,
        lastName: eu.last_name ?? undefined,
        username: eu.username ?? undefined,
        externalId: eu.external_id ?? undefined,
        publicMetadata: eu.public_metadata,
        privateMetadata: eu.private_metadata,
        unsafeMetadata: eu.unsafe_metadata,
      });
      // The engine allows several addresses; the mock seed takes one, so the rest are appended by hand.
      for (const extra of (eu.emails as any[]).filter((m) => m.id !== primary?.id)) mu.emails.push({ id: extra.id, email: String(extra.email_address).toLowerCase(), verified: extra.verified, primary: false });
      Object.assign(mu, { createdAt: eu.created_at, updatedAt: eu.updated_at, banned: eu.banned === true, deletedAt: eu.deleted ? eu.updated_at : null });
    }
  }
  // organizations and memberships
  for (const mo of mock.organizations) adoptOrganization(engine, { id: mo.id, name: mo.name, slug: mo.slug, created_by: mo.createdBy, public_metadata: mo.publicMetadata, created_at: mo.createdAt, updated_at: mo.updatedAt });
  for (const eo of engine.db.organizations.all()) {
    if (!mock.findOrganization(eo.id)) mock.addOrganization({ id: eo.id, name: eo.name, slug: eo.slug, publicMetadata: eo.public_metadata });
  }
  for (const mm of mock.memberships) {
    if (engine.db.users.get(mm.userId) && engine.db.organizations.get(mm.organizationId)) adoptMembership(engine, mm.organizationId, mm.userId, orgRole(mm.role));
  }
  for (const em of engine.db.memberships.all()) {
    if (!mock.memberships.some((m) => m.userId === em.user_id && m.organizationId === em.organization_id) && mock.findUser(em.user_id) && mock.findOrganization(em.organization_id)) mock.addMembership(em.user_id, em.organization_id, mockRole(em.role));
  }
  for (const mm of [...mock.memberships]) {
    const gone = !engine.db.memberships.find((m) => m.user_id === mm.userId && m.organization_id === mm.organizationId);
    if (gone && engine.db.organizations.get(mm.organizationId) && engine.db.users.get(mm.userId)) mock.memberships.splice(mock.memberships.indexOf(mm), 1);
  }
  // sessions: the mock mints them at sign-in; the engine refreshes, lists and revokes them
  for (const ms of mock.sessions) {
    adoptSession(engine, { id: ms.id, userId: ms.userId, organizationId: ms.activeOrganizationId, refreshToken: ms.refreshToken, createdAt: ms.createdAt, expiresAt: ms.expiresAt, lastActiveAt: ms.lastActiveAt, status: ms.status });
    const es = engine.db.sessions.get(ms.id);
    if (es && es.status === 'revoked' && ms.status === 'active') ms.status = 'revoked';
    else if (es && es.status === 'active' && ms.status !== 'active') engine.db.sessions.update(ms.id, { status: 'revoked', revoked_at: engine.clock.now(), revoked_reason: 'signed_out' });
  }
  for (const es of engine.db.sessions.all()) {
    if (!mock.findSession(es.id) && mock.findUser(es.user_id)) {
      mock.sessions.push({ id: es.id, userId: es.user_id, status: es.status === 'active' ? 'active' : 'revoked', activeOrganizationId: es.organization_id ?? null, impersonatedBy: null, jwt: `jwt_${es.id}`, refreshToken: `rt_${es.id}`, lastActiveAt: es.last_active_at, expiresAt: es.expires_at, idleExpiresAt: es.expires_at, createdAt: es.created_at });
    }
  }
}

/**
 * A real engine-signed access JWT presented to the mock (which knows sessions by an opaque bearer) is translated to the
 * session's own bearer, so a token minted by a refresh keeps working on `/v1/client/me`.
 */
export async function translateBearer(mock: AtlasMock, engine: Engine, request: Request): Promise<Request> {
  const h = request.headers.get('authorization');
  const token = /^Bearer\s+(.+)$/i.exec(h ?? '')?.[1];
  if (!token || token.split('.').length !== 3) return request;
  const v = await engine.tokens.verifyAny(token);
  if (!v.ok || typeof v.claims.sid !== 'string') return request;
  const session = mock.findSession(v.claims.sid);
  if (!session) return request;
  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${session.jwt}`);
  return new Request(request, { headers });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine } from './engine';
import type { Obj } from './openapi';
import { addMember, presentOrg } from './handlers/orgs';
import { issueRefreshToken } from './handlers/sessions';
import { presentUser } from './handlers/users';

/**
 * Put a record that already exists elsewhere (another store sharing this engine's state, such as the Frontend API mock)
 * into the engine under its own id, with the same change-feed and webhook entries a create would make. Idempotent: an id
 * already present is returned untouched. This is how `@atlasauth/emulator` keeps one state across its two surfaces.
 */
export interface AdoptUser {
  id: string;
  emails: Array<{ id: string; email_address: string; verified: boolean }>;
  primary_email_address_id: string | null;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  external_id?: string | null;
  image_url?: string | null;
  password?: string | null;
  public_metadata?: Obj;
  private_metadata?: Obj;
  unsafe_metadata?: Obj;
  banned?: boolean;
  created_at: number;
  updated_at: number;
}

export function adoptUser(e: Engine, u: AdoptUser): Obj {
  const have = e.db.users.get(u.id);
  if (have) return have;
  const row = e.db.users.insert({
    id: u.id,
    username: u.username ?? null,
    first_name: u.first_name ?? null,
    last_name: u.last_name ?? null,
    image_url: u.image_url ?? null,
    external_id: u.external_id ?? null,
    emails: u.emails,
    primary_email_address_id: u.primary_email_address_id,
    has_password: typeof u.password === 'string',
    password_plain: u.password ?? null,
    public_metadata: u.public_metadata ?? {},
    unsafe_metadata: u.unsafe_metadata ?? {},
    private_metadata: u.private_metadata ?? {},
    banned: u.banned === true,
    locked: false,
    created_at: u.created_at,
    updated_at: u.updated_at,
    version: 1,
  });
  e.changed({ type: 'user.created', data: presentUser(e, row), resource: 'user', id: row.id, op: 'create' });
  return row;
}

export function adoptOrganization(e: Engine, o: { id: string; name: string; slug: string | null; created_by?: string | null; public_metadata?: Obj; created_at: number; updated_at: number }): Obj {
  const have = e.db.organizations.get(o.id);
  if (have) return have;
  const row = e.db.organizations.insert({ id: o.id, name: o.name, slug: o.slug ?? o.id, image_url: null, public_metadata: o.public_metadata ?? {}, private_metadata: {}, created_by: o.created_by ?? null, created_at: o.created_at, updated_at: o.updated_at, version: 1 });
  e.changed({ type: 'organization.created', data: presentOrg(e, row), resource: 'organization', id: row.id, op: 'create' });
  return row;
}

export function adoptMembership(e: Engine, orgId: string, userId: string, role: string): Obj {
  return e.db.memberships.find((m) => m.organization_id === orgId && m.user_id === userId) ?? addMember(e, orgId, userId, role);
}

/** A session minted elsewhere: it gets a row under its id, and `refreshToken` becomes a live refresh credential on the real route. */
export function adoptSession(e: Engine, s: { id: string; userId: string; organizationId?: string | null; refreshToken: string; createdAt: number; expiresAt: number; lastActiveAt: number; status: 'active' | 'revoked' | 'ended' }): Obj {
  const have = e.db.sessions.get(s.id);
  if (have) return have;
  const row = e.db.sessions.insert({ id: s.id, user_id: s.userId, organization_id: s.organizationId ?? null, status: s.status === 'active' ? 'active' : 'revoked', created_at: s.createdAt, expires_at: s.expiresAt, last_active_at: s.lastActiveAt });
  issueRefreshToken(e, s.id, s.refreshToken);
  return row;
}

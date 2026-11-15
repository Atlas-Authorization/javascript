/* eslint-disable @typescript-eslint/no-explicit-any */
import { onMembershipChanged } from './authz-state';
import type { Engine, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { presentMembership } from './users';
import { bump, listReply, merge, need, slugify } from './util';

export function presentOrg(e: Engine, o: Obj): Obj {
  return e.shape('Organization', {
    object: 'organization',
    id: o.id,
    name: o.name,
    slug: o.slug,
    image_url: o.image_url ?? null,
    parent_organization_id: o.parent_organization_id ?? null,
    public_metadata: o.public_metadata ?? {},
    max_allowed_memberships: o.max_allowed_memberships ?? null,
    created_by: o.created_by ?? null,
    external_id: o.external_id ?? null,
    created_at: o.created_at,
    updated_at: o.updated_at,
  });
}

export function presentInvitation(e: Engine, i: Obj): Obj {
  return e.shape('Invitation', {
    object: 'invitation',
    id: i.id,
    email_address: i.email_address,
    status: i.status,
    public_metadata: i.public_metadata ?? {},
    expires_at: i.expires_at ?? null,
    accepted_at: i.accepted_at ?? null,
    created_at: i.created_at,
  });
}

const liveOrg = (e: Engine, id: string | undefined): Obj => {
  const o = e.db.organizations.get(id);
  if (!o || o.deleted) throw notFound('Organization');
  return o;
};

const DAY = 86_400_000;

export function orgsHandlers(): RouteDef[] {
  const uniqueSlug = (e: Engine, base: string): string => {
    const taken = new Set(e.db.organizations.all().filter((o) => !o.deleted).map((o) => o.slug));
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    return slug;
  };
  const orgEvent = (e: Engine, type: string, o: Obj, op: 'create' | 'update' | 'delete', data?: Obj) =>
    e.changed({ type, data: data ?? presentOrg(e, o), resource: 'organization', id: o.id, op });

  return [
    {
      method: 'GET',
      pattern: '/v1/organizations',
      handler: (c) => {
        const ext = c.query.get('external_id');
        const q = c.query.get('query')?.toLowerCase();
        const orgs = c.engine.db.organizations.filter((o) => !o.deleted && (!ext || o.external_id === ext) && (!q || `${o.name} ${o.slug}`.toLowerCase().includes(q)));
        return listReply(c, orgs, (o) => presentOrg(c.engine, o));
      },
    },
    {
      method: 'POST',
      pattern: '/v1/organizations',
      handler: (c) => {
        const e = c.engine;
        const name = String(need(c.body, 'name'));
        let slug: string;
        if (c.body.slug) {
          slug = String(c.body.slug);
          if (e.db.organizations.all().some((o) => !o.deleted && o.slug === slug)) throw new EmulatorError('IDENTIFIER_EXISTS', `The slug ${slug} is taken.`, 'slug');
        } else slug = uniqueSlug(e, slugify(name));
        if (c.body.created_by && !e.db.users.get(c.body.created_by)) throw new EmulatorError('NOT_FOUND', 'created_by is not a user.', 'created_by');
        const now = e.clock.now();
        const o = e.db.organizations.insert({
          name,
          slug,
          external_id: c.body.external_id ?? null,
          created_by: c.body.created_by ?? null,
          max_allowed_memberships: c.body.max_allowed_memberships ?? null,
          public_metadata: c.body.public_metadata ?? {},
          private_metadata: c.body.private_metadata ?? {},
          created_at: now,
          updated_at: now,
        });
        orgEvent(e, 'organization.created', o, 'create');
        if (c.body.created_by) addMember(e, o.id, c.body.created_by, 'org:admin');
        return { status: 201, body: presentOrg(e, o) };
      },
    },
    { method: 'GET', pattern: '/v1/organizations/:id', handler: (c) => ({ body: presentOrg(c.engine, liveOrg(c.engine, c.params.id)) }) },
    {
      method: 'PATCH',
      pattern: '/v1/organizations/:id',
      handler: (c) => {
        const e = c.engine;
        const o = liveOrg(e, c.params.id);
        if (c.body.slug && c.body.slug !== o.slug && e.db.organizations.all().some((x) => !x.deleted && x.slug === c.body.slug)) {
          throw new EmulatorError('IDENTIFIER_EXISTS', `The slug ${c.body.slug} is taken.`, 'slug');
        }
        for (const k of ['name', 'slug', 'external_id', 'max_allowed_memberships', 'image_url']) if (k in c.body) o[k] = c.body[k];
        if ('public_metadata' in c.body) o.public_metadata = merge(o.public_metadata, c.body.public_metadata);
        if ('private_metadata' in c.body) o.private_metadata = merge(o.private_metadata, c.body.private_metadata);
        bump(e, o);
        orgEvent(e, 'organization.updated', o, 'update');
        return { body: presentOrg(e, o) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/organizations/:id',
      handler: (c) => {
        const e = c.engine;
        const o = liveOrg(e, c.params.id);
        o.deleted = true;
        for (const m of e.db.memberships.filter((x) => x.organization_id === o.id)) {
          e.db.memberships.delete(m.id);
          e.changed({ type: 'organization_membership.deleted', data: { id: m.id, organization_id: o.id, user_id: m.user_id }, resource: 'membership', id: m.id, op: 'delete' });
        }
        onMembershipChanged(e);
        orgEvent(e, 'organization.deleted', o, 'delete', { object: 'organization', id: o.id, deleted: true });
        return { body: { object: 'organization', id: o.id, deleted: true } };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/organizations/:id/metadata',
      handler: (c) => {
        const e = c.engine;
        const o = liveOrg(e, c.params.id);
        for (const k of ['public_metadata', 'private_metadata']) if (k in c.body) o[k] = c.body[k] ?? {};
        bump(e, o);
        orgEvent(e, 'organization.updated', o, 'update');
        return { body: presentOrg(e, o) };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/organizations/:id/memberships',
      handler: (c) => {
        const o = liveOrg(c.engine, c.params.id);
        return listReply(c, c.engine.db.memberships.filter((m) => m.organization_id === o.id), (m) => presentMembership(c.engine, m));
      },
    },
    {
      method: 'POST',
      pattern: '/v1/organizations/:id/memberships',
      handler: (c) => {
        const e = c.engine;
        const o = liveOrg(e, c.params.id);
        const userId = String(need(c.body, 'user_id'));
        const u = e.db.users.get(userId);
        if (!u || u.deleted) throw new EmulatorError('NOT_FOUND', 'User not found.', 'user_id');
        const role = String(c.body.role ?? 'org:member');
        if (e.db.memberships.find((m) => m.organization_id === o.id && m.user_id === userId)) throw new EmulatorError('ALREADY_MEMBER', 'That user is already a member.', 'user_id');
        if (o.max_allowed_memberships && e.db.memberships.filter((m) => m.organization_id === o.id).length >= o.max_allowed_memberships) {
          throw new EmulatorError('FORBIDDEN', 'The organization is at its seat limit.');
        }
        return { status: 200, body: presentMembership(e, addMember(e, o.id, userId, role)) };
      },
    },
    {
      method: 'PATCH',
      pattern: '/v1/organizations/:id/memberships/:userId',
      handler: (c) => {
        const e = c.engine;
        const o = liveOrg(e, c.params.id);
        const m = e.db.memberships.find((x) => x.organization_id === o.id && x.user_id === c.params.userId);
        if (!m) throw notFound('Membership');
        if (typeof c.body.role === 'string') m.role = c.body.role;
        e.changed({ type: 'organization_membership.updated', data: presentMembership(e, m), resource: 'membership', id: m.id, op: 'update' });
        onMembershipChanged(e);
        return { body: presentMembership(e, m) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/organizations/:id/memberships/:userId',
      handler: (c) => {
        const e = c.engine;
        const o = liveOrg(e, c.params.id);
        const m = e.db.memberships.find((x) => x.organization_id === o.id && x.user_id === c.params.userId);
        if (!m) throw notFound('Membership');
        e.db.memberships.delete(m.id);
        e.changed({ type: 'organization_membership.deleted', data: { id: m.id, organization_id: o.id, user_id: m.user_id }, resource: 'membership', id: m.id, op: 'delete' });
        onMembershipChanged(e);
        return { body: { object: 'organization_membership', id: m.id, deleted: true } };
      },
    },
    // Instance-level invitations (no email is sent, like the real route).
    {
      method: 'GET',
      pattern: '/v1/invitations',
      handler: (c) => listReply(c, c.engine.db.invitations.all(), (i) => presentInvitation(c.engine, i)),
    },
    {
      method: 'POST',
      pattern: '/v1/invitations',
      handler: (c) => {
        const e = c.engine;
        const address = String(need(c.body, 'email_address'));
        const now = e.clock.now();
        const days = typeof c.body.expires_in_days === 'number' ? c.body.expires_in_days : 30;
        const i = e.db.invitations.insert({
          email_address: address,
          status: 'pending',
          public_metadata: c.body.public_metadata ?? {},
          expires_at: typeof c.body.expires_at === 'number' ? c.body.expires_at : now + days * DAY,
          accepted_at: null,
          created_at: now,
        });
        e.changed({ type: 'invitation.created', data: presentInvitation(e, i), resource: 'invitation', id: i.id, op: 'create' });
        return { status: 201, body: presentInvitation(e, i) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/invitations/:id/revoke',
      handler: (c) => {
        const e = c.engine;
        const i = e.db.invitations.get(c.params.id);
        if (!i) throw notFound('Invitation');
        if (i.status !== 'pending') throw new EmulatorError('FORBIDDEN', `A ${i.status} invitation cannot be revoked.`);
        i.status = 'revoked';
        e.changed({ type: 'invitation.revoked', data: presentInvitation(e, i), resource: 'invitation', id: i.id, op: 'update' });
        return { body: presentInvitation(e, i) };
      },
    },
    // Organization invitations send an email: it lands in the message sink with the accept link.
    {
      method: 'POST',
      pattern: '/v1/organizations/:id/invitations',
      handler: (c) => {
        const e = c.engine;
        const o = liveOrg(e, c.params.id);
        const address = String(need(c.body, 'email'));
        const now = e.clock.now();
        const token = e.tokens.secret('invtok');
        const i = e.db.orgInvitations.insert({
          organization_id: o.id,
          email_address: address,
          role: c.body.role ?? 'org:member',
          status: 'pending',
          token,
          created_at: now,
          expires_at: now + 7 * DAY,
        });
        const link = `${e.issuer}/accept-invitation?token=${token}`;
        e.messages.send({ channel: 'email', to: address, subject: `You are invited to ${o.name}`, body: `Accept: ${link}`, link, code: token, meta: { organization_id: o.id, invitation_id: i.id } });
        e.webhooks.emit('organization_invitation.created', { id: i.id, organization_id: o.id, email_address: address, role: i.role, status: 'pending' });
        return { status: 201, body: e.shape('OrganizationInvitation', { object: 'organization_invitation', id: i.id, organization_id: o.id, email_address: address, role: i.role, status: 'pending', created_at: now }) };
      },
    },
  ];
}

/** Seat a user in an organization, with the change feed and webhook entries a real create makes. */
export function addMember(e: Engine, orgId: string, userId: string, role: string): Obj {
  const m = e.db.memberships.insert({ organization_id: orgId, user_id: userId, role, role_source: 'direct', created_at: e.clock.now() });
  e.changed({ type: 'organization_membership.created', data: presentMembership(e, m), resource: 'membership', id: m.id, op: 'create' });
  onMembershipChanged(e);
  return m;
}

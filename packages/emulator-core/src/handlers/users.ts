/* eslint-disable @typescript-eslint/no-explicit-any */
import { onMembershipChanged } from './authz-state';
import type { Engine, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { assertNotOnHold } from './support';
import { bump, listReply, merge, need } from './util';

export function presentUser(e: Engine, u: Obj): Obj {
  const emails = (u.emails as Obj[]).map((m) =>
    e.shape('EmailAddress', {
      object: 'email_address',
      id: m.id,
      email_address: m.email_address,
      verification: { status: m.verified ? 'verified' : 'unverified', strategy: m.verified ? 'admin' : null },
      verified: m.verified,
      primary: m.id === u.primary_email_address_id,
    }),
  );
  const primary = (u.emails as Obj[]).find((m) => m.id === u.primary_email_address_id);
  return e.shape('User', {
    object: 'user',
    id: u.id,
    username: u.username ?? null,
    first_name: u.first_name ?? null,
    last_name: u.last_name ?? null,
    image_url: u.image_url ?? null,
    email_addresses: emails,
    primary_email_address_id: u.primary_email_address_id ?? null,
    primary_email: primary?.verified ? primary.email_address : null,
    external_id: u.external_id ?? null,
    password_enabled: u.has_password === true,
    public_metadata: u.public_metadata ?? {},
    mfa_enabled: false,
    is_anonymous: false,
    banned: u.banned === true,
    ban_reason: u.ban_reason ?? null,
    locked: u.locked === true,
    created_at: u.created_at,
    updated_at: u.updated_at,
    version: u.version,
  });
}

const live = (e: Engine, id: string | undefined): Obj => {
  const u = e.db.users.get(id);
  if (!u || u.deleted) throw notFound('User');
  return u;
};

const emailTaken = (e: Engine, address: string, except?: string): boolean =>
  e.db.users.all().some((u) => !u.deleted && u.id !== except && (u.emails as Obj[]).some((m) => m.email_address.toLowerCase() === address.toLowerCase()));

export function usersHandlers(): RouteDef[] {
  const emit = (e: Engine, type: string, u: Obj, op: 'create' | 'update' | 'delete', data?: Obj) =>
    e.changed({ type, data: data ?? presentUser(e, u), resource: 'user', id: u.id, op });

  return [
    {
      method: 'GET',
      pattern: '/v1/users',
      handler: (c) => {
        const q = c.query;
        const email = q.get('email_address')?.toLowerCase();
        const username = q.get('username')?.toLowerCase();
        const external = q.get('external_id');
        const text = q.get('query')?.toLowerCase();
        const banned = q.get('banned');
        const users = c.engine.db.users.filter((u) => {
          if (u.deleted) return false;
          if (email && !(u.emails as Obj[]).some((m) => m.email_address.toLowerCase() === email)) return false;
          if (username && String(u.username ?? '').toLowerCase() !== username) return false;
          if (external && u.external_id !== external) return false;
          if (banned !== null && (u.banned === true) !== (banned === 'true')) return false;
          if (text) {
            const hay = [u.id, u.first_name, u.last_name, u.username, u.external_id, ...(u.emails as Obj[]).map((m) => m.email_address)].filter(Boolean).join(' ').toLowerCase();
            if (!hay.includes(text)) return false;
          }
          return true;
        });
        return listReply(c, users, (u) => presentUser(c.engine, u));
      },
    },
    {
      method: 'POST',
      pattern: '/v1/users',
      handler: (c) => {
        const e = c.engine;
        const raw = c.body.email_address;
        const addresses: string[] = raw === undefined ? [] : ([] as string[]).concat(raw);
        for (const a of addresses) {
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) throw new EmulatorError('VALIDATION_FAILED', `${a} is not an email address.`, 'email_address');
          if (emailTaken(e, a)) throw new EmulatorError('IDENTIFIER_EXISTS', `${a} is already in use.`, 'email_address');
        }
        if (c.body.username && e.db.users.all().some((u) => !u.deleted && String(u.username ?? '').toLowerCase() === String(c.body.username).toLowerCase())) {
          throw new EmulatorError('IDENTIFIER_EXISTS', 'That username is taken.', 'username');
        }
        if (c.body.external_id && e.db.users.all().some((u) => !u.deleted && u.external_id === c.body.external_id)) {
          throw new EmulatorError('EXTERNAL_ID_TAKEN', 'That external_id is taken.', 'external_id');
        }
        const now = e.clock.now();
        const verified = c.body.email_verified !== false;
        const emails = addresses.map((a) => ({ id: e.db.newId('idn'), email_address: a, verified }));
        const u = e.db.users.insert({
          username: c.body.username ?? null,
          first_name: c.body.first_name ?? null,
          last_name: c.body.last_name ?? null,
          image_url: c.body.image_url ?? null,
          external_id: c.body.external_id ?? null,
          emails,
          primary_email_address_id: emails[0]?.id ?? null,
          has_password: typeof c.body.password === 'string' || typeof c.body.password_hash === 'string' || typeof c.body.password_digest === 'string',
          // Test-only: lets the Frontend API mock sign this user in with a password. Never serialised.
          password_plain: typeof c.body.password === 'string' ? c.body.password : null,
          public_metadata: c.body.public_metadata ?? {},
          unsafe_metadata: c.body.unsafe_metadata ?? {},
          private_metadata: c.body.private_metadata ?? {},
          banned: false,
          locked: false,
          created_at: now,
          updated_at: now,
          version: 1,
        });
        emit(e, 'user.created', u, 'create');
        return { status: 201, body: presentUser(e, u) };
      },
    },
    { method: 'GET', pattern: '/v1/users/:id', handler: (c) => ({ body: presentUser(c.engine, live(c.engine, c.params.id)) }) },
    {
      method: 'PATCH',
      pattern: '/v1/users/:id',
      handler: (c) => {
        const e = c.engine;
        const u = live(e, c.params.id);
        for (const k of ['username', 'first_name', 'last_name', 'image_url', 'external_id']) if (k in c.body) u[k] = c.body[k];
        if ('public_metadata' in c.body) u.public_metadata = merge(u.public_metadata, c.body.public_metadata);
        if ('unsafe_metadata' in c.body) u.unsafe_metadata = merge(u.unsafe_metadata, c.body.unsafe_metadata);
        if ('private_metadata' in c.body) u.private_metadata = merge(u.private_metadata, c.body.private_metadata);
        if (typeof c.body.password === 'string') u.has_password = true;
        bump(e, u);
        emit(e, 'user.updated', u, 'update');
        return { body: presentUser(e, u) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/users/:id',
      handler: (c) => {
        const e = c.engine;
        const u = live(e, c.params.id);
        assertNotOnHold(e, u.id);
        u.deleted = true;
        for (const m of e.db.memberships.filter((x) => x.user_id === u.id)) {
          e.db.memberships.delete(m.id);
          e.changed({ type: 'organization_membership.deleted', data: { id: m.id, organization_id: m.organization_id, user_id: u.id }, resource: 'membership', id: m.id, op: 'delete' });
        }
        onMembershipChanged(e);
        emit(e, 'user.deleted', u, 'delete', { id: u.id, object: 'user', deleted: true });
        return { body: { object: 'user', id: u.id, deleted: true } };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/users/:id/metadata',
      handler: (c) => {
        const e = c.engine;
        const u = live(e, c.params.id);
        const bags = ['public_metadata', 'private_metadata', 'unsafe_metadata'].filter((k) => k in c.body);
        if (!bags.length) throw new EmulatorError('VALIDATION_FAILED', 'Send at least one metadata bag.');
        for (const k of bags) u[k] = c.body[k] ?? {};
        bump(e, u);
        emit(e, 'user.updated', u, 'update');
        return { body: presentUser(e, u) };
      },
    },
    ...(['ban', 'unban', 'lock', 'unlock'] as const).map<RouteDef>((action) => ({
      method: 'POST',
      pattern: `/v1/users/:id/${action}`,
      handler: (c) => {
        const e = c.engine;
        const u = live(e, c.params.id);
        if (action === 'ban') Object.assign(u, { banned: true, ban_reason: c.body.reason ?? null });
        if (action === 'unban') Object.assign(u, { banned: false, ban_reason: null });
        if (action === 'lock') u.locked = true;
        if (action === 'unlock') u.locked = false;
        bump(e, u);
        emit(e, 'user.updated', u, 'update');
        return { body: presentUser(e, u) };
      },
    })),
    {
      method: 'POST',
      pattern: '/v1/users/:id/email_addresses',
      handler: (c) => {
        const e = c.engine;
        const u = live(e, c.params.id);
        const address = String(need(c.body, 'email_address'));
        if (emailTaken(e, address)) throw new EmulatorError('IDENTIFIER_EXISTS', `${address} is already in use.`, 'email_address');
        const verified = c.body.verified === true;
        const m = { id: e.db.newId('idn'), email_address: address, verified };
        (u.emails as Obj[]).push(m);
        if (!u.primary_email_address_id && verified) u.primary_email_address_id = m.id;
        if (!verified) {
          const code = String(Math.floor(100000 + Math.random() * 900000));
          e.messages.send({ channel: 'email', to: address, subject: 'Verify your email address', body: `Your verification code is ${code}.`, code, meta: { user_id: u.id } });
        }
        bump(e, u);
        emit(e, 'user.updated', u, 'update');
        return { status: 201, body: e.shape('EmailAddress', { object: 'email_address', id: m.id, email_address: address, verification: { status: verified ? 'verified' : 'unverified', strategy: null }, verified, primary: u.primary_email_address_id === m.id }) };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/users/:id/organization_memberships',
      handler: (c) => {
        const e = c.engine;
        const u = live(e, c.params.id);
        return listReply(c, e.db.memberships.filter((m) => m.user_id === u.id), (m) => presentMembership(e, m));
      },
    },
  ];
}

export function presentMembership(e: Engine, m: Obj): Obj {
  return e.shape('OrganizationMembership', {
    object: 'organization_membership',
    id: m.id,
    organization_id: m.organization_id,
    user_id: m.user_id,
    role: m.role,
    role_source: m.role_source ?? 'direct',
    created_at: m.created_at,
  });
}

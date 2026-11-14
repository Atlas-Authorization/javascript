/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { bump, listReply, need } from './util';

export function presentKey(e: Engine, k: Obj): Obj {
  return e.shape('ApiKey', {
    object: 'api_key',
    id: k.id,
    subject_type: k.subject_type,
    subject_id: k.subject_id,
    name: k.name ?? null,
    prefix: k.prefix,
    claims: k.claims ?? {},
    scopes: k.scopes ?? null,
    constraints: k.constraints ?? null,
    enabled: k.enabled !== false,
    rate_limit: k.rate_limit ?? null,
    remaining: k.remaining ?? null,
    last_used_at: k.last_used_at ?? null,
    expires_at: k.expires_at ?? null,
    revoked_at: k.revoked_at ?? null,
    created_at: k.created_at,
  });
}

const liveKey = (e: Engine, id: string | undefined): Obj => {
  const k = e.db.apiKeys.get(id);
  if (!k) throw notFound('API key');
  return k;
};

const subjectExists = (e: Engine, type: string, id: string): boolean => {
  if (type === 'user') return !!e.db.users.get(id) && !e.db.users.get(id)?.deleted;
  if (type === 'organization') return !!e.db.organizations.get(id) && !e.db.organizations.get(id)?.deleted;
  if (type === 'machine') return !!e.db.machines.get(id) && !e.db.machines.get(id)?.deleted;
  return false;
};

export function keysHandlers(): RouteDef[] {
  const kEvent = (e: Engine, type: string, k: Obj, op: 'create' | 'update' | 'delete') => e.changed({ type, data: presentKey(e, k), resource: 'api_key', id: k.id, op });
  return [
    {
      method: 'GET',
      pattern: '/v1/api_keys',
      handler: (c) => {
        const t = c.query.get('subject_type');
        const s = c.query.get('subject_id');
        return listReply(c, c.engine.db.apiKeys.filter((k) => (!t || k.subject_type === t) && (!s || k.subject_id === s)), (k) => presentKey(c.engine, k));
      },
    },
    {
      method: 'POST',
      pattern: '/v1/api_keys',
      handler: (c) => {
        const e = c.engine;
        const type = String(need(c.body, 'subject_type'));
        const subject = String(need(c.body, 'subject_id'));
        if (!['user', 'organization', 'machine'].includes(type)) throw new EmulatorError('VALIDATION_FAILED', 'subject_type must be user, organization or machine.', 'subject_type');
        if (!subjectExists(e, type, subject)) throw new EmulatorError('NOT_FOUND', `The ${type} was not found.`, 'subject_id');
        const now = e.clock.now();
        const prefix = typeof c.body.prefix === 'string' ? c.body.prefix : 'ak';
        const secret = e.tokens.secret(prefix);
        const k = e.db.apiKeys.insert({
          subject_type: type,
          subject_id: subject,
          name: c.body.name ?? null,
          prefix: secret.slice(0, prefix.length + 5),
          secret,
          claims: c.body.claims ?? {},
          scopes: c.body.scopes ?? null,
          constraints: c.body.constraints ?? null,
          enabled: c.body.enabled !== false,
          rate_limit: c.body.rate_limit ?? null,
          remaining: typeof c.body.remaining === 'number' ? c.body.remaining : null,
          last_used_at: null,
          expires_at: typeof c.body.expires_at === 'number' ? c.body.expires_at : typeof c.body.expires_in_seconds === 'number' ? now + c.body.expires_in_seconds * 1000 : null,
          revoked_at: null,
          created_at: now,
        });
        kEvent(e, 'api_key.created', k, 'create');
        return { status: 201, body: { ...presentKey(e, k), secret } };
      },
    },
    { method: 'GET', pattern: '/v1/api_keys/:id', handler: (c) => ({ body: presentKey(c.engine, liveKey(c.engine, c.params.id)) }) },
    {
      method: 'PATCH',
      pattern: '/v1/api_keys/:id',
      handler: (c) => {
        const e = c.engine;
        const k = liveKey(e, c.params.id);
        for (const f of ['name', 'claims', 'scopes', 'constraints', 'enabled', 'rate_limit', 'remaining', 'expires_at']) if (f in c.body) k[f] = c.body[f];
        bump(e, k);
        kEvent(e, 'api_key.updated', k, 'update');
        return { body: presentKey(e, k) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/api_keys/:id',
      handler: (c) => {
        const e = c.engine;
        const k = liveKey(e, c.params.id);
        if (!k.revoked_at) {
          k.revoked_at = e.clock.now();
          kEvent(e, 'api_key.revoked', k, 'update');
        }
        return { body: presentKey(e, k) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/api_keys/verify',
      handler: (c) => {
        const e = c.engine;
        const secret = String(need(c.body, 'secret'));
        const k = e.db.apiKeys.find((x) => x.secret === secret);
        const now = e.clock.now();
        const invalid = (extra: Obj = {}) => ({ body: { object: 'api_key_verification', valid: false, ...extra } });
        if (!k || k.revoked_at || k.enabled === false || (k.expires_at && k.expires_at <= now) || !subjectExists(e, k.subject_type, k.subject_id)) return invalid();
        const required: string[] = c.body.required_scopes ?? [];
        const have: string[] = k.scopes ?? [];
        if (required.some((s) => !have.includes(s) && !have.includes('*'))) return invalid({ code: 'insufficient_scope', id: k.id });
        if (k.remaining !== null && k.remaining !== undefined) {
          if (k.remaining <= 0) return invalid({ code: 'usage_exhausted', id: k.id });
          k.remaining -= 1;
        }
        k.last_used_at = now;
        return {
          body: e.shape('ApiKeyVerificationValid', {
            object: 'api_key_verification',
            valid: true,
            id: k.id,
            subject_type: k.subject_type,
            subject_id: k.subject_id,
            name: k.name ?? null,
            claims: k.claims ?? {},
            scopes: k.scopes ?? null,
            effective_scopes: k.scopes ?? [],
            last_used_at: k.last_used_at,
            expires_at: k.expires_at ?? null,
          }),
        };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/api_keys/revoked',
      handler: (c) => {
        const since = Number(c.query.get('since') ?? 0) || 0;
        const rows = c.engine.db.apiKeys.filter((k) => k.revoked_at && k.revoked_at > since);
        return listReply(c, rows, (k) => c.engine.shape('RevokedApiKey', { object: 'api_key', id: k.id, revoked_at: k.revoked_at }));
      },
    },
  ];
}

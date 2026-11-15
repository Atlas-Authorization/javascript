/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import { FEED_RESOURCES, type FeedResource } from '../feed';
import type { Obj } from '../openapi';
import { presentKey } from './keys';
import { presentGrant, presentMachine } from './machines';
import { presentInvitation, presentOrg } from './orgs';
import { presentMembership, presentUser } from './users';
import { parseEndpointExtras, presentEndpointExtras } from '../webhook-ext';
import { listReply, merge, need } from './util';

function presentEndpoint(e: Engine, ep: Obj): Obj {
  return e.shape('WebhookEndpoint', {
    object: 'webhook_endpoint',
    id: ep.id,
    url: ep.url,
    description: ep.description ?? null,
    enabled_events: ep.enabled_events,
    event_naming: ep.event_naming ?? 'canonical',
    active: ep.active !== false,
    signature_versions: ['v1'],
    failing_since: ep.failing_since ?? null,
    last_success_at: ep.last_success_at ?? null,
    last_failure: ep.last_failure ?? null,
    consecutive_failures: ep.consecutive_failures ?? 0,
    ...presentEndpointExtras(ep),
  });
}

/** What the change feed and its snapshots read: current state per feed resource. */
export function installPresenters(e: Engine): void {
  const live = <T extends Obj>(rows: T[]) => rows.filter((r) => !r.deleted);
  const set = (type: FeedResource, rows: () => Obj[], present: (r: Obj) => Obj) =>
    e.presenters.set(type, {
      one: (id) => {
        const r = rows().find((x) => x.id === id);
        return r ? present(r) : null;
      },
      all: () => rows().map((r) => r.id).sort(),
    });
  set('user', () => live(e.db.users.all()), (r) => presentUser(e, r));
  set('organization', () => live(e.db.organizations.all()), (r) => presentOrg(e, r));
  set('membership', () => e.db.memberships.all(), (r) => presentMembership(e, r));
  set('invitation', () => e.db.invitations.all(), (r) => presentInvitation(e, r));
  set('role_assignment', () => [], () => ({}));
  set('api_key', () => e.db.apiKeys.all(), (r) => presentKey(e, r));
  set('machine', () => live(e.db.machines.all()), (r) => presentMachine(e, r));
  set('machine_grant', () => e.db.grants.all(), (r) => presentGrant(e, r));
}

const CONSUMER = /^[A-Za-z0-9._-]{1,64}$/;
const consumers = new WeakMap<Engine, Map<string, { seq: number | null; updated_at: number | null }>>();
const consumerMap = (e: Engine) => {
  let m = consumers.get(e);
  if (!m) consumers.set(e, (m = new Map()));
  return m;
};
export const resetConsumers = (e: Engine): void => void consumers.delete(e);

export function hooksHandlers(): RouteDef[] {
  const consumerBody = (e: Engine, key: string, name: string): Obj => {
    const c = consumerMap(e).get(`${key}|${name}`);
    const seq = c?.seq ?? null;
    return { object: 'change_consumer', name, seq, updated_at: c?.updated_at ?? null, head_seq: e.feed.head, lag: e.feed.head - (seq ?? 0) };
  };
  const intParam = (v: string | null, name: string, def: number, min: number, max: number): number => {
    if (v === null) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new EmulatorError('VALIDATION_FAILED', `${name} must be an integer from ${min} to ${max}.`, name);
    return n;
  };

  return [
    // Webhook endpoints
    { method: 'GET', pattern: '/v1/webhook_endpoints', handler: (c) => listReply(c, c.engine.db.endpoints.all(), (x) => presentEndpoint(c.engine, x)) },
    {
      method: 'POST',
      pattern: '/v1/webhook_endpoints',
      handler: (c) => {
        const e = c.engine;
        const url = String(need(c.body, 'url'));
        try {
          if (!/^https?:$/.test(new URL(url).protocol)) throw new Error('scheme');
        } catch {
          throw new EmulatorError('VALIDATION_FAILED', 'url must be an http(s) URL.', 'url');
        }
        const events: string[] = c.body.enabled_events ?? ['*'];
        if (!events.length) throw new EmulatorError('VALIDATION_FAILED', 'enabled_events cannot be empty.', 'enabled_events');
        const secret = typeof c.body.secret === 'string' ? c.body.secret : e.webhooks.newSecret();
        const ep = e.db.endpoints.insert({ ...parseEndpointExtras(c.body), url, description: c.body.description ?? null, enabled_events: events, active: c.body.active !== false, event_naming: c.body.event_naming ?? 'canonical', secret, consecutive_failures: 0, created_at: e.clock.now() });
        return { status: 201, body: { ...presentEndpoint(e, ep), secret } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/webhook_endpoints/:id',
      handler: (c) => {
        const ep = c.engine.db.endpoints.get(c.params.id);
        if (!ep) throw notFound('Webhook endpoint');
        return { body: presentEndpoint(c.engine, ep) };
      },
    },
    {
      method: 'PATCH',
      pattern: '/v1/webhook_endpoints/:id',
      handler: (c) => {
        const ep = c.engine.db.endpoints.get(c.params.id);
        if (!ep) throw notFound('Webhook endpoint');
        for (const k of ['url', 'description', 'enabled_events', 'active', 'event_naming']) if (k in c.body) ep[k] = c.body[k];
        Object.assign(ep, parseEndpointExtras(c.body, ep));
        if (c.body.active === true) Object.assign(ep, { consecutive_failures: 0, failing_since: null });
        return { body: presentEndpoint(c.engine, ep) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/webhook_endpoints/:id',
      handler: (c) => {
        if (!c.engine.db.endpoints.delete(c.params.id ?? '')) throw notFound('Webhook endpoint');
        return { body: { object: 'webhook_endpoint', id: c.params.id, deleted: true } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/webhook_endpoints/:id/deliveries',
      handler: (c) => {
        const id = c.params.id ?? '';
        if (!c.engine.db.endpoints.get(id)) throw notFound('Webhook endpoint');
        const rows = c.engine.webhooks.deliveries.filter((d) => d.endpoint_id === id).reverse();
        return listReply(c, rows, (d) => ({ object: 'webhook_delivery', ...d }));
      },
    },
    {
      method: 'POST',
      pattern: '/v1/webhook_endpoints/:id/rotate_secret',
      handler: (c) => {
        const ep = c.engine.db.endpoints.get(c.params.id);
        if (!ep) throw notFound('Webhook endpoint');
        ep.secret = c.engine.webhooks.newSecret();
        return { body: { ...presentEndpoint(c.engine, ep), secret: ep.secret } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/webhook_endpoints/:id/reveal_secret',
      handler: (c) => {
        const ep = c.engine.db.endpoints.get(c.params.id);
        if (!ep) throw notFound('Webhook endpoint');
        return { body: { object: 'webhook_endpoint_secret', secret: ep.secret } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/webhook_endpoints/:id/test',
      handler: async (c) => {
        const e = c.engine;
        const ep = e.db.endpoints.get(c.params.id);
        if (!ep) throw notFound('Webhook endpoint');
        const ev = e.webhooks.emit('webhook.test', { object: 'webhook_test', endpoint_id: ep.id });
        await e.flush();
        const last = e.webhooks.deliveries.filter((d) => d.endpoint_id === ep.id && d.event_id === ev.id).pop();
        return { body: { object: 'webhook_test', event_id: ev.id, delivered: last?.success ?? false, response_status: last?.response_status ?? null } };
      },
    },
    ...(['redeliver', 'replay'] as const).map<RouteDef>((action) => ({
      method: 'POST',
      pattern: `/v1/webhook_endpoints/:id/${action}`,
      handler: async (c) => {
        const e = c.engine;
        const ep = e.db.endpoints.get(c.params.id);
        if (!ep) throw notFound('Webhook endpoint');
        const status = c.body.status === 'success' ? true : false;
        const since = typeof c.body.since === 'number' ? c.body.since : 0;
        const ids = [...new Set(e.webhooks.deliveries.filter((d) => d.endpoint_id === ep.id && d.success === status && d.at >= since).map((d) => d.event_id))];
        for (const id of ids) await e.webhooks.redeliver(ep.id, id);
        return { body: { object: 'webhook_redelivery', count: ids.length } };
      },
    })),
    // Events
    {
      method: 'GET',
      pattern: '/v1/events',
      handler: (c) => {
        const types = c.query.get('types')?.split(',').filter(Boolean);
        const rows = [...c.engine.webhooks.events].reverse().filter((ev) => !types || types.includes(ev.type));
        return listReply(c, rows, (ev) => ({ object: 'event', id: ev.id, type: ev.type, payload: ev.payload, created_at: ev.created_at }));
      },
    },
    // Change feed
    {
      method: 'GET',
      pattern: '/v1/changes',
      scope: 'events:read',
      handler: (c) => {
        const e = c.engine;
        const after = intParam(c.query.get('after'), 'after', 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = intParam(c.query.get('limit'), 'limit', 100, 1, 500);
        const types = c.query.get('types')?.split(',').filter(Boolean);
        for (const t of types ?? []) if (!(FEED_RESOURCES as readonly string[]).includes(t)) throw new EmulatorError('VALIDATION_FAILED', `Unknown resource type ${t}.`, 'types');
        if (after > e.feed.head) throw new EmulatorError('VALIDATION_FAILED', 'after is beyond the head of the feed.', 'after');
        if (after < e.feed.retentionFloorSeq) throw new EmulatorError('RESYNC_REQUIRED', 'That position was trimmed; take a snapshot and resume from it.');
        const matching = e.feed.entries.filter((x) => x.seq > after && (!types || types.includes(x.resource_type)));
        const page = matching.slice(0, limit);
        const hasMore = matching.length > limit;
        return {
          body: {
            object: 'list',
            data: page.map((x) => e.feed.present(x)),
            has_more: hasMore,
            next_after: hasMore ? (page[page.length - 1]?.seq ?? after) : e.feed.head,
            head_seq: e.feed.head,
            retention_floor_seq: e.feed.retentionFloorSeq,
          },
        };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/changes/snapshot/:resource_type',
      scope: 'events:read',
      handler: (c) => {
        const e = c.engine;
        const type = c.params.resource_type as FeedResource;
        if (!(FEED_RESOURCES as readonly string[]).includes(type)) throw new EmulatorError('VALIDATION_FAILED', `Unknown resource type ${type}.`, 'resource_type');
        const limit = intParam(c.query.get('limit'), 'limit', 100, 1, 200);
        const cursor = c.query.get('cursor');
        let pinned = e.feed.head;
        let offset = 0;
        if (cursor) {
          const m = /^(\d+):(\d+)$/.exec(cursor);
          if (!m) throw new EmulatorError('VALIDATION_FAILED', 'The cursor is not valid.', 'cursor');
          pinned = Number(m[1]);
          offset = Number(m[2]);
        }
        const pres = e.presenters.get(type);
        const ids = pres?.all() ?? [];
        const slice = ids.slice(offset, offset + limit);
        const hasMore = offset + limit < ids.length;
        return {
          body: {
            object: 'list',
            resource_type: type,
            data: slice.map((id) => pres?.one(id)).filter((x): x is Obj => !!x),
            has_more: hasMore,
            next_cursor: hasMore ? `${pinned}:${offset + limit}` : null,
            snapshot_seq: pinned,
            head_seq: e.feed.head,
            retention_floor_seq: e.feed.retentionFloorSeq,
          },
        };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/changes/consumers',
      scope: 'events:read',
      handler: (c) => {
        const e = c.engine;
        const data = [...consumerMap(e).entries()].map(([k, v]) => {
          const i = k.indexOf('|');
          return { object: 'change_consumer', name: k.slice(i + 1), key_id: k.slice(0, i), seq: v.seq, updated_at: v.updated_at, head_seq: e.feed.head, lag: Math.max(0, e.feed.head - (v.seq ?? 0)) };
        });
        return { body: { object: 'list', data, has_more: false } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/changes/consumers/:name',
      scope: 'events:read',
      handler: (c) => {
        if (!CONSUMER.test(c.params.name ?? '')) throw new EmulatorError('VALIDATION_FAILED', 'The consumer name is not valid.', 'name');
        return { body: consumerBody(c.engine, c.key?.key ?? '', c.params.name ?? '') };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/changes/consumers/:name/ack',
      scope: 'events:read',
      handler: (c) => {
        const e = c.engine;
        const name = c.params.name ?? '';
        if (!CONSUMER.test(name)) throw new EmulatorError('VALIDATION_FAILED', 'The consumer name is not valid.', 'name');
        const seq = need(c.body, 'seq');
        if (!Number.isInteger(seq) || seq < 0) throw new EmulatorError('VALIDATION_FAILED', 'seq must be a non-negative integer.', 'seq');
        if (seq > e.feed.head) throw new EmulatorError('VALIDATION_FAILED', 'seq is beyond the head of the feed.', 'seq');
        const map = consumerMap(e);
        const k = `${c.key?.key ?? ''}|${name}`;
        const cur = map.get(k);
        if (!cur || seq > (cur.seq ?? 0)) map.set(k, merge(cur, { seq, updated_at: e.clock.now() }) as { seq: number; updated_at: number });
        return { body: consumerBody(e, c.key?.key ?? '', name) };
      },
    },
  ];
}

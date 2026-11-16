import type { Engine, RouteDef } from '../engine';
import { EmulatorError } from '../errors';
import type { Obj } from '../openapi';
import { randomToken, Table } from '../store';
import { engineState } from './support';

/** Custom domains (path mounts): add one, read it, remove it, and rotate its verification token (the old one stays valid 24 hours). */
const GRACE_MS = 24 * 3600 * 1000;
const ds = engineState((e: Engine) => new Table('custom_domains', e.clock.now, 'dom'));

const fileUrl = (host: string, token: string): string => `https://${host}/.well-known/atlas-verify/${token}`;

function view(row: Obj, now: number): Obj {
  const live = typeof row.previous_token === 'string' && (row.previous_until as number) > now;
  return {
    object: 'custom_domain',
    id: row.id,
    role: row.role,
    host: row.host,
    status: 'pending_verification',
    live: false,
    method: 'path',
    cname_target: null,
    base_path: row.base_path,
    failure_reason: null,
    verification: {
      method: 'https_file',
      url: fileUrl(row.host as string, row.token as string),
      token: row.token,
      content: row.token,
      instructions: `Serve a file at ${fileUrl(row.host as string, row.token as string)} whose whole body is the token, then call POST /v1/domains/${row.id}/verify.`,
      ...(live ? { previous_url: fileUrl(row.host as string, row.previous_token as string), previous_valid_until: row.previous_until } : {}),
      last_observation: null,
    },
  };
}

export function domainsHandlers(): RouteDef[] {
  const find = (e: Engine, id: string | undefined): Obj => {
    const row = ds(e).get(id);
    if (!row) throw new EmulatorError('NOT_FOUND', 'Unknown domain.');
    return row;
  };
  return [
    { method: 'GET', pattern: '/v1/domains', scope: 'domains:read', handler: (c) => ({ body: { object: 'list', data: ds(c.engine).all().map((r) => view(r, c.engine.clock.now())), has_more: false } }) },
    {
      method: 'POST',
      pattern: '/v1/domains',
      scope: 'domains:write',
      handler: (c) => {
        const host = typeof c.body.hostname === 'string' ? c.body.hostname : c.body.host;
        const basePath = typeof c.body.base_path === 'string' ? c.body.base_path : '';
        if (typeof host !== 'string' || !host) throw new EmulatorError('VALIDATION_FAILED', 'A hostname is required.', 'hostname');
        const row = ds(c.engine).insert({ role: 'fapi', host: host.toLowerCase(), base_path: basePath, token: randomToken(24), previous_token: null, previous_until: null });
        return { status: 201, body: view(row, c.engine.clock.now()) };
      },
    },
    { method: 'GET', pattern: '/v1/domains/:id', scope: 'domains:read', handler: (c) => ({ body: view(find(c.engine, c.params.id), c.engine.clock.now()) }) },
    {
      method: 'DELETE',
      pattern: '/v1/domains/:id',
      scope: 'domains:write',
      handler: (c) => {
        const row = find(c.engine, c.params.id);
        ds(c.engine).delete(row.id as string);
        return { body: { object: 'custom_domain', id: row.id, deleted: true } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/domains/:id/verification/rotate',
      scope: 'domains:write',
      handler: (c) => {
        const row = find(c.engine, c.params.id);
        const now = c.engine.clock.now();
        Object.assign(row, { previous_token: row.token, previous_until: now + GRACE_MS, token: randomToken(24) });
        return { body: view(row, now) };
      },
    },
  ];
}

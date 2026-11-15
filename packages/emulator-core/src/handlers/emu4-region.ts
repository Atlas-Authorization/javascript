/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, Reply, RouteDef } from '../engine';
import { errorBody } from '../errors';
import type { Obj } from '../openapi';
import { engineState } from './support';
import { audit, bad, isObj } from './emu4-shared';

/**
 * Regional readiness. A single-region deployment (the default) has no regions: nothing is pinned, refused or rerouted. A
 * deployment with a region table (`PUT /__emulator/region/config`) can pin the instance to the region of the stack answering, name
 * a failover region and isolate the Frontend API origin. A pin is a statement about where the data is: it is only ever set to
 * this stack's region and there is no unpin (moving between regions is an export and an import). The stack answering a pinned
 * instance from another region refuses with 421 WRONG_REGION naming the region that serves it. shortcut: the guard sits on the
 * region routes only; the rest of the emulator answers whatever stack it is told it is.
 */
const REGION_ID = /^[a-z][a-z0-9-]{1,19}$/;
const STATUSES = ['active', 'standby', 'draining'];

interface Region { id: string; label: string; fapi_origin: string | null; bapi_origin: string | null; status: string; failover_to: string | null }
interface State {
  self: string | null;
  regions: Region[];
  isolationDefault: 'off' | 'enforce';
  frontendApiHost: string;
  region: string | null;
  failoverRegion: string | null;
  fapiIsolation: 'off' | 'enforce' | null;
}
const st = engineState((): State => ({ self: null, regions: [], isolationDefault: 'off', frontendApiHost: 'emulator-fapi.atlas.invalid', region: null, failoverRegion: null, fapiIsolation: null }));

const isUrl = (v: unknown): boolean => {
  if (typeof v !== 'string') return false;
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
};

/** Validate a region table like the deployment setting: readable issues, unique ids, failover pointing at another listed region. */
function parseTable(self: unknown, raw: unknown): { self: string | null; regions: Region[] } {
  if (self !== null && self !== undefined && (typeof self !== 'string' || !REGION_ID.test(self))) throw bad('self is a region id such as "eu" or null (one region).', 'self');
  const list = raw === undefined ? [] : raw;
  if (!Array.isArray(list)) throw bad('regions must be an array.', 'regions');
  if (list.length > 32) throw bad('At most 32 regions.', 'regions');
  const regions: Region[] = list.map((r: unknown, i) => {
    const e = isObj(r) ? r : {};
    if (typeof e.id !== 'string' || !REGION_ID.test(e.id)) throw bad(`regions.${i}.id is not a valid region id.`, 'regions');
    if (e.label !== undefined && (typeof e.label !== 'string' || e.label.length < 1 || e.label.length > 80)) throw bad(`regions.${i}.label must be 1-80 characters.`, 'regions');
    for (const k of ['fapi_origin', 'bapi_origin']) if (e[k] != null && !isUrl(e[k])) throw bad(`regions.${i}.${k} must be a URL.`, 'regions');
    if (e.failover_to != null && (typeof e.failover_to !== 'string' || !REGION_ID.test(e.failover_to))) throw bad(`regions.${i}.failover_to is not a valid region id.`, 'regions');
    const status = e.status ?? 'active';
    if (!STATUSES.includes(status as string)) throw bad(`regions.${i}.status must be one of ${STATUSES.join(', ')}.`, 'regions');
    return { id: e.id, label: (e.label as string | undefined) ?? e.id, fapi_origin: typeof e.fapi_origin === 'string' ? e.fapi_origin.replace(/\/$/, '') : null, bapi_origin: typeof e.bapi_origin === 'string' ? e.bapi_origin.replace(/\/$/, '') : null, status: status as string, failover_to: (e.failover_to as string | undefined) ?? null };
  });
  const ids = new Set(regions.map((r) => r.id));
  if (ids.size !== regions.length) throw bad('The region table lists a region id twice.', 'regions');
  for (const r of regions) if (r.failover_to && (!ids.has(r.failover_to) || r.failover_to === r.id)) throw bad(`Region ${r.id} fails over to ${r.failover_to}, which is not another listed region.`, 'regions');
  if (self && regions.length > 0 && !ids.has(self as string)) throw bad(`The region table does not list this stack's own region (${self}).`, 'regions');
  return { self: (self as string | null | undefined) ?? null, regions };
}

/** May this stack serve the instance? Yes with no region configured, no pin, a pin to this region, or this stack as its failover. */
function decision(s: State): { ok: true } | { ok: false; pinned: string; region: string; fapi_origin: string | null; bapi_origin: string | null } {
  if (!s.self || !s.region || s.region === s.self || s.failoverRegion === s.self) return { ok: true };
  const home = s.regions.find((r) => r.id === s.region);
  return { ok: false, pinned: s.region, region: s.region, fapi_origin: home?.fapi_origin ?? null, bapi_origin: home?.bapi_origin ?? null };
}

const wrongRegion = (d: Extract<ReturnType<typeof decision>, { ok: false }>): Reply => ({ status: 421, body: errorBody([{ code: 'WRONG_REGION', message: `This instance is served from the ${d.pinned} region. Send the request there.`, meta: { region: d.region, fapi_origin: d.fapi_origin, bapi_origin: d.bapi_origin } }]) });

const view = (s: State): Obj => ({
  object: 'region_status',
  region: s.region,
  pinned: !!s.region,
  serving_region: s.self,
  regions_enabled: !!s.self,
  failover_region: s.failoverRegion,
  fapi_isolation: s.fapiIsolation,
  effective_fapi_isolation: s.fapiIsolation ?? s.isolationDefault,
  regions: s.regions.map((r) => ({ id: r.id, label: r.label, status: r.status, fapi_origin: r.fapi_origin, bapi_origin: r.bapi_origin, failover_to: r.failover_to, self: r.id === s.self })),
});

const BASE_PATH = /^(\/[a-z0-9_~-][a-z0-9._~-]{0,63}){1,4}$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function regionHandlers(): RouteDef[] {
  const guard = (e: Engine): Reply | null => {
    const d = decision(st(e));
    return d.ok ? null : wrongRegion(d);
  };
  return [
    { method: 'GET', pattern: '/v1/region', scope: 'instance:read', handler: (c) => guard(c.engine) ?? { body: view(st(c.engine)) } },
    { method: 'PUT', pattern: '/v1/region', scope: 'instance:write', handler: (c) => {
      const e = c.engine;
      const refused = guard(e);
      if (refused) return refused;
      const s = st(e);
      const b = c.body;
      const before = { region: s.region, failover_region: s.failoverRegion, fapi_isolation: s.fapiIsolation };
      const set: Obj = {};
      if (b.pin !== undefined) {
        if (typeof b.pin !== 'boolean') throw bad('pin must be true or false.', 'pin');
        if (!b.pin) throw bad("A pinned instance cannot be unpinned: its data lives in its region. Moving it is an export and an import.", 'pin');
        if (!s.self) throw bad('This deployment has no region configured, so there is nothing to pin to.', 'pin');
        set.region = s.self;
      }
      const regionAfter = (set.region as string | undefined) ?? s.region;
      if (b.failover_region !== undefined) {
        if (b.failover_region === null) set.failoverRegion = null;
        else {
          if (typeof b.failover_region !== 'string' || !s.regions.some((r) => r.id === b.failover_region)) throw bad(`failover_region must be null or one of: ${s.regions.map((r) => r.id).join(', ') || '(no regions configured)'}.`, 'failover_region');
          if (!regionAfter) throw bad('Pin the instance to a region before naming its failover region.', 'failover_region');
          if (b.failover_region === regionAfter) throw bad("The failover region must differ from the instance's own region.", 'failover_region');
          set.failoverRegion = b.failover_region;
        }
      }
      if (b.fapi_isolation !== undefined) {
        if (b.fapi_isolation !== null && b.fapi_isolation !== 'off' && b.fapi_isolation !== 'enforce') throw bad('fapi_isolation must be null (the deployment default), "off" or "enforce".', 'fapi_isolation');
        set.fapiIsolation = b.fapi_isolation;
      }
      if (Object.keys(set).length === 0) throw bad('Send at least one of pin, failover_region or fapi_isolation.');
      Object.assign(s, set);
      audit(e, c, 'instance.region_updated', 'instance', e.instanceId, { before, after: set });
      return { body: view(s) };
    } },
    { method: 'GET', pattern: '/v1/region/failover', scope: 'instance:read', handler: (c) => {
      const e = c.engine;
      const refused = guard(e);
      if (refused) return refused;
      const s = st(e);
      const mountHost = String(c.query.get('mount_host') ?? '').trim().toLowerCase().replace(/\.$/, '');
      if (!HOST.test(mountHost) || mountHost.length > 253) throw bad('mount_host must be the host your reverse proxy serves, such as app.example.com.', 'mount_host');
      const rawBase = c.query.get('base_path');
      const basePath = rawBase === null || rawBase === '' ? '/__atlas' : rawBase;
      if (!BASE_PATH.test(basePath)) throw bad('base_path must start with "/", have 1 to 4 segments of lowercase letters, digits, "_", "-" or "~" (a "." is allowed after the first character), and no trailing slash. Example: "/__atlas".', 'base_path');
      const fail = (message: string): Reply => ({ status: 422, body: errorBody([{ code: 'VALIDATION_FAILED', message }]) });
      if (!s.failoverRegion) return fail('This instance has no failover region. Set one with PUT /v1/region.');
      const host = s.frontendApiHost.split('/')[0]!;
      const standby = s.regions.find((r) => r.id === s.failoverRegion)?.fapi_origin;
      if (!standby) return fail("The failover region has no Frontend API origin in this deployment's region table.");
      const upstreams = [
        { role: 'primary', region: s.region ?? s.self, origin: `https://${host}`, host },
        { role: 'failover', region: s.failoverRegion, origin: standby, host },
      ];
      const standbyHost = new URL(standby).host;
      const nginx = ['upstream atlas_fapi {', `  server ${host}:443;`, `  server ${standbyHost} backup;`, '}', '', `location ${basePath}/ {`, '  proxy_pass https://atlas_fapi;   # no URI part: the path is kept', `  proxy_set_header Host ${host};`, '  proxy_ssl_server_name on;', `  proxy_ssl_name ${host};`, '  # Fail over on a dead or erroring upstream, never on a 4xx (a 421 means "wrong region", not "down").', '  proxy_next_upstream error timeout http_502 http_503 http_504;', '  proxy_next_upstream_tries 2;', '}'].join('\n');
      const caddy = [`handle ${basePath}/* {`, `  reverse_proxy ${upstreams[0]!.origin} ${standby} {`, '    lb_policy first', '    lb_try_duration 5s', '    fail_duration 30s', `    header_up Host ${host}`, '    transport http {', `      tls_server_name ${host}`, '    }', '  }', '}'].join('\n');
      return { body: { object: 'region_failover', mount_host: mountHost, base_path: basePath, upstreams, nginx, caddy } };
    } },

    // ── emulator helpers ──
    // PUT /__emulator/region/config { self, regions, fapi_isolation_default, frontend_api_host }: what the deployment is told (the region table and which stack this is).
    { method: 'PUT', pattern: '/__emulator/region/config', public: true, handler: (c) => {
      const s = st(c.engine);
      const b = c.body;
      const next = parseTable(b.self === undefined ? s.self : b.self, b.regions === undefined ? s.regions : b.regions);
      if (b.fapi_isolation_default !== undefined && b.fapi_isolation_default !== 'off' && b.fapi_isolation_default !== 'enforce') throw bad('fapi_isolation_default is off or enforce.', 'fapi_isolation_default');
      if (b.frontend_api_host !== undefined && (typeof b.frontend_api_host !== 'string' || !b.frontend_api_host)) throw bad('frontend_api_host is a host name.', 'frontend_api_host');
      s.self = next.self;
      s.regions = next.regions;
      if (b.fapi_isolation_default !== undefined) s.isolationDefault = b.fapi_isolation_default;
      if (b.frontend_api_host !== undefined) s.frontendApiHost = b.frontend_api_host as string;
      return { body: view(s) };
    } },
    // GET /__emulator/region/decision: would the stack answering serve this instance, or refuse it with 421?
    { method: 'GET', pattern: '/__emulator/region/decision', public: true, handler: (c) => {
      const d = decision(st(c.engine));
      return { body: d.ok ? { object: 'region_decision', serves: true } : { object: 'region_decision', serves: false, pinned: d.pinned, serve_from: { region: d.region, fapi_origin: d.fapi_origin, bapi_origin: d.bapi_origin } } };
    } },
  ];
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { MemoryConfigStore } from '../config';
import { captureIO } from '../io';
import { run } from '../run';

/** `atlas status`, driven through `run()` with an in-memory Atlas API. */

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atlas-cli-status-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const component = (id: string, status = 'operational') => ({ id, name: id, status, description: '', group: 'atlas', regions: ['eu'] });
const SERVICE = { object: 'status', status: 'operational', updated_at: 1, regions: ['eu'], groups: [], components: [component('frontend_api'), component('backend_api')], incidents: [] };
const SUB = {
  object: 'status_subscription',
  subscribed: true,
  enabled: true,
  regions: ['eu'],
  component_ids: [],
  min_impact: 'major',
  include_maintenance: true,
  email_owners: true,
  webhook: false,
  rss_url: 'https://x/feed.rss',
  atom_url: 'https://x/feed.atom',
  available_regions: ['eu'],
  available_components: [],
  updated_at: 1,
};
const DEP = { object: 'status_dependency', id: 'sdep_1', name: 'Mail Co', url: 'https://status.mail.test', component_filter: [], enabled: true, state: 'operational', stale: false, last_error: null };

function ctxWith(io: ReturnType<typeof captureIO>, answers: Record<string, unknown>, paths: string[]): RunContext {
  const http: ConfigHttp = {
    get: async (p) => {
      paths.push(p);
      return (answers[p] ?? {}) as never;
    },
    post: async () => ({}) as never,
    put: async () => ({}) as never,
    patch: async () => ({}) as never,
    delete: async () => undefined,
  };
  return {
    io,
    env: { XDG_CONFIG_HOME: home },
    config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.atlas.test', secret_key: 'sk_test_123456' } } }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: () => http,
    readFile: () => '',
    sleep: async () => undefined,
  };
}

describe('atlas status', () => {
  it('prints Atlas, the subscription and upstream pages; exit 0 when all is well', async () => {
    const io = captureIO();
    const paths: string[] = [];
    const code = await run(['status'], ctxWith(io, {
      '/v1/status': SERVICE,
      '/v1/instance/status_subscription': SUB,
      '/v1/instance/status_incidents?open=true': { data: [] },
      '/v1/instance/status_dependencies': { data: [DEP], state: 'operational' },
    }, paths));
    expect(code).toBe(0);
    const out = io.stdout();
    expect(out).toContain('Atlas:         operational');
    expect(out).toContain('Subscription:  eu; all components; impact ≥ major + maintenance (email, rss)');
    expect(out).toContain('No open Atlas incidents concern this instance.');
    expect(out).toContain('Mail Co');
    expect(paths.sort()).toEqual(['/v1/instance/status_dependencies', '/v1/instance/status_incidents?open=true', '/v1/instance/status_subscription', '/v1/status']);
  });

  it('exits 1 on a major Atlas incident or an upstream outage, and --json carries everything', async () => {
    const incident = { object: 'status_incident', id: 'sinc_1', kind: 'incident', title: 'EU errors', status: 'investigating', impact: 'major', regions: ['eu'], component_ids: [], updates: [] };
    let io = captureIO();
    let code = await run(['status'], ctxWith(io, {
      '/v1/status': SERVICE,
      '/v1/instance/status_subscription': { ...SUB, subscribed: false, enabled: false },
      '/v1/instance/status_incidents?open=true': { data: [incident] },
      '/v1/instance/status_dependencies': { data: [], state: 'unknown' },
    }, []));
    expect(code).toBe(1);
    expect(io.stdout()).toContain('EU errors');
    expect(io.stdout()).toContain('Subscription:  none');

    io = captureIO();
    code = await run(['status', '--json'], ctxWith(io, {
      '/v1/status': SERVICE,
      '/v1/instance/status_subscription': SUB,
      '/v1/instance/status_incidents?open=true': { data: [] },
      '/v1/instance/status_dependencies': { data: [{ ...DEP, state: 'major_outage' }], state: 'major_outage' },
    }, []));
    expect(code).toBe(1);
    const json = JSON.parse(io.stdout());
    expect(json.dependencies[0].state).toBe('major_outage');
    expect(json.service.status).toBe('operational');
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine } from './engine';
import { EmulatorError } from './errors';
import type { Obj } from './openapi';

/**
 * A scenario: named users, organizations (with members), roles and webhook endpoints, created in one call
 * through the same routes (and so the same validation, events and change-feed entries) as any other write.
 * `ref` names let later entries point at earlier ones; the result maps every ref to the created resource.
 */
export interface Scenario {
  users?: Array<{ ref?: string; email: string; first_name?: string; last_name?: string; password?: string; public_metadata?: Obj; external_id?: string }>;
  roles?: Array<{ ref?: string; key: string; name?: string; permissions?: string[] }>;
  organizations?: Array<{ ref?: string; name: string; slug?: string; created_by?: string; members?: Array<{ user: string; role?: string }>; public_metadata?: Obj }>;
  webhook_endpoints?: Array<{ ref?: string; url: string; enabled_events?: string[] }>;
}

export async function runScenario(engine: Engine, scenario: Scenario): Promise<{ refs: Record<string, Obj> }> {
  const key = engine.keys.find((k) => k.scopes === null)?.key ?? engine.keys[0]?.key;
  const call = async (method: string, path: string, body?: Obj): Promise<Obj> => {
    const res = await engine.handle(new Request(`http://emulator.invalid${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }));
    const json = (await res.json().catch(() => ({}))) as Obj;
    if (!res.ok) throw new EmulatorError(json.errors?.[0]?.code ?? 'VALIDATION_FAILED', `Scenario step ${method} ${path} failed: ${json.errors?.[0]?.message ?? res.status}`);
    return json;
  };
  const refs: Record<string, Obj> = {};
  const resolve = (v: string | undefined): string | undefined => (v && refs[v] ? (refs[v].id as string) : v);

  for (const { ref, email, ...u } of scenario.users ?? []) {
    const created = await call('POST', '/v1/users', { email_address: email, ...u });
    refs[ref ?? email] = created;
  }
  for (const { ref, ...r } of scenario.roles ?? []) {
    const created = await call('POST', '/v1/roles', r);
    refs[ref ?? r.key] = created;
  }
  for (const { ref, members, created_by, ...o } of scenario.organizations ?? []) {
    const created = await call('POST', '/v1/organizations', { ...o, ...(created_by ? { created_by: resolve(created_by) } : {}) });
    refs[ref ?? o.name] = created;
    for (const m of members ?? []) {
      const uid = resolve(m.user);
      // A creator is already seated; seating them twice is a conflict, not a scenario error.
      if (uid === resolve(created_by)) continue;
      await call('POST', `/v1/organizations/${created.id}/memberships`, { user_id: uid, role: m.role ?? 'org:member' });
    }
  }
  for (const { ref, ...w } of scenario.webhook_endpoints ?? []) {
    const created = await call('POST', '/v1/webhook_endpoints', w);
    refs[ref ?? w.url] = created;
  }
  return { refs };
}

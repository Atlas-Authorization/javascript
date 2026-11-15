/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteDef } from '../engine';
import { notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table } from '../store';
import { engineState } from './support';
import { actorOf, audit, bad, canonical, conflict, hex, instanceConfig, isObj, pageReply } from './emu4-shared';
import { configProblems } from './emu4-config';

/**
 * Config time travel. A snapshot is the instance's configuration at one moment with every secret removed: the last-written
 * singleton settings (`PATCH`/`PUT` of instance-wide settings) plus the compliance configuration. You can list snapshots, diff any
 * two (or one against now) and restore one: a restore puts the configuration back as it was, keeps the secrets the instance holds
 * today, and first saves the state it replaces so a restore can be undone the same way.
 * shortcut: the document-driven settings routes cannot be hooked, so the write-time `auto` snapshot is taken by the compliance
 * configuration route and by `POST /__emulator/config_snapshots/capture` (what the real worker pass does).
 */
const SOURCES = ['manual', 'auto', 'pre_restore', 'cli', 'clone'] as const;
const LABEL_MAX = 120;
const AUTO_KEEP = 200;
/** Key names whose string value is a credential, and the at-rest envelope of an encrypted field. */
const SECRET_KEY = /(secret|password|passwd|passphrase|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|signing|credential|salt|hmac|cipher|(^|[_-])token$|(^|[_-])pass$|(^|[_-])pwd$)/i;
const ENVELOPE = /^v\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ATLAS_SECRET = /\b(sk|rk|whsec|ak|pk_live)_[A-Za-z0-9_-]{8,}/;
const secretLike = (key: string, value: unknown): boolean => typeof value === 'string' && value !== '' && (SECRET_KEY.test(key) || ENVELOPE.test(value) || ATLAS_SECRET.test(value));

export function redact(value: unknown, path = '', out: string[] = []): { value: unknown; redacted: string[] } {
  if (Array.isArray(value)) return { value: value.map((v, i) => redact(v, `${path}[${i}]`, out).value), redacted: out };
  if (isObj(value)) {
    const next: Obj = {};
    for (const [k, v] of Object.entries(value)) {
      const here = path ? `${path}.${k}` : k;
      if (secretLike(k, v)) {
        out.push(here);
        continue;
      }
      next[k] = redact(v, here, out).value;
    }
    return { value: next, redacted: out };
  }
  return { value, redacted: out };
}

/** Put the secrets the live config holds back into a restored copy (only where the snapshot has the surrounding object). */
function carrySecrets(target: unknown, current: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(current)) return target.map((t, i) => (i < current.length ? carrySecrets(t, current[i]) : t));
  if (isObj(target) && isObj(current)) {
    const next: Obj = { ...target };
    for (const [k, v] of Object.entries(current)) {
      if (secretLike(k, v)) {
        if (!(k in next)) next[k] = v;
      } else if (k in next) next[k] = carrySecrets(next[k], v);
    }
    return next;
  }
  return target;
}

interface Change { path: string; before: unknown; after: unknown }
function diffConfig(a: unknown, b: unknown, path = '', out: Change[] = []): Change[] {
  if (isObj(a) && isObj(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) diffConfig(a[k], b[k], path ? `${path}.${k}` : k, out);
    return out;
  }
  if (canonical(a ?? null) !== canonical(b ?? null)) out.push({ path, before: a ?? null, after: b ?? null });
  return out;
}

/** The configuration as the emulator holds it: instance-wide settings by route, the compliance configuration, the allowed origins. */
export function currentConfig(e: Engine): { auth_config: Obj; allowed_origins: string[] } {
  const settings: Obj = {};
  for (const [path, body] of e.singletons) if (path !== '/v1/instance/config_snapshots') settings[path] = structuredClone(body);
  const cfg = instanceConfig(e);
  const origins = e.singletons.get('/v1/instance')?.allowed_origins;
  return { auth_config: { settings, compliance: structuredClone(cfg.compliance), localization: structuredClone(cfg.localization) }, allowed_origins: Array.isArray(origins) ? [...origins] : [] };
}

const snapshots = engineState((e: Engine) => new Table('instance_config_snapshots', e.clock.now, 'cfgs'));
const digestOf = (authConfig: unknown, origins: unknown): Promise<string> => hex(canonical({ auth_config: authConfig, allowed_origins: origins }));

const present = (s: Obj, withConfig = false): Obj => ({
  object: 'config_snapshot', id: s.id, version: s.version, label: s.label ?? null, source: s.source, sha256: s.sha256, redacted_paths: s.redacted_paths, created_by: s.created_by ?? null, created_at: s.created_at,
  ...(withConfig ? { auth_config: s.auth_config, allowed_origins: s.allowed_origins } : {}),
});

/** Take a snapshot of the instance as it is now. `skipIfUnchanged` (the automatic path) writes nothing when the newest snapshot is identical. */
export async function captureSnapshot(e: Engine, input: { label?: string | null; source: (typeof SOURCES)[number]; actor?: string | null; skipIfUnchanged?: boolean; current?: { auth_config: Obj; allowed_origins: string[] } }): Promise<{ snapshot: Obj; created: boolean }> {
  const cur = input.current ?? currentConfig(e);
  const red = redact(cur.auth_config);
  const sha = await digestOf(red.value, cur.allowed_origins);
  const t = snapshots(e);
  if (input.skipIfUnchanged) {
    const last = t.all()[0];
    if (last && last.sha256 === sha) return { snapshot: last, created: false };
  }
  const version = (t.all().reduce((m, s) => Math.max(m, s.version), 0)) + 1;
  const snapshot = t.insert({ version, label: input.label ?? null, source: input.source, auth_config: red.value, allowed_origins: cur.allowed_origins, redacted_paths: red.redacted, sha256: sha, created_by: input.actor ?? null, created_at: e.clock.now() } as any);
  if (input.source === 'auto' || input.source === 'pre_restore') {
    const autos = t.all().filter((s) => s.source === 'auto' || s.source === 'pre_restore');
    for (const old of autos.slice(AUTO_KEEP)) t.delete(old.id);
  }
  return { snapshot, created: true };
}
/** Called by the routes that change configuration: the write-time snapshot, deduplicated by digest. */
export const captureAutoSnapshot = (e: Engine): Promise<unknown> => captureSnapshot(e, { source: 'auto', skipIfUnchanged: true });

const parseLabel = (raw: unknown): string | null => {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > LABEL_MAX) throw bad(`label is text of 1 to ${LABEL_MAX} characters.`, 'label');
  return raw.trim();
};

async function side(e: Engine, ref: string): Promise<{ label: string; auth_config: unknown; allowed_origins: unknown }> {
  if (ref === 'current') {
    const cur = currentConfig(e);
    return { label: 'current', auth_config: redact(cur.auth_config).value, allowed_origins: cur.allowed_origins };
  }
  const s = snapshots(e).get(ref);
  if (!s) throw notFound('Unknown snapshot');
  return { label: s.id, auth_config: s.auth_config, allowed_origins: s.allowed_origins };
}

export function snapshotHandlers(): RouteDef[] {
  const READ = 'instance:read';
  const WRITE = 'instance:write';
  const knownFields = (b: Obj, allowed: string[]) => {
    const k = Object.keys(b).find((x) => !allowed.includes(x));
    if (k) throw bad(`Unrecognised field ${k}. Expected any of ${allowed.join(', ')}.`, k);
  };
  return [
    { method: 'POST', pattern: '/v1/instance/config_snapshots', scope: WRITE, handler: async (c) => {
      knownFields(c.body, ['label']);
      const label = parseLabel(c.body.label);
      const { snapshot } = await captureSnapshot(c.engine, { label, source: 'manual', actor: actorOf(c).id });
      audit(c.engine, c, 'config_snapshot.created', 'config_snapshot', snapshot.id, { version: snapshot.version, source: 'manual' });
      return { status: 201, body: present(snapshot) };
    } },
    { method: 'GET', pattern: '/v1/instance/config_snapshots', scope: READ, handler: (c) => {
      const source = c.query.get('source');
      if (source !== null && !(SOURCES as readonly string[]).includes(source)) throw bad(`source is one of: ${SOURCES.join(', ')}.`, 'source');
      return { body: pageReply(c, snapshots(c.engine).all().filter((s) => !source || s.source === source).map((s) => present(s))) };
    } },
    { method: 'GET', pattern: '/v1/instance/config_snapshots/diff', scope: READ, handler: async (c) => {
      const from = c.query.get('from');
      if (!from) throw bad('from is a snapshot id or "current".', 'from');
      const a = await side(c.engine, from);
      const b = await side(c.engine, c.query.get('to') || 'current');
      const changes = diffConfig(a.auth_config, b.auth_config);
      const originsChanged = canonical(a.allowed_origins) !== canonical(b.allowed_origins);
      return { body: { object: 'config_snapshot_diff', from: a.label, to: b.label, changes, allowed_origins: originsChanged ? { before: a.allowed_origins, after: b.allowed_origins } : null, unchanged: changes.length === 0 && !originsChanged } };
    } },
    { method: 'GET', pattern: '/v1/instance/config_snapshots/:id', scope: READ, handler: (c) => {
      const s = snapshots(c.engine).get(c.params.id);
      if (!s) throw notFound('Unknown snapshot');
      return { body: present(s, true) };
    } },
    { method: 'POST', pattern: '/v1/instance/config_snapshots/:id/restore', scope: WRITE, handler: async (c) => {
      const e = c.engine;
      knownFields(c.body, ['dry_run', 'include_allowed_origins', 'expected_sha256']);
      const snap = snapshots(e).get(c.params.id);
      if (!snap) throw notFound('Unknown snapshot');
      for (const k of ['dry_run', 'include_allowed_origins'] as const) if (c.body[k] !== undefined && typeof c.body[k] !== 'boolean') throw bad(`${k} must be true or false.`, k);
      if (c.body.expected_sha256 !== undefined && typeof c.body.expected_sha256 !== 'string') throw bad('expected_sha256 must be a string.', 'expected_sha256');
      const includeOrigins = c.body.include_allowed_origins === true;
      const cur = currentConfig(e);
      const currentRedacted = redact(cur.auth_config).value;
      const currentSha = await digestOf(currentRedacted, cur.allowed_origins);
      const next = carrySecrets(snap.auth_config, cur.auth_config) as Obj;
      const changes = diffConfig(currentRedacted, snap.auth_config);
      const origins = includeOrigins ? (snap.allowed_origins as string[]) : null;
      const originsChange = !!origins && canonical(origins) !== canonical(cur.allowed_origins);
      const view = (applied: boolean): Obj => ({ object: 'config_snapshot_restore', snapshot_id: snap.id, version: snap.version, dry_run: !applied, applied, current_sha256: currentSha, changes, allowed_origins_changed: originsChange });
      if (c.body.dry_run === true) return { body: view(false) };
      if (typeof c.body.expected_sha256 === 'string' && c.body.expected_sha256 !== currentSha) throw conflict('The configuration changed since this restore was previewed. Preview it again.');
      const problems = configProblems({ compliance: next.compliance, localization: next.localization });
      if (problems.length > 0) throw bad(`This snapshot no longer passes configuration checks: ${problems.slice(0, 5).map((p) => `${p.param}: ${p.message}`).join('; ')}`, 'snapshot');
      if (changes.length === 0 && !originsChange) return { body: view(true) };
      await captureSnapshot(e, { label: `Before restoring version ${snap.version}`, source: 'pre_restore', actor: actorOf(c).id, current: cur });
      // settings the snapshot does not hold are removed; the rest are put back (with today's secrets kept)
      const settings = (next.settings ?? {}) as Obj;
      for (const path of [...e.singletons.keys()]) if (path !== '/v1/instance/config_snapshots' && !(path in settings)) e.singletons.delete(path);
      for (const [path, body] of Object.entries(settings)) e.singletons.set(path, structuredClone(body) as Obj);
      const cfg = instanceConfig(e);
      cfg.compliance = structuredClone(next.compliance);
      cfg.localization = structuredClone(next.localization);
      if (originsChange) e.singletons.set('/v1/instance', { ...(e.singletons.get('/v1/instance') ?? {}), allowed_origins: origins });
      const paths = changes.slice(0, 100).map((x) => x.path);
      audit(e, c, 'config_snapshot.restored', 'config_snapshot', snap.id, { version: snap.version, changed_paths: paths, allowed_origins_changed: originsChange });
      e.webhooks.emit('config_snapshot.restored', { id: snap.id, version: snap.version, label: snap.label ?? null, changed_paths: paths, restored_at: e.clock.now() });
      return { body: view(true) };
    } },
    { method: 'DELETE', pattern: '/v1/instance/config_snapshots/:id', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const s = snapshots(e).get(c.params.id);
      if (!s) throw notFound('Unknown snapshot');
      snapshots(e).delete(s.id);
      audit(e, c, 'config_snapshot.deleted', 'config_snapshot', s.id, { version: s.version });
      return { status: 204 };
    } },
    // POST /__emulator/config_snapshots/capture: what the worker pass (and the write-time hook) does: an automatic snapshot, skipped when nothing changed.
    { method: 'POST', pattern: '/__emulator/config_snapshots/capture', public: true, handler: async (c) => {
      const { snapshot, created } = await captureSnapshot(c.engine, { source: 'auto', skipIfUnchanged: true });
      return { body: { object: 'config_snapshot_capture', created, snapshot: present(snapshot) } };
    } },
  ];
}

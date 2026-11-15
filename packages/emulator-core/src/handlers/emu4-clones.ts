/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, Reply, RouteContext, RouteDef } from '../engine';
import { notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table } from '../store';
import { engineState } from './support';
import { actorOf, audit, bad, conflict, hex, pageReply } from './emu4-shared';
import { currentConfig, redact } from './emu4-snapshots';

/**
 * Environment clones and per-pull-request previews. A clone is a new development-mode instance of the same app, filled from the
 * source. It can take configuration, custom roles, organizations, memberships and users. It never takes, whatever is asked:
 * secrets (configuration secrets are removed), API keys, provider connections, signing keys, webhook endpoints, password hashes
 * and second factors, or the private metadata of users and organizations. By default user email addresses are replaced with
 * unreachable ones and phone numbers, usernames and linked identities are left out (`mask_emails: false` keeps the emails). A
 * preview is a clone with a deadline: it is deleted when `expires_at` passes. A section over 2000 rows is copied in batches
 * (status `copying`, progress polled with GET).
 * The emulator is one instance: the clone is a record with its own publishable key, host and secret key (shown once), and the
 * copied data is read at `GET /__emulator/clones/:id/data`. The instance secret key stands in for the platform key; the app id in
 * the path is not checked, the instance id must be the emulator's own. The copy is advanced one batch per poll, or all at once by
 * `POST /__emulator/clones/:id/advance`; `POST /__emulator/clones/sweep` reaps expired previews and fails copies that went quiet.
 */
const SECTIONS = ['config', 'roles', 'organizations', 'users', 'memberships'] as const;
const BODY_FIELDS = ['mode', 'name', 'ref', 'include', 'mask_emails', 'ttl_hours', 'allowed_origins', 'refresh', 'secret_key_preset'];
const DEFAULT_INCLUDE = ['config', 'roles'];
const DEFAULT_PREVIEW_TTL_H = 72;
const MAX_PREVIEW_TTL_H = 720;
const MAX_PREVIEWS = 50;
const MAX_CLONES = 10;
const CLONE_ROW_CAP = 2000;
const SECTION_ROW_CAP = 100_000;
const COPY_BATCH = 1000;
const COPY_STALL_MS = 15 * 60_000;
const PREVIEW_PREFIX = 'preview-';
const APP_RUNTIME_SCOPES = ['users:read', 'users:write', 'organizations:read', 'organizations:write', 'sessions:read', 'sessions:write'];

interface State { clones: Table }
const st = engineState((e: Engine): State => ({ clones: new Table('instance_clones', e.clock.now, 'iclone') }));

const slug = async (ref: string): Promise<string> => {
  const s = ref.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const room = 32 - PREVIEW_PREFIX.length;
  const base = s.length > 0 && s.length <= room ? s : `${s.slice(0, room - 7).replace(/-+$/, '')}-${(await hex(ref)).slice(0, 6)}`.replace(/^-+/, '');
  return `${PREVIEW_PREFIX}${base}`;
};

interface Req { mode: 'clone' | 'preview'; name: string; ref: string | null; include: string[]; maskEmails: boolean; ttlHours: number | null; refresh: boolean }
async function parseBody(b: Obj): Promise<Req> {
  if (b.mode !== 'clone' && b.mode !== 'preview') throw bad('mode must be "clone" or "preview".', 'mode');
  const mode = b.mode;
  let ref: string | null = null;
  if (b.ref !== undefined) {
    if (typeof b.ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/#-]{0,63}$/.test(b.ref)) throw bad('ref is 1-64 characters: letters, digits and . _ / # - (a pull request number or branch name).', 'ref');
    ref = b.ref;
  }
  let name: string;
  if (mode === 'preview') {
    if (!ref) throw bad('A preview needs a ref (a pull request number or branch name): one live preview per ref.', 'ref');
    if (b.name !== undefined) throw bad('A preview is named from its ref; send name only with mode "clone".', 'name');
    name = await slug(ref);
  } else {
    // shortcut: the real name rules are approximated (lowercase slug, 2 to 32 characters, nothing that reads as a production name).
    if (typeof b.name !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(b.name)) throw bad('name is a lowercase slug of 2 to 32 characters (letters, digits and -), starting with a letter.', 'name');
    if (b.name.startsWith(PREVIEW_PREFIX)) throw bad(`Names starting with "${PREVIEW_PREFIX}" are reserved for previews.`, 'name');
    if (['production', 'development', 'live', 'staging-default'].includes(b.name)) throw bad(`"${b.name}" is a reserved environment name.`, 'name');
    name = b.name;
  }
  let include = DEFAULT_INCLUDE;
  if (b.include !== undefined) {
    if (!Array.isArray(b.include) || b.include.length === 0 || b.include.some((s) => typeof s !== 'string' || !(SECTIONS as readonly string[]).includes(s))) throw bad(`include is a non-empty list of: ${SECTIONS.join(', ')}.`, 'include');
    include = [...new Set(b.include as string[])];
  }
  if (include.includes('memberships') && !(include.includes('users') && include.includes('organizations'))) throw bad('memberships needs users and organizations in include as well.', 'include');
  if (b.mask_emails !== undefined && typeof b.mask_emails !== 'boolean') throw bad('mask_emails must be true or false.', 'mask_emails');
  if (b.refresh !== undefined && typeof b.refresh !== 'boolean') throw bad('refresh must be true or false.', 'refresh');
  let ttlHours: number | null = null;
  if (mode === 'preview') {
    ttlHours = DEFAULT_PREVIEW_TTL_H;
    if (b.ttl_hours !== undefined) {
      if (typeof b.ttl_hours !== 'number' || !Number.isInteger(b.ttl_hours) || b.ttl_hours < 1 || b.ttl_hours > MAX_PREVIEW_TTL_H) throw bad(`ttl_hours is a whole number from 1 to ${MAX_PREVIEW_TTL_H}.`, 'ttl_hours');
      ttlHours = b.ttl_hours;
    }
  } else if (b.ttl_hours !== undefined) throw bad('ttl_hours applies to a preview only.', 'ttl_hours');
  return { mode, name, ref, include, maskEmails: b.mask_emails !== false, ttlHours, refresh: b.refresh === true };
}

const parseOrigins = (raw: unknown): string[] => {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw bad('allowed_origins is a list of at most 20 origins.', 'allowed_origins');
  return raw.map((o) => {
    try {
      const u = new URL(String(o));
      if (u.origin === 'null' || (u.protocol !== 'https:' && u.hostname !== 'localhost')) throw new Error('scheme');
      return u.origin;
    } catch {
      throw bad(`${String(o)} is not an https origin.`, 'allowed_origins');
    }
  });
};

const isPrivate = (k: string): boolean => k === 'private_metadata';
const noPrivate = (row: Obj): Obj => Object.fromEntries(Object.entries(row).filter(([k]) => !isPrivate(k)));

/** The rows of a section as they leave the source: private metadata removed; with `mask`, emails replaced and phones, usernames and linked identities dropped. */
async function sectionRows(e: Engine, section: string, mask: boolean, salt: string): Promise<Obj[]> {
  if (section === 'roles') return e.db.roles.all().filter((r) => !r.is_system && !r.system).map((r) => noPrivate(r));
  if (section === 'organizations') return e.db.organizations.all().map((o) => noPrivate(o));
  if (section === 'memberships') return e.db.memberships.all().map((m) => ({ id: m.id, user_id: m.user_id, organization_id: m.organization_id, role: m.role }));
  if (section === 'users') {
    const out: Obj[] = [];
    for (const u of e.db.users.all().filter((x) => !x.deleted)) {
      const row: Obj = {
        id: u.id, first_name: u.first_name ?? null, last_name: u.last_name ?? null, image_url: u.image_url ?? null, external_id: u.external_id ?? null,
        public_metadata: u.public_metadata ?? {}, unsafe_metadata: u.unsafe_metadata ?? {}, private_metadata: {}, has_password: false, created_at: u.created_at,
        email_addresses: await Promise.all(((u.emails as Obj[]) ?? []).map(async (m) => ({ id: m.id, email: mask ? `user-${(await hex(`${salt}:${String(m.email_address).toLowerCase()}`)).slice(0, 16)}@example.com` : m.email_address, verified: m.verified === true }))),
        phone_numbers: [], external_accounts: [],
      };
      if (!mask) {
        row.username = u.username ?? null;
        row.external_accounts = [];
      } else row.username = null;
      out.push(row);
    }
    return out;
  }
  return [];
}

const countOf = (e: Engine, section: string): number => (section === 'users' ? e.db.users.all().filter((u) => !u.deleted).length : section === 'organizations' ? e.db.organizations.size : section === 'memberships' ? e.db.memberships.size : section === 'roles' ? e.db.roles.all().filter((r) => !r.is_system && !r.system).length : 1);

const present = (c: Obj): Obj => ({
  object: 'instance_clone', id: c.id, kind: c.kind, name: c.name, ref: c.ref ?? null, status: c.status, progress: c.progress ?? {}, source_instance_id: c.source_instance_id, instance_id: c.instance_id ?? null, environment: 'development',
  publishable_key: c.publishable_key ?? null, frontend_api_host: c.frontend_api_host ?? null, allowed_origins: c.allowed_origins ?? [], include: c.include, mask_emails: c.mask_emails, counts: c.counts ?? {}, errors: (c.errors ?? []).slice(0, 100),
  expires_at: c.expires_at ?? null, created_by: c.created_by ?? null, created_at: c.created_at, completed_at: c.completed_at ?? null, deleted_at: c.deleted_at ?? null,
});

const live = (c: Obj): boolean => !c.deleted_at && c.status !== 'failed' && c.status !== 'deleted';
const eventData = (e: Engine, c: Obj): Obj => ({ id: c.id, kind: c.kind, name: c.name, ref: c.ref ?? null, source_instance_id: c.source_instance_id, instance_id: c.instance_id ?? null, expires_at: c.expires_at ?? null, at: e.clock.now() });

/** Copy everything now (small sources) or one batch per section (the background job's pass). */
async function copyPass(e: Engine, c: Obj, all: boolean): Promise<void> {
  const progress = c.progress.sections as Record<string, { total: number; copied: number }>;
  const data = c._data as Obj;
  for (const section of c.include as string[]) {
    if (section === 'config') continue;
    const p = progress[section]!;
    if (p.copied >= p.total) continue;
    p.copied = all ? p.total : Math.min(p.total, p.copied + COPY_BATCH);
    data[section] = (await sectionRows(e, section, c.mask_emails, c._salt)).slice(0, p.copied);
    c.last_progress_at = e.clock.now();
  }
  if (Object.values(progress).every((p) => p.copied >= p.total)) {
    const rows = (c._data as Obj);
    c.counts = Object.fromEntries((c.include as string[]).map((s) => [s, s === 'config' ? 1 : ((rows[s] as Obj[] | undefined)?.length ?? 0)]));
    Object.assign(c, { status: 'completed', completed_at: e.clock.now() });
  }
}

export function cloneHandlers(): RouteDef[] {
  const base = '/v1/platform/apps/:id/instances/:instanceId/clones';
  const source = (c: RouteContext): void => {
    if (c.params.instanceId !== c.engine.instanceId) throw notFound('Unknown app instance');
  };
  const cloneOf = (e: Engine, id: string | undefined): Obj => {
    const row = st(e).clones.get(id);
    if (!row) throw notFound('Unknown clone');
    return row;
  };
  /** The background job's pass: a copying clone moves one batch each time it is read. */
  const settle = async (e: Engine, row: Obj): Promise<void> => {
    if (row.status === 'copying') await copyPass(e, row, false);
  };

  return [
    { method: 'POST', pattern: base, scope: 'platform:apps:write', handler: async (c): Promise<Reply> => {
      const e = c.engine;
      source(c);
      const b = c.body;
      const unknown = Object.keys(b).find((k) => !BODY_FIELDS.includes(k));
      if (unknown) throw bad(`Unrecognised field ${unknown}. Expected any of ${BODY_FIELDS.join(', ')}.`, unknown);
      if (b.secret_key_preset !== undefined && b.secret_key_preset !== 'full' && b.secret_key_preset !== 'app-runtime') throw bad('secret_key_preset must be "app-runtime" or "full".', 'secret_key_preset');
      const origins = parseOrigins(b.allowed_origins);
      const req = await parseBody(b);
      const now = e.clock.now();
      const scopes = b.secret_key_preset === 'full' ? ['*'] : [...APP_RUNTIME_SCOPES];
      // A preview is one per ref: a repeat answers with what exists; `refresh` re-applies the configuration and restarts the clock.
      if (req.ref) {
        const existing = st(e).clones.find((r) => live(r) && r.ref === req.ref);
        if (existing) {
          if (existing.kind !== req.mode) throw conflict(`A live ${existing.kind} already uses this ref.`);
          if (req.refresh && existing.status === 'completed') {
            existing._data.config = redact(currentConfig(e).auth_config).value;
            if (existing.kind === 'preview' && req.ttlHours) existing.expires_at = now + req.ttlHours * 3_600_000;
            audit(e, c, 'app.instance_clone_refreshed', 'instance_clone', existing.id, {});
          }
          return { status: 200, body: { ...present(existing), replayed: true, note: 'A live clone for this ref already exists; it was returned unchanged. Its secret key was shown once, at create.' } };
        }
      }
      const liveOfKind = st(e).clones.filter((r) => live(r) && r.kind === req.mode).length;
      const cap = req.mode === 'preview' ? MAX_PREVIEWS : MAX_CLONES;
      if (liveOfKind >= cap) throw bad(`This instance already has ${liveOfKind} live ${req.mode === 'preview' ? 'previews' : 'clones'}; delete one first (the limit is ${cap}).`, 'mode');
      const totals: Record<string, number> = {};
      for (const s of req.include) if (s !== 'config') totals[s] = countOf(e, s);
      for (const [s, n] of Object.entries(totals)) {
        if (n > SECTION_ROW_CAP) throw bad(`The ${s} section has ${n} rows, more than the ${SECTION_ROW_CAP} a clone copies. Leave it out of include and move it with a tenant export and import.`, 'include');
      }
      if (st(e).clones.find((r) => live(r) && r.name === req.name)) throw conflict(`This app already has an environment named "${req.name}".`);
      const big = Object.values(totals).some((n) => n > CLONE_ROW_CAP);
      const sk = `sk_test_${(await hex(`${now}:${Math.random()}`)).slice(0, 40)}`;
      const id = e.db.newId('ins');
      const row = st(e).clones.insert({
        kind: req.mode, name: req.name, ref: req.ref, status: 'pending', progress: { sections: Object.fromEntries(Object.entries(totals).map(([s, n]) => [s, { total: n, copied: 0 }])) },
        source_instance_id: e.instanceId, instance_id: id, publishable_key: `pk_test_${(await hex(id)).slice(0, 32)}`, frontend_api_host: `${req.name}-fapi.emulator.invalid`, allowed_origins: origins,
        include: req.include, mask_emails: req.maskEmails, counts: {}, errors: [], expires_at: req.ttlHours ? now + req.ttlHours * 3_600_000 : null, created_by: actorOf(c).id, created_at: now,
        _data: { config: req.include.includes('config') ? redact(currentConfig(e).auth_config).value : undefined } as Obj, _salt: crypto.randomUUID(), last_progress_at: now,
      } as any);
      if (!req.include.includes('config')) delete row._data.config;
      // keep only a digest of the secret key: it is shown once and never stored
      row.secret_sha256 = await hex(sk);
      audit(e, c, 'app.instance_cloned', 'instance_clone', row.id, { kind: row.kind, target_instance_id: id });
      if (big) {
        row.status = 'copying';
        const rows = row._data as Obj;
        for (const s of req.include) if (s !== 'config') rows[s] = [];
      } else {
        row.status = 'copying';
        await copyPass(e, row, true);
      }
      e.webhooks.emit('instance_clone.created', eventData(e, row));
      const note = 'The clone runs in development mode: no email or SMS leaves it until you give it its own provider keys. Copy this secret key now; only a hash is stored.';
      return { status: row.status === 'completed' ? 201 : 202, body: { ...present(row), secret: sk, secret_key_scopes: scopes, note } };
    } },
    { method: 'GET', pattern: base, scope: 'platform:apps:read', handler: async (c) => {
      const e = c.engine;
      source(c);
      const kind = c.query.get('kind');
      if (kind !== null && kind !== 'clone' && kind !== 'preview') throw bad('kind is "clone" or "preview".', 'kind');
      const rows = st(e).clones.all().filter((r) => !kind || r.kind === kind);
      for (const r of rows) await settle(e, r);
      return { body: pageReply(c, rows.map(present)) };
    } },
    { method: 'GET', pattern: `${base}/:cloneId`, scope: 'platform:apps:read', handler: async (c) => {
      const e = c.engine;
      source(c);
      const row = cloneOf(e, c.params.cloneId);
      await settle(e, row);
      return { body: present(row) };
    } },
    { method: 'DELETE', pattern: `${base}/:cloneId`, scope: 'platform:apps:write', handler: (c) => {
      const e = c.engine;
      source(c);
      const row = st(e).clones.get(c.params.cloneId);
      if (!row || row.deleted_at) throw notFound('Unknown clone');
      Object.assign(row, { status: 'deleted', deleted_at: e.clock.now(), _data: {} });
      e.webhooks.emit('instance_clone.deleted', eventData(e, row));
      audit(e, c, 'app.instance_clone_deleted', 'instance_clone', row.id, { kind: row.kind });
      return { body: present(row) };
    } },

    // ── emulator helpers ──
    // GET /__emulator/clones/:id/data: what was copied, to check nothing private came along. Never carries a secret.
    { method: 'GET', pattern: '/__emulator/clones/:id/data', public: true, handler: (c) => {
      const row = cloneOf(c.engine, c.params.id);
      return { body: { object: 'instance_clone_data', id: row.id, status: row.status, ...(row._data as Obj) } };
    } },
    { method: 'POST', pattern: '/__emulator/clones/:id/advance', public: true, handler: async (c) => {
      const row = cloneOf(c.engine, c.params.id);
      if (row.status === 'copying') await copyPass(c.engine, row, true);
      return { body: present(row) };
    } },
    // POST /__emulator/clones/sweep: the worker pass. Expired previews are deleted (instance_clone.expired); a copy that made no progress for 15 minutes fails.
    { method: 'POST', pattern: '/__emulator/clones/sweep', public: true, handler: (c) => {
      const e = c.engine;
      const now = e.clock.now();
      const expired: string[] = [];
      const failed: string[] = [];
      for (const row of st(e).clones.all()) {
        if (row.kind === 'preview' && live(row) && row.expires_at && row.expires_at <= now) {
          Object.assign(row, { status: 'deleted', deleted_at: now, _data: {} });
          e.webhooks.emit('instance_clone.expired', eventData(e, row));
          expired.push(row.id);
        } else if (row.status === 'copying' && now - (row.last_progress_at ?? row.created_at) > COPY_STALL_MS) {
          Object.assign(row, { status: 'failed', instance_id: null, errors: [{ section: '*', ref: null, code: 'copy_interrupted', message: 'The copy stopped before it finished. Delete this clone and create it again.' }] });
          failed.push(row.id);
        }
      }
      return { body: { object: 'instance_clone_sweep', expired, failed } };
    } },
  ];
}

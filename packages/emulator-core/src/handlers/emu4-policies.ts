/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, Reply, RouteContext, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import { genericHandler } from '../generic';
import type { Obj } from '../openapi';
import { Table } from '../store';
import { engineState } from './support';
import { actorOf, audit, bad, canonical, conflict, hex, instanceConfig, isObj, iso, listOf } from './emu4-shared';

/**
 * Policies, further (who a policy is asked of, and the text in other languages) and translation review (draft, review, approve,
 * with an optional four-eyes rule). Policies, policy versions and localizations are stored by the document-driven layer; the
 * routes here wrap its create/update/publish answers so a version has a real draft/published/retired state and a localization a
 * review state. shortcut: the emulator renders no emails, so `localization.requireReview` only decides the state a new or edited
 * translation starts in; nothing is filtered at render time.
 */
const MAX_AUDIENCE_ORGS = 200;
const BCP47 = /^[A-Za-z]{2,3}(-[A-Za-z]{3}){0,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|[0-9]{3}))?(-([A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*$/;
const wellFormed = (t: unknown): t is string => typeof t === 'string' && BCP47.test(t);
const canonicalLocale = (t: string): string => t.split('-').map((p, i) => (i === 0 ? p.toLowerCase() : p.length === 4 && /^[A-Za-z]+$/.test(p) ? p[0]!.toUpperCase() + p.slice(1).toLowerCase() : p.length === 2 && /^[A-Za-z]+$/.test(p) ? p.toUpperCase() : p.toLowerCase())).join('-');
const REVIEW_STATUSES = ['draft', 'in_review', 'changes_requested', 'approved'] as const;
const REVIEW_ACTIONS = ['submit', 'approve', 'request_changes', 'reopen'] as const;
const RESOURCE_TYPES = ['email_template', 'sms_template', 'prompt_copy'];
const PROMPT_KEYS = ['headline', 'subheadline', 'footer'];

interface State {
  audiences: Map<string, { audience: 'everyone' | 'orgs'; organization_ids: string[] }>;
  translations: Map<string, Obj>;
  reviews: Table;
}
const st = engineState((e: Engine): State => ({ audiences: new Map(), translations: new Map(), reviews: new Table('localization_reviews', e.clock.now, 'locrev') }));

const policies = (e: Engine): Table | undefined => e.generic.get('policies');
const versions = (e: Engine): Table | undefined => e.generic.get('policies/versions');
const localizations = (e: Engine): Table | undefined => e.generic.get('localizations');
const strip = (row: Obj): Obj => {
  const { _parent, ...rest } = row;
  return rest;
};

function loadPolicy(e: Engine, idOrKey: string | undefined): Obj {
  const p = policies(e)?.get(idOrKey) ?? policies(e)?.find((x) => x.key === idOrKey);
  if (!p) throw notFound('Unknown policy');
  return p;
}
function loadVersion(e: Engine, p: Obj, versionId: string | undefined): Obj {
  const v = versions(e)?.get(versionId);
  if (!v || v._parent !== p.id) throw notFound('Unknown policy version');
  return v;
}
const isDraft = (v: Obj): boolean => v.status === 'draft';

/** A deliberately small sanitizer: markdown becomes escaped paragraphs; HTML loses script/style/iframe, event handlers and javascript: URLs. */
function render(input: { markdown?: string; html?: string }): string {
  if (input.markdown !== undefined) {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return input.markdown.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => (p.startsWith('# ') ? `<h1>${esc(p.slice(2))}</h1>` : `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)).join('\n');
  }
  return (input.html ?? '').replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1\s*>/gi, '').replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2').trim();
}

const presentTranslation = (t: Obj, key: string, version: string): Obj => ({ object: 'policy_translation', id: t.id, policy: key, version_id: t.version_id, version, locale: t.locale, title: t.title, content_markdown: t.content_markdown, content_html: t.content_html, content_sha256: t.content_sha256, created_at: t.created_at, updated_at: t.updated_at });

/** The translation locale that serves a requested one: exact, then the same language (es-MX asks for es). */
function pick(wanted: string, available: string[]): string | null {
  if (!wellFormed(wanted)) return null;
  const w = canonicalLocale(wanted);
  if (available.includes(w)) return w;
  const base = w.split('-')[0]!;
  return available.find((a) => a === base) ?? available.find((a) => a.split('-')[0] === base) ?? null;
}

// ── translation review ──

const contentHash = (content: unknown): Promise<string> => hex(canonical(content));
const NEXT: Record<string, { from: readonly string[]; to: string }> = {
  submit: { from: ['draft', 'changes_requested'], to: 'in_review' },
  approve: { from: ['in_review'], to: 'approved' },
  request_changes: { from: ['in_review'], to: 'changes_requested' },
  reopen: { from: ['approved', 'in_review', 'changes_requested'], to: 'draft' },
};

async function presentLocalization(row: Obj): Promise<Obj> {
  return {
    ...strip(row),
    review_status: row.review_status ?? 'approved',
    authored_by: row.authored_by ?? null,
    reviewed_by: row.reviewed_by ?? null,
    reviewed_at: row.reviewed_at ?? null,
    reviewer_hint: row.reviewer_hint ?? null,
    changed_since_approval: (row.review_status ?? 'approved') === 'approved' && !!row.source_hash && row.source_hash !== (await contentHash(row.content ?? {})),
  };
}

/** The review state a row gets when its content is written. Unchanged text keeps its state; a human-approved text goes back to draft. */
async function stateAfterEdit(before: Obj | undefined, content: Obj, requireReview: boolean): Promise<string | undefined> {
  if (!before) return requireReview ? 'draft' : undefined;
  if ((await contentHash(before.content ?? {})) === (await contentHash(content))) return undefined;
  if (before.reviewed_by || (requireReview && before.review_status === 'approved')) return 'draft';
  if (before.review_status === 'in_review' || before.review_status === 'changes_requested') return 'draft';
  return undefined;
}

const placeholdersOf = (text: string): string[] => [...new Set([...text.matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}|\{([A-Za-z0-9_.]+)\}/g)].map((m) => m[1] ?? m[2]!))].sort();

async function check(e: Engine, items: unknown, requireApproved: boolean): Promise<Obj> {
  if (!Array.isArray(items) || items.length === 0 || items.length > 500) throw bad('items is a list of 1 to 500 translations.', 'items');
  const rows = localizations(e)?.all() ?? [];
  const results: Obj[] = [];
  for (const [index, raw] of (items as Obj[]).entries()) {
    const problems: Array<{ code: string; message: string }> = [];
    const add = (code: string, message: string) => problems.push({ code, message });
    const { resource_type: type, resource_name: name, locale, content } = raw ?? {};
    if (typeof type !== 'string' || !RESOURCE_TYPES.includes(type)) add('resource_type', `resource_type must be one of ${RESOURCE_TYPES.join(', ')}.`);
    if (typeof name !== 'string' || !name) add('resource_name', 'resource_name is required.');
    if (!wellFormed(locale)) add('locale', 'locale must be a well-formed BCP-47 tag.');
    if (!isObj(content)) add('content', 'content must be an object.');
    if (problems.length === 0) {
      const c = content as Obj;
      for (const [k, v] of Object.entries(c)) if (typeof v === 'string' && !v.trim()) add('empty', `"${k}" is empty.`);
      if (type === 'prompt_copy') {
        if (name !== 'hosted') add('unknown_resource', 'prompt_copy resource_name must be "hosted".');
        for (const k of Object.keys(c)) if (!PROMPT_KEYS.includes(k)) add('unknown_key', `Unknown prompt_copy key "${k}".`);
      }
      if (type === 'sms_template' && typeof c.body !== 'string') add('body', 'A body is required.');
      const siblings = rows.filter((r) => r.resource_type === type && r.resource_name === name && r.locale !== locale && (r.review_status ?? 'approved') === 'approved');
      for (const [k, v] of Object.entries(c)) {
        if (typeof v !== 'string') continue;
        const mine = placeholdersOf(v);
        for (const sib of siblings) {
          const other = (sib.content ?? {})[k];
          if (typeof other !== 'string') continue;
          const theirs = placeholdersOf(other);
          if (theirs.join() !== mine.join()) {
            add('placeholder_mismatch', `"${k}" uses {${mine.join(', ')}} but the approved ${sib.locale} text uses {${theirs.join(', ')}}.`);
            break;
          }
        }
      }
      if (requireApproved) {
        const stored = rows.find((r) => r.resource_type === type && r.resource_name === name && r.locale === locale);
        if (!stored) add('not_stored', 'This translation is not stored yet.');
        else if ((stored.review_status ?? 'approved') !== 'approved') add('not_approved', `Review status is ${stored.review_status}.`);
        else if (stored.source_hash && stored.source_hash !== (await contentHash(stored.content ?? {}))) add('changed_since_approval', 'The stored text changed after it was approved.');
      }
    }
    results.push({ index, ok: problems.length === 0, problems });
  }
  return { object: 'localization_check', ok: results.every((r) => r.ok), checked: results.length, failed: results.filter((r) => !r.ok).length, results };
}

export function policyHandlers(): RouteDef[] {
  const READ = 'instance:read';
  const WRITE = 'instance:write';
  const knownFields = (b: Obj, allowed: string[]) => {
    const k = Object.keys(b).find((x) => !allowed.includes(x));
    if (k) throw bad(`Unrecognised field ${k}. Expected any of ${allowed.join(', ')}.`, k);
  };
  const audienceView = (e: Engine, p: Obj): Obj => {
    const a = st(e).audiences.get(p.id) ?? { audience: 'everyone', organization_ids: [] };
    return { object: 'policy_audience', policy: p.key ?? null, policy_id: p.id, audience: a.audience, organization_ids: a.organization_ids };
  };
  /** Run the document-driven answer for a version route, then give the row the state the route implies. */
  const versionAction = (status: string, event?: string) => (c: RouteContext): Reply => {
    const e = c.engine;
    const p = loadPolicy(e, c.params.id);
    const v = loadVersion(e, p, c.params.versionId);
    if (status === 'published' && v.status === 'published') throw conflict('This version is already published.');
    if (status === 'retired' && v.status === 'retired') throw conflict('This version is already retired.');
    const now = e.clock.now();
    Object.assign(v, status === 'published' ? { status, published_at: now, effective_at: v.effective_at ?? now } : { status, retired_at: now });
    audit(e, c, status === 'published' ? 'policy_version.published' : 'policy_version.retired', 'policy', v.id, { key: p.key });
    if (event) e.webhooks.emit(event, { object: 'policy_version', id: v.id, policy_id: p.id, policy: p.key ?? null, version: v.version ?? null, published_at: now });
    return { body: strip(v) };
  };

  const decorateOne = async (reply: Reply, row: Obj | undefined): Promise<Reply> => (row ? { ...reply, body: await presentLocalization(row) } : reply);
  const authorStamp = async (c: RouteContext, row: Obj, before: Obj | undefined): Promise<void> => {
    const cfg = instanceConfig(c.engine).localization;
    row.authored_by = actorOf(c).id;
    const next = await stateAfterEdit(before, (row.content ?? {}) as Obj, cfg.requireReview === true);
    if (next) {
      row.review_status = next;
      if (next === 'draft') row.reviewed_by = null;
    } else if (!before) row.review_status ??= 'approved';
  };

  return [
    // ── audience ──
    { method: 'GET', pattern: '/v1/policies/:id/audience', scope: READ, handler: (c) => ({ body: audienceView(c.engine, loadPolicy(c.engine, c.params.id)) }) },
    { method: 'PUT', pattern: '/v1/policies/:id/audience', scope: WRITE, handler: (c) => {
      const e = c.engine;
      knownFields(c.body, ['audience', 'organization_ids']);
      const p = loadPolicy(e, c.params.id);
      const audience = c.body.audience;
      if (audience !== 'everyone' && audience !== 'orgs') throw bad('audience is everyone or orgs.', 'audience');
      let ids: string[] = [];
      if (audience === 'orgs') {
        const raw = c.body.organization_ids;
        if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_AUDIENCE_ORGS || raw.some((x) => typeof x !== 'string' || !x)) throw bad(`organization_ids is a list of 1 to ${MAX_AUDIENCE_ORGS} organization ids.`, 'organization_ids');
        ids = [...new Set(raw as string[])];
        const missing = ids.filter((i) => !e.db.organizations.get(i));
        if (missing.length > 0) throw bad(`Unknown organization: ${missing.slice(0, 5).join(', ')}.`, 'organization_ids');
      } else if (c.body.organization_ids !== undefined && !(Array.isArray(c.body.organization_ids) && c.body.organization_ids.length === 0)) throw bad('organization_ids belongs with audience "orgs".', 'organization_ids');
      st(e).audiences.set(p.id, { audience, organization_ids: ids });
      audit(e, c, 'policy.audience_changed', 'policy', p.id, { key: p.key, audience, organizations: ids.length });
      return { body: audienceView(e, p) };
    } },

    // ── version lifecycle (wraps the document-driven rows) ──
    { method: 'POST', pattern: '/v1/policies/:id/versions', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const p = loadPolicy(e, c.params.id);
      const reply = genericHandler({ ...c, params: { ...c.params, id: p.id } });
      const row = versions(e)?.get((reply.body as Obj | undefined)?.id);
      if (!row) return reply;
      row.status = 'draft';
      audit(e, c, 'policy_version.created', 'policy', row.id, { key: p.key });
      return { ...reply, body: strip(row) };
    } },
    { method: 'POST', pattern: '/v1/policies/:id/versions/:versionId/publish', scope: WRITE, handler: versionAction('published', 'policy.version_published') },
    { method: 'POST', pattern: '/v1/policies/:id/versions/:versionId/retire', scope: WRITE, handler: versionAction('retired') },

    // ── translations ──
    { method: 'GET', pattern: '/v1/policies/:id/versions/:versionId/translations', scope: READ, handler: (c) => {
      const e = c.engine;
      const p = loadPolicy(e, c.params.id);
      const v = loadVersion(e, p, c.params.versionId);
      return { body: listOf([...st(e).translations.values()].filter((t) => t.version_id === v.id).map((t) => presentTranslation(t, p.key, v.version ?? v.id))) };
    } },
    { method: 'PUT', pattern: '/v1/policies/:id/versions/:versionId/translations/:locale', scope: WRITE, handler: async (c) => {
      const e = c.engine;
      knownFields(c.body, ['title', 'content_markdown', 'content_html']);
      const p = loadPolicy(e, c.params.id);
      const v = loadVersion(e, p, c.params.versionId);
      if (!wellFormed(c.params.locale)) throw bad('locale must be a well-formed BCP-47 tag, e.g. es, pt-BR.', 'locale');
      const locale = canonicalLocale(c.params.locale);
      const md = c.body.content_markdown;
      const html = c.body.content_html;
      if ((md === undefined) === (html === undefined)) throw bad('Send content_markdown or content_html.', 'content_markdown');
      const title = c.body.title;
      if (title !== undefined && title !== null && (typeof title !== 'string' || !title.trim() || title.length > 200)) throw bad('title is text of at most 200 characters, or null.', 'title');
      const key = `${v.id}:${locale}`;
      const existing = st(e).translations.get(key);
      // A text people have been asked to accept is evidence: a published version can gain languages but not change one already shown.
      if (existing && !isDraft(v)) throw conflict('This version is published; its translations cannot be changed. Create a new version.');
      if ((md !== undefined && typeof md !== 'string') || (html !== undefined && typeof html !== 'string')) throw bad('The content must be text.', typeof md === 'string' ? 'content_html' : 'content_markdown');
      if (String(md ?? html).length > 200_000) throw bad('The content is too large.', md !== undefined ? 'content_markdown' : 'content_html');
      const rendered = render(typeof md === 'string' ? { markdown: md } : { html: String(html) });
      if (!rendered) throw bad('The content must not be empty.', 'content_markdown');
      const now = e.clock.now();
      const row: Obj = { id: existing?.id ?? e.db.newId('poltr'), version_id: v.id, locale, title: (title as string | null | undefined)?.trim() || null, content_markdown: typeof md === 'string' ? md : null, content_html: rendered, content_sha256: await hex(rendered), created_at: existing?.created_at ?? now, updated_at: now };
      st(e).translations.set(key, row);
      audit(e, c, 'policy_version.translated', 'policy_version', v.id, { key: p.key, version: v.version ?? null, locale });
      return { body: presentTranslation(row, p.key, v.version ?? v.id) };
    } },
    { method: 'DELETE', pattern: '/v1/policies/:id/versions/:versionId/translations/:locale', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const p = loadPolicy(e, c.params.id);
      const v = loadVersion(e, p, c.params.versionId);
      if (!isDraft(v)) throw conflict('This version is published; its translations cannot be removed.');
      if (!wellFormed(c.params.locale)) throw bad('locale must be a well-formed BCP-47 tag.', 'locale');
      const locale = canonicalLocale(c.params.locale);
      if (!st(e).translations.delete(`${v.id}:${locale}`)) throw notFound('No translation for this locale');
      audit(e, c, 'policy_version.translation_removed', 'policy_version', v.id, { key: p.key, locale });
      return { body: { object: 'policy_translation', version_id: v.id, locale, deleted: true } };
    } },
    // The application's own site: each policy's current version, in the nearest language, with the hash it will record on acceptance.
    { method: 'GET', pattern: '/v1/client/policies', public: true, handler: (c) => {
      const e = c.engine;
      const wanted = (c.query.get('locale') ?? '').trim();
      const data: Obj[] = [];
      for (const p of policies(e)?.all().reverse() ?? []) {
        if (p.status === 'retired' || st(e).audiences.get(p.id)?.audience === 'orgs') continue;
        const v = (versions(e)?.all() ?? []).find((x) => x._parent === p.id && x.status === 'published');
        if (!v) continue;
        const trs = [...st(e).translations.values()].filter((t) => t.version_id === v.id);
        const available = trs.map((t) => t.locale);
        const loc = wanted ? pick(wanted, available) : null;
        const tr = loc ? trs.find((t) => t.locale === loc) : undefined;
        data.push({ object: 'policy', key: p.key ?? null, title: tr?.title ?? p.title ?? null, display: p.display ?? 'checkbox', required: p.required !== false, applies_to: p.applies_to ?? 'sign_up', position: p.position ?? 0, version_id: v.id, version: v.version ?? null, content_markdown: tr ? tr.content_markdown : (v.content_markdown ?? null), content_html: tr ? tr.content_html : (v.content_html ?? null), content_sha256: tr ? tr.content_sha256 : (v.content_sha256 ?? null), content_url: v.content_url ?? null, summary_of_changes: v.summary_of_changes ?? null, locale: tr ? tr.locale : (v.locale ?? null), available_locales: available, published_at: v.published_at ?? null, effective_at: v.effective_at ?? null });
      }
      return { headers: { 'cache-control': 'no-store' }, body: { object: 'list', data, legacy_consent: null } };
    } },

    // ── localizations: create/update/read answers carry the review state ──
    { method: 'POST', pattern: '/v1/localizations', scope: 'localizations:write', handler: async (c) => {
      const e = c.engine;
      if (c.body.locale !== undefined && !wellFormed(c.body.locale)) throw bad('locale must be a well-formed BCP-47 tag.', 'locale');
      if (c.body.resource_type !== undefined && !RESOURCE_TYPES.includes(String(c.body.resource_type))) throw bad(`resource_type must be one of ${RESOURCE_TYPES.join(', ')}.`, 'resource_type');
      const reply = genericHandler({ ...c, body: c.body.locale ? { ...c.body, locale: canonicalLocale(String(c.body.locale)) } : c.body });
      const row = localizations(e)?.get((reply.body as Obj | undefined)?.id);
      if (row) await authorStamp(c, row, undefined);
      return decorateOne(reply, row);
    } },
    { method: 'GET', pattern: '/v1/localizations', scope: 'localizations:read', handler: async (c) => {
      const reply = genericHandler(c);
      const body = reply.body as Obj;
      const rows = localizations(c.engine);
      return { ...reply, body: { ...body, data: await Promise.all(((body.data as Obj[]) ?? []).map((r) => (rows?.get(r.id) ? presentLocalization(rows.get(r.id)!) : r))) } };
    } },
    { method: 'GET', pattern: '/v1/localizations/review_summary', scope: 'localizations:read', handler: async (c) => {
      const rows = localizations(c.engine)?.all() ?? [];
      const present = await Promise.all(rows.map(presentLocalization));
      const counts = Object.fromEntries(REVIEW_STATUSES.map((s) => [s, present.filter((r) => r.review_status === s).length]));
      return { body: { object: 'localization_review_summary', counts, queue: present.filter((r) => r.review_status === 'in_review' || r.review_status === 'changes_requested'), changed_since_approval: present.filter((r) => r.changed_since_approval) } };
    } },
    { method: 'POST', pattern: '/v1/localizations/check', scope: 'localizations:read', handler: async (c) => {
      knownFields(c.body, ['items', 'require_approved']);
      if (c.body.require_approved !== undefined && typeof c.body.require_approved !== 'boolean') throw bad('require_approved is a boolean.', 'require_approved');
      return { body: await check(c.engine, c.body.items, c.body.require_approved === true) };
    } },
    { method: 'GET', pattern: '/v1/localizations/:id', scope: 'localizations:read', handler: async (c) => {
      const row = localizations(c.engine)?.get(c.params.id);
      if (!row) throw notFound('Localization');
      return { body: await presentLocalization(row) };
    } },
    { method: 'PATCH', pattern: '/v1/localizations/:id', scope: 'localizations:write', handler: async (c) => {
      const e = c.engine;
      const row = localizations(e)?.get(c.params.id);
      if (!row) throw notFound('Localization');
      if (c.body.locale !== undefined && !wellFormed(c.body.locale)) throw bad('locale must be a well-formed BCP-47 tag.', 'locale');
      const before = structuredClone(row);
      const reply = genericHandler({ ...c, body: c.body.locale ? { ...c.body, locale: canonicalLocale(String(c.body.locale)) } : c.body });
      await authorStamp(c, row, before);
      // the writer of a changed text is its author; an unchanged save keeps the previous author
      if (before.authored_by && (await contentHash(before.content ?? {})) === (await contentHash(row.content ?? {}))) row.authored_by = before.authored_by;
      return decorateOne(reply, row);
    } },
    { method: 'POST', pattern: '/v1/localizations/:id/review', scope: 'localizations:write', handler: async (c) => {
      const e = c.engine;
      knownFields(c.body, ['action', 'note', 'reviewer_hint']);
      const action = c.body.action as string;
      if (!(REVIEW_ACTIONS as readonly unknown[]).includes(action)) throw bad(`action must be one of ${REVIEW_ACTIONS.join(', ')}.`, 'action');
      if (c.body.note !== undefined && c.body.note !== null && (typeof c.body.note !== 'string' || c.body.note.length > 1000)) throw bad('note is text of at most 1000 characters.', 'note');
      if (c.body.reviewer_hint !== undefined && c.body.reviewer_hint !== null && (typeof c.body.reviewer_hint !== 'string' || c.body.reviewer_hint.length > 200)) throw bad('reviewer_hint is text of at most 200 characters.', 'reviewer_hint');
      if (action === 'request_changes' && !(typeof c.body.note === 'string' && c.body.note.trim())) throw bad('Say what to change: note is required with request_changes.', 'note');
      const row = localizations(e)?.get(c.params.id);
      if (!row) throw notFound('Localization');
      const status = (row.review_status ?? 'approved') as string;
      const rule = NEXT[action]!;
      if (!rule.from.includes(status)) throw conflict(`A translation that is ${status} cannot ${action.replace('_', ' ')}; it can go from ${rule.from.join(' or ')}.`);
      const actor = actorOf(c).id;
      if (action === 'approve' && actor && row.authored_by === actor && instanceConfig(e).localization.requireFourEyes === true) {
        throw new EmulatorError('FORBIDDEN', 'Four eyes is on: a translation must be approved by someone other than the person who wrote it.');
      }
      const hash = await contentHash(row.content ?? {});
      const now = e.clock.now();
      Object.assign(row, { review_status: rule.to });
      if (action === 'approve') Object.assign(row, { reviewed_by: actor, reviewed_at: iso(now), source_hash: hash });
      if (action === 'reopen') Object.assign(row, { reviewed_by: null });
      if (c.body.reviewer_hint !== undefined) row.reviewer_hint = c.body.reviewer_hint ?? null;
      st(e).reviews.insert({ localization_id: row.id, action, from_status: status, to_status: rule.to, actor, note: typeof c.body.note === 'string' ? c.body.note.trim() || null : null, content_hash: hash, created_at: now } as any);
      audit(e, c, `localization.review_${action}`, 'localization', row.id, { from: status, to: rule.to });
      e.webhooks.emit('localization.review_decided', { object: 'localization_review', id: row.id, resource_type: row.resource_type ?? null, resource_name: row.resource_name ?? null, locale: row.locale ?? null, review_status: rule.to });
      return { body: await presentLocalization(row) };
    } },
    { method: 'GET', pattern: '/v1/localizations/:id/reviews', scope: 'localizations:read', handler: (c) => {
      const e = c.engine;
      if (!localizations(e)?.get(c.params.id)) throw notFound('Localization');
      return { body: listOf(st(e).reviews.filter((r) => r.localization_id === c.params.id).map((r) => ({ object: 'localization_review', id: r.id, localization_id: r.localization_id, action: r.action, from_status: r.from_status, to_status: r.to_status, actor: r.actor, note: r.note, content_hash: r.content_hash, created_at: iso(r.created_at) }))) };
    } },
  ];
}


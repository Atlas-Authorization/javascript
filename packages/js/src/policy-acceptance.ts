/**
 * Policy acceptance (terms of service, privacy, any policy) at sign-up and
 * sign-in: the framework-agnostic half every prebuilt UI shares.
 *
 * What lives here:
 *  - the wire types and tolerant normalisers for `GET /v1/client/policies`,
 *    `GET /v1/client/me/policies` and a sign-in attempt's `pending_policies`;
 *  - {@link PolicyAcceptanceController}, a small observable state machine: the
 *    policies to show, one checked/read flag per policy, the document the user
 *    has open (and for how long), and the `policy_acceptances` payload to send;
 *  - the pure helpers a UI needs: scroll-to-end detection, a focus trap, a safe
 *    markdown renderer for policies delivered as markdown, and the 422
 *    `POLICY_ACCEPTANCE_REQUIRED` reader;
 *  - the FAPI calls: load policies, accept them in a sign-in attempt, accept
 *    them from inside the app.
 *
 * Display modes (a policy's `display`):
 *  - `checkbox`: a checkbox, combined into one sentence when several policies
 *    use it (or one each); the policy name opens the document in an in-page
 *    viewer, not a new tab;
 *  - `scroll`: an unskippable modal, accepted only after the end of the text is
 *    seen (or the text fits); declining cancels;
 *  - `link`: a clickwrap sentence under the submit button; submitting accepts.
 *
 * Nothing here is a security boundary: `scrolled_to_end` and `view_ms` are
 * client-attested evidence the server records alongside the acceptance.
 */

import type { FieldError } from './attempt';
import type { FapiClient } from './fapi';
import {
  acceptAttemptPolicies,
  acceptPolicies,
  getMyPolicies,
  getPolicies,
  type PolicyAcceptance,
  type PolicyDisplayMode,
} from './policies';

/** A policy's display mode (same as {@link PolicyDisplayMode}). */
export type PolicyDisplay = PolicyDisplayMode;
export type PolicyAppliesTo = 'sign_up' | 'sign_in_and_sign_up';

/** One policy's current version as the Frontend API serves it, camelCased. */
export interface Policy {
  key: string;
  title: string;
  display: PolicyDisplay;
  required: boolean;
  appliesTo: PolicyAppliesTo;
  versionId: string;
  version: string;
  /** Sanitised HTML — what the user sees and what {@link Policy.contentSha256} covers. */
  contentHtml: string | null;
  contentMarkdown: string | null;
  contentUrl: string | null;
  contentSha256: string;
  effectiveAt: string | null;
  summaryOfChanges: string | null;
  /** On a sign-in's pending policy: whether the user accepted an earlier version (so "what changed" applies). Null when unknown. */
  reaccept: boolean | null;
}

/** One entry of the `policy_acceptances` request body, as {@link PolicyAcceptanceController.build} makes it (always with `display`). */
export type PolicyAcceptancePayload = PolicyAcceptance & { display: PolicyDisplay };

/** A signed-in user's standing on one policy (`GET /v1/client/me/policies`). */
export interface MyPolicyStatus {
  key: string;
  title: string;
  acceptedVersion: string | null;
  currentVersion: string | null;
  needsReaccept: boolean;
  graceEndsAt: string | null;
}

const DISPLAYS: readonly PolicyDisplay[] = ['checkbox', 'scroll', 'link'];

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** A timestamp as ISO text: the API sends epoch milliseconds; text passes through. */
function when(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  return str(v);
}

/** Read one policy from the wire (snake_case, flat or with a nested `version`/`current_version` object). */
export function normalizePolicy(raw: unknown): Policy | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const nested = [r.version, r.current_version].find((v) => v && typeof v === 'object') as Record<string, unknown> | undefined;
  const pick = (name: string): unknown => (r[name] !== undefined ? r[name] : nested?.[name]);
  const key = str(r.key) ?? str(r.policy);
  const versionId = str(pick('version_id')) ?? str(nested?.id);
  if (!key || !versionId) return null;
  const display = DISPLAYS.includes(r.display as PolicyDisplay) ? (r.display as PolicyDisplay) : 'checkbox';
  const version = str(typeof r.version === 'string' ? r.version : nested?.version) ?? '';
  return {
    key,
    title: str(r.title) ?? key,
    display,
    required: r.required !== false,
    appliesTo: r.applies_to === 'sign_in_and_sign_up' ? 'sign_in_and_sign_up' : 'sign_up',
    versionId,
    version,
    contentHtml: str(pick('content_html')),
    contentMarkdown: str(pick('content_markdown')),
    contentUrl: str(pick('content_url')),
    contentSha256: str(pick('content_sha256')) ?? '',
    effectiveAt: when(pick('effective_at')),
    summaryOfChanges: str(pick('summary_of_changes')),
    reaccept: typeof r.reaccept === 'boolean' ? r.reaccept : null,
  };
}

/** Read a list of policies from any of the shapes the API uses (`[..]`, `{policies}`, `{data}`). */
export function normalizePolicies(body: unknown): Policy[] {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? ((body as { policies?: unknown; data?: unknown }).policies ?? (body as { data?: unknown }).data)
      : null;
  if (!Array.isArray(list)) return [];
  return list.map(normalizePolicy).filter((p): p is Policy => p !== null);
}

/** The policies a sign-in attempt is waiting on (`pending_policies`). */
export function pendingPoliciesOf(attempt: { pending_policies?: unknown } | null | undefined): Policy[] {
  return normalizePolicies(attempt?.pending_policies);
}

/** Read `GET /v1/client/me/policies`. */
export function normalizeMyPolicies(body: unknown): MyPolicyStatus[] {
  const list = Array.isArray(body)
    ? body
    : ((body as { policies?: unknown; data?: unknown } | null)?.policies ?? (body as { data?: unknown } | null)?.data);
  if (!Array.isArray(list)) return [];
  const out: MyPolicyStatus[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const key = str(r.key) ?? str(r.policy);
    if (!key) continue;
    out.push({
      key,
      title: str(r.title) ?? key,
      acceptedVersion: str(r.accepted_version),
      currentVersion: str(r.current_version),
      needsReaccept: r.needs_reaccept === true,
      graceEndsAt: when(r.grace_ends_at),
    });
  }
  return out;
}

/** Whether an error list contains the server's "accept the policies" refusal. */
export function isPolicyAcceptanceRequired(errors: readonly FieldError[] | null | undefined): boolean {
  return !!errors?.some((e) => e.code === 'POLICY_ACCEPTANCE_REQUIRED');
}

// ---- FAPI calls ----------------------------------------------------------
// Thin camel-cased views over the wire helpers in `policies.ts` (`getPolicies`,
// `getMyPolicies`, `acceptPolicies`, `acceptAttemptPolicies`), for the UIs.

/** `GET /v1/client/policies`, read into {@link Policy} objects (empty on failure). */
export async function loadPolicies(
  client: FapiClient,
  opts: { locale?: string; signIn?: boolean } = {},
): Promise<Policy[]> {
  const res = await getPolicies(client, opts.locale ? { locale: opts.locale } : {});
  if (!res.ok) return [];
  const all = normalizePolicies(res.data);
  return opts.signIn ? all.filter((p) => p.appliesTo === 'sign_in_and_sign_up') : all;
}

/**
 * The policies a sign-up must show: every one with a published version. Required
 * ones block the submit; optional ones may be left unticked.
 */
export async function getSignUpPolicies(client: FapiClient, opts: { locale?: string } = {}): Promise<Policy[]> {
  return loadPolicies(client, opts);
}

/** `GET /v1/client/me/policies`, read into {@link MyPolicyStatus} entries (empty on failure). */
export async function loadMyPolicies(client: FapiClient): Promise<MyPolicyStatus[]> {
  const res = await getMyPolicies(client);
  return res.ok ? normalizeMyPolicies(res.data) : [];
}

/** `POST /v1/client/me/policies/accept`: accept from inside the app (a banner). */
export async function acceptMyPolicies(
  client: FapiClient,
  acceptances: PolicyAcceptance[],
): Promise<{ ok: boolean; errors: FieldError[] }> {
  const res = await acceptPolicies(client, acceptances);
  return res.ok ? { ok: true, errors: [] } : { ok: false, errors: res.errors };
}

/**
 * `POST /v1/client/sign_ins/:id/accept_policies`: accept the `pending_policies`
 * of an attempt in `needs_policy_acceptance` (the same call as
 * {@link acceptAttemptPolicies}). Returns the continued flow (a session ticket,
 * or still held when a newer version was published); on a refusal the attempt is kept.
 */
export const acceptSignInPolicies = acceptAttemptPolicies;

/** Parse the JSON the headless `advance` step carries in `values.policy_acceptances`. */
export function parsePolicyAcceptances(value: string | undefined): PolicyAcceptance[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as PolicyAcceptance[]) : [];
  } catch {
    return [];
  }
}

// ---- Controller ----------------------------------------------------------

export interface PolicyControllerOptions {
  /** One checkbox for every checkbox-mode policy (default) or one each. */
  combined?: boolean;
  /** Clock, injectable for tests. */
  now?: () => number;
}

interface PolicyEntry {
  checked: boolean;
  scrolledToEnd: boolean;
  viewMs: number;
  openedAt: number | null;
}

export interface PolicySnapshot {
  policies: Policy[];
  combined: boolean;
  /** Key of the document open in the in-page viewer, or null. */
  viewing: string | null;
  /** Whether the checkbox-mode policies are all ticked (combined box) . */
  combinedChecked: boolean;
}

/**
 * The state machine behind every policy UI. Subscribe for changes; read
 * {@link satisfied} to enable the submit and {@link build} for the request body.
 * State is kept per `versionId`, so a refreshed list (after a 422) keeps the
 * ticks the user already made on versions that did not change.
 */
export class PolicyAcceptanceController {
  private list: Policy[] = [];
  private entries = new Map<string, PolicyEntry>();
  private open: string | null = null;
  private listeners = new Set<() => void>();
  private readonly now: () => number;
  readonly combined: boolean;

  constructor(policies: Policy[] = [], options: PolicyControllerOptions = {}) {
    this.combined = options.combined !== false;
    this.now = options.now ?? (() => Date.now());
    this.setPolicies(policies);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }

  private entry(key: string): PolicyEntry {
    const policy = this.list.find((p) => p.key === key);
    const id = policy ? policy.versionId : key;
    let e = this.entries.get(id);
    if (!e) {
      e = { checked: false, scrolledToEnd: false, viewMs: 0, openedAt: null };
      this.entries.set(id, e);
    }
    return e;
  }

  get policies(): Policy[] {
    return this.list;
  }

  get viewing(): Policy | null {
    return this.list.find((p) => p.key === this.open) ?? null;
  }

  snapshot(): PolicySnapshot {
    const boxes = this.checkboxPolicies();
    return {
      policies: this.list,
      combined: this.combined,
      viewing: this.open,
      combinedChecked: boxes.length > 0 && boxes.every((p) => this.isChecked(p.key)),
    };
  }

  /** Replace the policies (e.g. after a refresh); ticks on unchanged versions survive. */
  setPolicies(policies: Policy[]): void {
    this.list = policies;
    if (this.open && !policies.some((p) => p.key === this.open)) this.open = null;
    this.emit();
  }

  checkboxPolicies(): Policy[] {
    return this.list.filter((p) => p.display === 'checkbox');
  }
  scrollPolicies(): Policy[] {
    return this.list.filter((p) => p.display === 'scroll');
  }
  linkPolicies(): Policy[] {
    return this.list.filter((p) => p.display === 'link');
  }

  isChecked(key: string): boolean {
    const p = this.list.find((x) => x.key === key);
    if (!p) return false;
    // A clickwrap sentence is accepted by submitting.
    if (p.display === 'link') return true;
    return this.entry(key).checked;
  }

  setChecked(key: string, checked: boolean): void {
    this.entry(key).checked = checked;
    this.emit();
  }

  /** Tick or untick every checkbox-mode policy at once (the combined box). */
  setAllChecked(checked: boolean): void {
    for (const p of this.checkboxPolicies()) this.entry(p.key).checked = checked;
    this.emit();
  }

  /** The user accepted a scroll-mode policy in its modal. */
  acceptScroll(key: string): void {
    const e = this.entry(key);
    e.checked = true;
    e.scrolledToEnd = true;
    this.emit();
  }

  /** The first scroll-mode policy still to be read and accepted, or null. */
  pendingScroll(): Policy | null {
    return this.scrollPolicies().find((p) => !this.isChecked(p.key)) ?? null;
  }

  /** Open a document in the in-page viewer and start its reading clock. */
  openDocument(key: string): void {
    if (this.open) this.closeDocument();
    if (!this.list.some((p) => p.key === key)) return;
    this.open = key;
    this.entry(key).openedAt = this.now();
    this.emit();
  }

  closeDocument(): void {
    if (!this.open) return;
    this.stopClock(this.open);
    this.open = null;
    this.emit();
  }

  /** Start the reading clock for a policy shown some other way (a modal). */
  startClock(key: string): void {
    const e = this.entry(key);
    if (e.openedAt === null) e.openedAt = this.now();
  }

  stopClock(key: string): void {
    const e = this.entry(key);
    if (e.openedAt !== null) {
      e.viewMs += Math.max(0, this.now() - e.openedAt);
      e.openedAt = null;
    }
  }

  /** The scroll-to-end flag was reached while reading `key`. */
  markScrolledToEnd(key: string): void {
    const e = this.entry(key);
    if (!e.scrolledToEnd) {
      e.scrolledToEnd = true;
      this.emit();
    }
  }

  hasScrolledToEnd(key: string): boolean {
    return this.entry(key).scrolledToEnd;
  }

  viewMs(key: string): number {
    const e = this.entry(key);
    return Math.round(e.viewMs + (e.openedAt !== null ? Math.max(0, this.now() - e.openedAt) : 0));
  }

  /** The required policies still unaccepted. Scroll-mode ones are accepted in their modal, not by a box. */
  missing(): Policy[] {
    return this.list.filter((p) => p.required && !this.isChecked(p.key));
  }

  /** Whether the submit may go: every required policy is accepted. Scroll-mode ones count as pending until read. */
  satisfied(): boolean {
    return this.missing().length === 0;
  }

  /** Whether the submit button may be enabled: scroll-mode policies are read on submit, so they do not block it. */
  canSubmit(): boolean {
    return this.list.every((p) => !p.required || p.display === 'scroll' || this.isChecked(p.key));
  }

  /** The `policy_acceptances` body: every accepted policy (and every clickwrap one). */
  build(): PolicyAcceptancePayload[] {
    const out: PolicyAcceptancePayload[] = [];
    for (const p of this.list) {
      if (!this.isChecked(p.key)) continue;
      const e = this.entry(p.key);
      const viewMs = this.viewMs(p.key);
      out.push({
        policy: p.key,
        version_id: p.versionId,
        content_sha256: p.contentSha256,
        display: p.display,
        ...(p.display === 'scroll' || e.scrolledToEnd ? { scrolled_to_end: e.scrolledToEnd } : {}),
        ...(viewMs > 0 ? { view_ms: viewMs } : {}),
      });
    }
    return out;
  }
}

/** Build a controller already holding `policies` (a sign-in's `pending_policies`, a banner's, …). */
export function createPolicyController(policies: Policy[] = [], options: PolicyControllerOptions = {}): PolicyAcceptanceController {
  return new PolicyAcceptanceController(policies, options);
}

// ---- DOM-free helpers -----------------------------------------------------

/** Whether a scroll container has reached its end (also true when the content fits). */
export function isScrolledToEnd(el: { scrollTop: number; scrollHeight: number; clientHeight: number }, slack = 2): boolean {
  return el.scrollHeight - el.clientHeight - el.scrollTop <= slack;
}

/**
 * Call `onEnd` once the end of a scroll container has been seen: an
 * IntersectionObserver on an end sentinel (scrolling, the keyboard, a screen
 * reader all count), with a scroll listener fallback; and straight away when the
 * content fits. Returns a function that stops watching.
 */
export function observeScrollEnd(scroller: HTMLElement, sentinel: HTMLElement | null, onEnd: () => void): () => void {
  let done = false;
  let observer: IntersectionObserver | null = null;
  const fire = () => {
    if (done) return;
    done = true;
    stop();
    onEnd();
  };
  const check = () => {
    if (isScrolledToEnd(scroller)) fire();
  };
  const stop = () => {
    observer?.disconnect();
    scroller.removeEventListener('scroll', check);
    if (typeof window !== 'undefined') window.removeEventListener('resize', check);
  };
  if (sentinel && typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) fire();
      },
      { root: scroller, threshold: 0 },
    );
    observer.observe(sentinel);
  }
  scroller.addEventListener('scroll', check, { passive: true });
  if (typeof window !== 'undefined') window.addEventListener('resize', check);
  // Content that fits needs no scrolling.
  check();
  return () => {
    done = true;
    stop();
  };
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Keep Tab inside `container` (a modal) and, when `escape` is `false`, swallow
 * Escape so the dialog can only be left by its buttons. Returns a release
 * function that also restores focus to whatever had it.
 */
export function trapFocus(container: HTMLElement, options: { initialFocus?: HTMLElement | null; escape?: boolean } = {}): () => void {
  const doc = container.ownerDocument;
  const previous = doc.activeElement as HTMLElement | null;
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && options.escape !== true) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('hidden'));
    if (items.length === 0) {
      event.preventDefault();
      container.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = doc.activeElement;
    if (event.shiftKey && (active === first || !container.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !container.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };
  const onFocusIn = (event: FocusEvent) => {
    if (event.target instanceof Node && !container.contains(event.target)) {
      (options.initialFocus ?? container).focus();
    }
  };
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('focusin', onFocusIn);
  (options.initialFocus ?? container).focus();
  return () => {
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('focusin', onFocusIn);
    previous?.focus?.();
  };
}

// ---- Content rendering ----------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inlineMarkdown(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return out;
}

/**
 * A small, safe markdown renderer (headings, paragraphs, lists, bold, italics,
 * code, http(s) links). Every character of input is HTML-escaped first, so it
 * can never inject markup. It is the fallback for a policy delivered as
 * markdown only; the server normally sends sanitised HTML.
 */
export function markdownToSafeHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let para: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const flushPara = () => {
    if (para.length) html.push(`<p>${inlineMarkdown(para.join(' '))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1]!.length;
      html.push(`<h${level}>${inlineMarkdown(heading[2]!)}</h${level}>`);
    } else if (bullet || numbered) {
      flushPara();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        html.push(`<${kind}>`);
        list = kind;
      }
      html.push(`<li>${inlineMarkdown((bullet ?? numbered)![1]!)}</li>`);
    } else if (line.trim() === '') {
      flushPara();
      closeList();
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  flushPara();
  closeList();
  return html.join('\n');
}

/** The HTML to draw for a policy: the server's sanitised HTML, else its markdown rendered safely. */
export function policyHtml(policy: Pick<Policy, 'contentHtml' | 'contentMarkdown'>): string {
  if (policy.contentHtml) return policy.contentHtml;
  return policy.contentMarkdown ? markdownToSafeHtml(policy.contentMarkdown) : '';
}

/** A readable "effective 24 Oct 2026" style date, or '' when unparsable. */
export function formatPolicyDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

// ---- Strings ---------------------------------------------------------------

/** The English strings every policy UI draws (`policy.*` catalog keys). */
export const POLICY_STRINGS: Readonly<Record<string, string>> = Object.freeze({
  'policy.agreeCombined': 'I agree to the {policies}',
  'policy.agreeOne': 'I agree to the {policy}',
  'policy.clickwrap': 'By continuing you agree to the {policies}.',
  'policy.and': 'and',
  'policy.read': 'Read the {policy}',
  'policy.viewerBack': 'Back',
  'policy.version': 'Version {version}',
  'policy.effective': 'Effective {date}',
  'policy.scrollHint': 'Scroll to the end to accept',
  'policy.accept': 'Accept',
  'policy.decline': 'Decline',
  'policy.summaryTitle': 'What changed',
  'policy.reacceptTitle': '{policy} has been updated',
  'policy.reacceptIntro': 'Please review and accept the updated terms to continue.',
  'policy.pendingTitle': 'Accept to continue',
  'policy.pendingIntro': 'Please accept the following to continue signing in.',
  'policy.required': 'Please accept the {policy} to continue.',
  'policy.requiredGeneric': 'Please accept the required policies to continue.',
  'policy.declined': 'You need to accept the {policy} to use this app.',
  'policy.loading': 'Loading…',
  'policy.bannerTitle': 'Updated policies',
  'policy.bannerBody': 'We have updated: {policies}. Please review and accept.',
  'policy.bannerGrace': 'Accept by {date} to keep your access.',
  'policy.bannerReview': 'Review and accept',
  'policy.submit': 'Accept and continue',
});

/** A `t` function over a catalog lookup that falls back to the English policy strings. */
export function policyTranslator(
  lookup: (key: string, vars?: Record<string, string>) => string,
): (key: string, vars?: Record<string, string>) => string {
  return (key, vars = {}) => {
    const out = lookup(key, vars);
    if (out && out !== key) return out;
    const template = POLICY_STRINGS[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (m, n: string) => vars[n] ?? m);
  };
}

/** Join titles as "A, B and C". */
export function joinTitles(titles: string[], and: string): string {
  if (titles.length <= 1) return titles[0] ?? '';
  return `${titles.slice(0, -1).join(', ')} ${and} ${titles[titles.length - 1]}`;
}

/** Split a `{name}` template into the text before and after the placeholder (for sentences that embed links). */
export function splitTemplate(template: string, name: string): [string, string] {
  const at = template.indexOf(`{${name}}`);
  if (at < 0) return [template, ''];
  return [template.slice(0, at), template.slice(at + name.length + 2)];
}

/**
 * After the server answered 422 `POLICY_ACCEPTANCE_REQUIRED` (a policy was
 * published or changed while the form was open): reload the policies into the
 * controller so the form re-shows what is needed now. Returns whether the error
 * was that refusal.
 */
export async function refreshPoliciesOnRequired(
  client: FapiClient,
  controller: PolicyAcceptanceController,
  errors: readonly FieldError[] | null | undefined,
  opts: { locale?: string } = {},
): Promise<boolean> {
  if (!isPolicyAcceptanceRequired(errors)) return false;
  const fresh = await loadPolicies(client, opts);
  if (fresh.length > 0) controller.setPolicies(fresh);
  return true;
}

/**
 * For a sign-in attempt in `needs_policy_acceptance`: a controller holding its
 * `pending_policies` — with the content fetched from `GET /v1/client/policies`
 * when the attempt only listed them.
 */
export async function controllerForPending(
  client: FapiClient,
  attempt: { pending_policies?: unknown } | null | undefined,
  opts: PolicyControllerOptions & { locale?: string } = {},
): Promise<PolicyAcceptanceController> {
  const rawList = Array.isArray(attempt?.pending_policies) ? (attempt!.pending_policies as unknown[]) : [];
  if (rawList.length === 0) {
    // Resumed from a redirect (the URL carries the attempt, not its pending
    // list): show every required policy; the server checks each acceptance.
    const all = await loadPolicies(client, opts);
    return new PolicyAcceptanceController(all.filter((p) => p.required), opts);
  }
  let pending = rawList.map(normalizePolicy).filter((p): p is Policy => p !== null);
  if (pending.some((p) => !p.contentHtml && !p.contentMarkdown)) {
    const all = await loadPolicies(client, opts);
    pending = pending.map((p, i) => {
      const full = all.find((a) => a.key === p.key);
      if (!full) return p;
      const raw = (rawList.find((r) => normalizePolicy(r)?.key === p.key) ?? rawList[i]) as Record<string, unknown>;
      const has = (name: string) => raw[name] !== undefined && raw[name] !== null;
      return {
        ...full,
        ...(has('title') ? { title: p.title } : {}),
        ...(has('display') ? { display: p.display } : {}),
        versionId: p.versionId,
        version: p.version || full.version,
        contentHtml: p.contentHtml ?? full.contentHtml,
        contentMarkdown: p.contentMarkdown ?? full.contentMarkdown,
        contentSha256: p.contentSha256 || full.contentSha256,
        summaryOfChanges: p.summaryOfChanges ?? full.summaryOfChanges,
        reaccept: p.reaccept,
      };
    });
  }
  // A sign-in acceptance is always required of the user, whatever the policy says elsewhere.
  return new PolicyAcceptanceController(pending.map((p) => ({ ...p, required: true })), opts);
}

/**
 * In-app re-acceptance for a signed-in user, framework-free: loads
 * `GET /v1/client/me/policies`, builds a controller for the policies that need
 * re-accepting ({@link begin}) and posts the acceptance ({@link accept}). The
 * framework SDKs' `<PolicyGate>` wraps it.
 */
export class PolicyGateController {
  /** The policies that need re-acceptance (empty when none, or before {@link load}). */
  pending: MyPolicyStatus[] = [];
  loaded = false;
  private listeners = new Set<() => void>();

  constructor(
    private readonly client: FapiClient,
    private readonly locale?: string,
  ) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }

  async load(): Promise<void> {
    this.pending = (await loadMyPolicies(this.client)).filter((p) => p.needsReaccept);
    this.loaded = true;
    this.emit();
  }

  /** The soonest end of grace among the pending policies, or null. */
  get graceEndsAt(): string | null {
    return this.pending.map((p) => p.graceEndsAt).filter((x): x is string => !!x).sort()[0] ?? null;
  }

  /** A controller over the pending policies' current versions, all required. */
  async begin(): Promise<PolicyAcceptanceController> {
    const all = await loadPolicies(this.client, { locale: this.locale });
    const wanted = new Set(this.pending.map((p) => p.key));
    return new PolicyAcceptanceController(all.filter((p) => wanted.has(p.key)).map((p) => ({ ...p, required: true })));
  }

  async accept(controller: PolicyAcceptanceController): Promise<{ ok: boolean; errors: FieldError[] }> {
    const res = await acceptMyPolicies(this.client, controller.build());
    if (res.ok) {
      this.pending = [];
      this.emit();
    }
    return res;
  }
}

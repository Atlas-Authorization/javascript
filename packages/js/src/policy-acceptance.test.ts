// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PolicyAcceptanceController,
  acceptSignInPolicies,
  controllerForPending,
  loadPolicies,
  isPolicyAcceptanceRequired,
  isScrolledToEnd,
  joinTitles,
  markdownToSafeHtml,
  normalizeMyPolicies,
  normalizePolicies,
  normalizePolicy,
  observeScrollEnd,
  parsePolicyAcceptances,
  pendingPoliciesOf,
  policyHtml,
  policyTranslator,
  refreshPoliciesOnRequired,
  splitTemplate,
  trapFocus,
  type Policy,
} from './policy-acceptance';
import { mountPolicyClickwrap, mountPolicyConsent, openPolicyModal, runScrollPolicies, sanitizePolicyHtml } from './policy-dom';
import { nextStep } from './attempt';
import { FapiClient, advance, requestForStep, startSignUp, initialFlow } from './fapi';
import { acceptPoliciesBody } from './policies';

const wire = (over: Record<string, unknown> = {}) => ({
  key: 'tos',
  title: 'Terms of Service',
  display: 'checkbox',
  required: true,
  applies_to: 'sign_up',
  version_id: 'polv_1',
  version: '2026-10-24',
  content_html: '<p>Hello</p>',
  content_sha256: 'abc',
  effective_at: '2026-10-24T00:00:00Z',
  summary_of_changes: null,
  ...over,
});

const pol = (over: Partial<Policy> = {}): Policy => ({ ...normalizePolicy(wire())!, ...over });

function clientWith(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const out = handler(url, init);
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://f.test', fetchImpl, referral: false }), calls };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('wire normalisation', () => {
  it('reads a flat policy', () => {
    expect(normalizePolicy(wire())).toMatchObject({ key: 'tos', versionId: 'polv_1', display: 'checkbox', required: true, appliesTo: 'sign_up', contentSha256: 'abc' });
  });
  it('reads a nested version object and defaults', () => {
    const p = normalizePolicy({ key: 'privacy', current_version: { id: 'polv_9', version: '2', content_markdown: '# x', content_sha256: 'h' }, display: 'weird' })!;
    expect(p).toMatchObject({ versionId: 'polv_9', version: '2', display: 'checkbox', contentMarkdown: '# x', required: true });
  });
  it('rejects a policy without a key or version id', () => {
    expect(normalizePolicy({ key: 'x' })).toBeNull();
    expect(normalizePolicy(null)).toBeNull();
  });
  it('accepts array, {policies} and {data} bodies', () => {
    expect(normalizePolicies([wire()])).toHaveLength(1);
    expect(normalizePolicies({ policies: [wire(), wire({ key: 'p', version_id: 'polv_2' })] })).toHaveLength(2);
    expect(normalizePolicies({ data: [wire()] })).toHaveLength(1);
    expect(normalizePolicies({})).toEqual([]);
  });
  it('reads pending_policies off an attempt', () => {
    expect(pendingPoliciesOf({ pending_policies: [wire()] })).toHaveLength(1);
    expect(pendingPoliciesOf(null)).toEqual([]);
  });
});

describe('PolicyAcceptanceController', () => {
  const tos = pol();
  const privacy = pol({ key: 'privacy', title: 'Privacy', versionId: 'polv_2', contentSha256: 'def' });
  const scroll = pol({ key: 'eula', display: 'scroll', versionId: 'polv_3' });
  const link = pol({ key: 'cookies', display: 'link', versionId: 'polv_4' });

  it('blocks until every required checkbox policy is ticked, then builds the payload', () => {
    const c = new PolicyAcceptanceController([tos, privacy]);
    expect(c.canSubmit()).toBe(false);
    expect(c.missing().map((p) => p.key)).toEqual(['tos', 'privacy']);
    c.setChecked('tos', true);
    expect(c.canSubmit()).toBe(false);
    c.setAllChecked(true);
    expect(c.canSubmit()).toBe(true);
    expect(c.build()).toEqual([
      { policy: 'tos', version_id: 'polv_1', content_sha256: 'abc', display: 'checkbox' },
      { policy: 'privacy', version_id: 'polv_2', content_sha256: 'def', display: 'checkbox' },
    ]);
  });

  it('does not require an optional policy but sends it when ticked', () => {
    const c = new PolicyAcceptanceController([pol({ required: false })]);
    expect(c.canSubmit()).toBe(true);
    expect(c.build()).toEqual([]);
    c.setChecked('tos', true);
    expect(c.build()).toHaveLength(1);
  });

  it('treats a clickwrap policy as accepted by submitting', () => {
    const c = new PolicyAcceptanceController([link]);
    expect(c.canSubmit()).toBe(true);
    expect(c.build()).toEqual([{ policy: 'cookies', version_id: 'polv_4', content_sha256: 'abc', display: 'link' }]);
  });

  it('scroll policies do not block the button but must be accepted in the modal', () => {
    const c = new PolicyAcceptanceController([scroll]);
    expect(c.canSubmit()).toBe(true);
    expect(c.satisfied()).toBe(false);
    expect(c.pendingScroll()?.key).toBe('eula');
    c.acceptScroll('eula');
    expect(c.pendingScroll()).toBeNull();
    expect(c.build()[0]).toMatchObject({ policy: 'eula', display: 'scroll', scrolled_to_end: true });
  });

  it('measures view_ms across open/close and keeps ticks over a refresh of unchanged versions', () => {
    let now = 1000;
    const c = new PolicyAcceptanceController([tos], { now: () => now });
    c.openDocument('tos');
    now = 4200;
    expect(c.viewMs('tos')).toBe(3200);
    c.closeDocument();
    now = 9000;
    expect(c.viewMs('tos')).toBe(3200);
    c.setChecked('tos', true);
    c.setPolicies([tos, privacy]);
    expect(c.isChecked('tos')).toBe(true);
    expect(c.build()[0]).toMatchObject({ view_ms: 3200 });
    // A new version resets the tick: it must be read again.
    c.setPolicies([pol({ versionId: 'polv_new' })]);
    expect(c.isChecked('tos')).toBe(false);
  });

  it('reports combined state and notifies subscribers', () => {
    const c = new PolicyAcceptanceController([tos, privacy]);
    const seen = vi.fn();
    const off = c.subscribe(seen);
    c.setAllChecked(true);
    expect(c.snapshot().combinedChecked).toBe(true);
    c.setChecked('privacy', false);
    expect(c.snapshot().combinedChecked).toBe(false);
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    c.setChecked('tos', false);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe('scroll helpers', () => {
  it('detects the end, and content that fits', () => {
    expect(isScrolledToEnd({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 })).toBe(true);
    expect(isScrolledToEnd({ scrollTop: 0, scrollHeight: 500, clientHeight: 100 })).toBe(false);
    expect(isScrolledToEnd({ scrollTop: 399, scrollHeight: 500, clientHeight: 100 })).toBe(true);
  });

  it('fires immediately when the content fits (no scrolling needed)', () => {
    const scroller = document.createElement('div');
    const onEnd = vi.fn();
    observeScrollEnd(scroller, null, onEnd);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('fires when the end sentinel becomes visible', () => {
    let trigger: (entries: { isIntersecting: boolean }[]) => void = () => undefined;
    class FakeIO {
      constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
        trigger = cb;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', FakeIO);
    const scroller = document.createElement('div');
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000 });
    Object.defineProperty(scroller, 'clientHeight', { value: 100 });
    const sentinel = document.createElement('span');
    const onEnd = vi.fn();
    observeScrollEnd(scroller, sentinel, onEnd);
    expect(onEnd).not.toHaveBeenCalled();
    trigger([{ isIntersecting: false }]);
    expect(onEnd).not.toHaveBeenCalled();
    trigger([{ isIntersecting: true }]);
    trigger([{ isIntersecting: true }]);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('trapFocus', () => {
  it('cycles Tab, swallows Escape, and restores focus', () => {
    document.body.innerHTML = '<button id="outside">o</button><div id="m" tabindex="-1"><button id="a">a</button><button id="b">b</button></div>';
    const outside = document.getElementById('outside') as HTMLButtonElement;
    outside.focus();
    const m = document.getElementById('m') as HTMLElement;
    const release = trapFocus(m, { initialFocus: document.getElementById('a') });
    expect(document.activeElement?.id).toBe('a');
    document.getElementById('b')!.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.getElementById('b')!.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('a');
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.getElementById('a')!.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    release();
    expect(document.activeElement?.id).toBe('outside');
  });
});

describe('content rendering', () => {
  it('escapes everything in markdown and only links http(s)', () => {
    const html = markdownToSafeHtml('# Title\n\nSome **bold** <script>alert(1)</script> [ok](https://a.test) [bad](javascript:alert(1))\n\n- one\n- two');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('href="https://a.test"');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('<ul>');
  });
  it('prefers the server html and falls back to markdown', () => {
    expect(policyHtml({ contentHtml: '<p>x</p>', contentMarkdown: '# y' })).toBe('<p>x</p>');
    expect(policyHtml({ contentHtml: null, contentMarkdown: '# y' })).toBe('<h1>y</h1>');
  });
  it('strips active content from html', () => {
    const out = sanitizePolicyHtml('<p onclick="x()">a<script>x()</script><a href="javascript:evil()">l</a><iframe src="//e"></iframe></p>');
    expect(out).not.toMatch(/script|onclick|javascript|iframe/i);
    expect(out).toContain('<p>');
  });
});

describe('helpers', () => {
  it('joins titles and splits templates', () => {
    expect(joinTitles(['A', 'B', 'C'], 'and')).toBe('A, B and C');
    expect(joinTitles(['A'], 'and')).toBe('A');
    expect(splitTemplate('I agree to the {policies}.', 'policies')).toEqual(['I agree to the ', '.']);
  });
  it('translator falls back to English for unknown keys', () => {
    const t = policyTranslator((k) => k);
    expect(t('policy.accept')).toBe('Accept');
    expect(t('policy.required', { policy: 'ToS' })).toBe('Please accept the ToS to continue.');
  });
  it('parses the headless payload defensively', () => {
    expect(parsePolicyAcceptances('[{"policy":"tos"}]')).toHaveLength(1);
    expect(parsePolicyAcceptances('nope')).toEqual([]);
    expect(parsePolicyAcceptances(undefined)).toEqual([]);
  });
  it('recognises the 422', () => {
    expect(isPolicyAcceptanceRequired([{ code: 'POLICY_ACCEPTANCE_REQUIRED', message: 'm' }])).toBe(true);
    expect(isPolicyAcceptanceRequired([{ code: 'X', message: 'm' }])).toBe(false);
  });
});

describe('FAPI calls', () => {
  it('a redirect-resumed held attempt (no pending list) asks for every required policy', async () => {
    const { client } = clientWith(() => ({ body: { object: 'list', data: [wire(), wire({ key: 'news', version_id: 'polv_n', required: false })] } }));
    const c = await controllerForPending(client, { id: 'sia_1', status: 'needs_policy_acceptance' } as never);
    expect(c.policies.map((p) => p.key)).toEqual(['tos']);
  });

  it('loads policies, optionally only those that apply at sign-in', async () => {
    const { client, calls } = clientWith(() => ({ body: { policies: [wire(), wire({ key: 'p', version_id: 'polv_2', applies_to: 'sign_in_and_sign_up' })] } }));
    expect(await loadPolicies(client)).toHaveLength(2);
    expect(await loadPolicies(client, { signIn: true, locale: 'fr' })).toHaveLength(1);
    expect(calls[1]!.url).toBe('https://f.test/v1/client/policies?locale=fr');
  });

  it('sends policy_acceptances on sign-up', async () => {
    const { client, calls } = clientWith(() => ({ body: { id: 'sua_1', status: 'needs_email_verification' } }));
    const c = new PolicyAcceptanceController([pol()]);
    c.setChecked('tos', true);
    await startSignUp(client, { email: 'a@b.co', password: 'pw', policyAcceptances: c.build() });
    expect(JSON.parse(calls[0]!.init.body as string).policy_acceptances).toEqual(c.build());
  });

  it('refreshes the policies after POLICY_ACCEPTANCE_REQUIRED', async () => {
    const { client } = clientWith(() => ({ body: { policies: [wire({ version_id: 'polv_new' })] } }));
    const c = new PolicyAcceptanceController([pol()]);
    c.setChecked('tos', true);
    expect(await refreshPoliciesOnRequired(client, c, [{ code: 'OTHER', message: 'x' }])).toBe(false);
    expect(await refreshPoliciesOnRequired(client, c, [{ code: 'POLICY_ACCEPTANCE_REQUIRED', message: 'x' }])).toBe(true);
    expect(c.policies[0]!.versionId).toBe('polv_new');
    expect(c.isChecked('tos')).toBe(false);
  });

  it('maps needs_policy_acceptance to the accept_policies step and endpoint', () => {
    expect(nextStep({ id: 'sia_1', status: 'needs_policy_acceptance' })).toEqual({ kind: 'accept_policies', policies: [] });
    const req = requestForStep({ id: 'sia_1', status: 'needs_policy_acceptance' }, { policy_acceptances: JSON.stringify([{ policy: 'tos' }]) });
    expect(req).toEqual({ path: '/v1/client/sign_ins/sia_1/accept_policies', body: { policy_acceptances: [{ policy: 'tos' }] } });
  });

  it('continues a sign-in attempt after accept_policies, keeping the attempt on refusal', async () => {
    const ok = clientWith(() => ({ body: { id: 'sia_1', status: 'needs_second_factor' } }));
    const next = await acceptSignInPolicies(ok.client, { ...initialFlow, attempt: { id: 'sia_1', status: 'needs_policy_acceptance' } }, [
      { policy: 'tos', version_id: 'v', content_sha256: 'h', display: 'scroll', scrolled_to_end: true },
    ]);
    expect(next.attempt?.status).toBe('needs_second_factor');
    expect(ok.calls[0]!.url).toBe('https://f.test/v1/client/sign_ins/sia_1/accept_policies');
    const bad = clientWith(() => ({ status: 422, body: { errors: [{ code: 'POLICY_ACCEPTANCE_REQUIRED', message: 'no' }] } }));
    const state = { ...initialFlow, attempt: { id: 'sia_1', status: 'needs_policy_acceptance' } };
    const failed = await acceptSignInPolicies(bad.client, state, []);
    expect(failed.attempt?.id).toBe('sia_1');
    expect(failed.errors[0]!.code).toBe('POLICY_ACCEPTANCE_REQUIRED');
  });

  it('proves the held attempt with its one-time token, else the poll secret', async () => {
    expect(acceptPoliciesBody({ attempt: { policy_acceptance_token: 'pat_1' }, pollSecret: 'ps_1' }, [])).toEqual({ policy_acceptances: [], policy_acceptance_token: 'pat_1' });
    expect(acceptPoliciesBody({ policyToken: 'pat_0', attempt: { policy_acceptance_token: 'pat_1' } }, [])).toEqual({ policy_acceptances: [], policy_acceptance_token: 'pat_0' });
    expect(acceptPoliciesBody({ attempt: {}, pollSecret: 'ps_1' }, [])).toEqual({ policy_acceptances: [], poll_secret: 'ps_1' });
    expect(acceptPoliciesBody({ attempt: null, pollSecret: null }, [])).toEqual({ policy_acceptances: [] });
    const req = requestForStep({ id: 'sia_1', status: 'needs_policy_acceptance', policy_acceptance_token: 'pat_9' }, { policy_acceptances: '[]' });
    expect(req!.body).toEqual({ policy_acceptances: [], policy_acceptance_token: 'pat_9' });
    const { client, calls } = clientWith(() => ({ body: { id: 'sia_1', status: 'needs_second_factor' } }));
    await acceptSignInPolicies(client, { ...initialFlow, attempt: { id: 'sia_1', status: 'needs_policy_acceptance', policy_acceptance_token: 'pat_2' } }, []);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ policy_acceptances: [], policy_acceptance_token: 'pat_2' });
  });

  it('advance sends the flow\'s policyToken (a redirect-seeded attempt carries no token on its view)', async () => {
    const { client, calls } = clientWith(() => ({ body: { id: 'sia_1', status: 'complete', ticket: 'tkt_1' } }));
    const state = { ...initialFlow, attempt: { id: 'sia_1', status: 'needs_policy_acceptance' }, policyToken: 'pat_r', pollSecret: 'ps_1' };
    const next = await advance(client, state, { policy_acceptances: '[]' });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ policy_acceptances: [], policy_acceptance_token: 'pat_r' });
    expect(next.ticket).toBe('tkt_1');
  });

  it('reads the API wire shapes: epoch-millisecond times, pending entries keyed by `policy`, standings in `data`', () => {
    const p = normalizePolicy({ key: 'tos', version_id: 'polv_1', version: '1', effective_at: 1_790_000_000_000, content_sha256: 'h', published_at: 1 })!;
    expect(p.effectiveAt).toBe(new Date(1_790_000_000_000).toISOString());
    const pending = pendingPoliciesOf({ pending_policies: [{ policy: 'tos', policy_id: 'pol_1', title: 'ToS', display: 'scroll', version_id: 'polv_1', version: '2', content_sha256: 'h', reaccept: true, summary_of_changes: 'x' }] });
    expect(pending[0]).toMatchObject({ key: 'tos', display: 'scroll', reaccept: true, summaryOfChanges: 'x', version: '2' });
    const mine = normalizeMyPolicies({ object: 'list', data: [{ policy: 'tos', title: 'ToS', accepted_version: '1', current_version: '2', needs_reaccept: true, blocking: false, grace_ends_at: 1_790_000_000_000 }], needs_acceptance: true });
    expect(mine[0]).toMatchObject({ key: 'tos', needsReaccept: true, graceEndsAt: new Date(1_790_000_000_000).toISOString() });
  });

  it('fills pending policies that arrive without content from the policies endpoint', async () => {
    const { client } = clientWith(() => ({ body: { policies: [wire()] } }));
    const c = await controllerForPending(client, { pending_policies: [{ key: 'tos', version_id: 'polv_1' }] });
    expect(c.policies[0]!.contentHtml).toBe('<p>Hello</p>');
    expect(c.policies[0]!.required).toBe(true);
    expect(c.policies[0]!.contentSha256).toBe('abc');
  });
});

describe('DOM: consent block and clickwrap', () => {
  const t = policyTranslator((k) => k);
  it('renders a combined checkbox whose names open the in-page viewer', () => {
    const c = new PolicyAcceptanceController([pol(), pol({ key: 'privacy', title: 'Privacy Policy', versionId: 'polv_2' })]);
    const host = document.createElement('div');
    document.body.append(host);
    mountPolicyConsent(host, c, { t });
    expect(host.querySelectorAll('input[type=checkbox]')).toHaveLength(1);
    expect(host.textContent).toContain('I agree to the Terms of Service and Privacy Policy');
    (host.querySelector('[data-atlas-policy-open=tos]') as HTMLElement).click();
    expect(host.querySelector('[data-atlas-policy-viewer=tos]')).not.toBeNull();
    expect(host.querySelector('[data-atlas-policy-content]')!.innerHTML).toContain('Hello');
    (host.querySelector('[data-atlas-policy-back]') as HTMLElement).click();
    expect(host.querySelector('[data-atlas-policy-viewer]')).toBeNull();
    (host.querySelector('input') as HTMLInputElement).click();
    expect(c.canSubmit()).toBe(true);
  });

  it('renders one checkbox per policy when not combined', () => {
    const c = new PolicyAcceptanceController([pol(), pol({ key: 'privacy', versionId: 'polv_2' })], { combined: false });
    const host = document.createElement('div');
    document.body.append(host);
    mountPolicyConsent(host, c, { t });
    expect(host.querySelectorAll('input[type=checkbox]')).toHaveLength(2);
    (host.querySelector('[data-atlas-policy-box=tos]') as HTMLInputElement).click();
    expect(c.isChecked('tos')).toBe(true);
    expect(c.isChecked('privacy')).toBe(false);
  });

  it('draws the clickwrap sentence for link policies only', () => {
    const c = new PolicyAcceptanceController([pol(), pol({ key: 'cookies', title: 'Cookie Policy', display: 'link', versionId: 'polv_4' })]);
    const host = document.createElement('p');
    mountPolicyClickwrap(host, c, { t });
    expect(host.textContent).toBe('By continuing you agree to the Cookie Policy.');
    const none = document.createElement('p');
    mountPolicyClickwrap(none, new PolicyAcceptanceController([pol()]), { t });
    expect(none.hidden).toBe(true);
  });
});

describe('DOM: the unskippable scroll modal', () => {
  const t = policyTranslator((k) => k);
  function fakeIO() {
    const observers: ((e: { isIntersecting: boolean }[]) => void)[] = [];
    class IO {
      constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
        observers.push(cb);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', IO);
    return observers;
  }
  // Make the body look scrollable so "fits" doesn't enable Accept at once.
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  function tall() {
    for (const [name, value] of [['scrollHeight', 1000], ['clientHeight', 100]] as const) {
      saved[name] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
    }
  }
  afterEach(() => {
    for (const [name, desc] of Object.entries(saved)) {
      if (desc) Object.defineProperty(HTMLElement.prototype, name, desc);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  });

  it('is a modal dialog with no close affordance; Accept waits for the end; Escape does nothing', () => {
    const io = fakeIO();
    tall();
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    const handle = openPolicyModal(pol({ display: 'scroll' }), { t, onAccept, onDecline });
    const dialog = document.querySelector('[role=dialog]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(dialog.textContent).toContain('Scroll to the end to accept');
    expect(dialog.querySelectorAll('button')).toHaveLength(2);
    const accept = dialog.querySelector('[data-atlas-policy-accept]') as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    accept.click();
    expect(onAccept).not.toHaveBeenCalled();
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    dialog.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(document.querySelector('[role=dialog]')).not.toBeNull();
    io[0]!([{ isIntersecting: true }]);
    expect(handle.acceptEnabled).toBe(true);
    expect(accept.disabled).toBe(false);
    accept.click();
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role=dialog]')).toBeNull();
  });

  it('enables Accept straight away when the text fits, and Decline cancels', () => {
    fakeIO();
    const onDecline = vi.fn();
    const handle = openPolicyModal(pol({ display: 'scroll' }), { t, onAccept: vi.fn(), onDecline });
    expect(handle.acceptEnabled).toBe(true);
    (document.querySelector('[data-atlas-policy-decline]') as HTMLElement).click();
    expect(onDecline).toHaveBeenCalled();
    expect(document.querySelector('[role=dialog]')).toBeNull();
  });

  it('shows the summary of changes only on re-acceptance', () => {
    fakeIO();
    const p = pol({ display: 'scroll', summaryOfChanges: 'We changed retention.' });
    openPolicyModal(p, { t, onAccept: vi.fn(), onDecline: vi.fn(), reaccept: true }).close();
    openPolicyModal(p, { t, onAccept: vi.fn(), onDecline: vi.fn(), reaccept: true });
    expect(document.querySelector('[data-atlas-policy-summary]')?.textContent).toContain('We changed retention.');
    document.body.innerHTML = '';
    openPolicyModal(p, { t, onAccept: vi.fn(), onDecline: vi.fn() });
    expect(document.querySelector('[data-atlas-policy-summary]')).toBeNull();
  });

  it('walks several scroll policies in turn and resolves false on decline', async () => {
    fakeIO();
    const c = new PolicyAcceptanceController([pol({ key: 'a', display: 'scroll', versionId: 'v1' }), pol({ key: 'b', display: 'scroll', versionId: 'v2' })]);
    const done = runScrollPolicies(c, { t });
    (document.querySelector('[data-atlas-policy-accept]') as HTMLElement).click();
    expect(c.isChecked('a')).toBe(true);
    (document.querySelector('[data-atlas-policy-accept]') as HTMLElement).click();
    expect(await done).toBe(true);
    expect(c.build().map((x) => x.policy)).toEqual(['a', 'b']);

    const c2 = new PolicyAcceptanceController([pol({ key: 'a', display: 'scroll', versionId: 'v1' })]);
    const declined = runScrollPolicies(c2, { t });
    (document.querySelector('[data-atlas-policy-decline]') as HTMLElement).click();
    expect(await declined).toBe(false);
    expect(c2.isChecked('a')).toBe(false);
  });
});

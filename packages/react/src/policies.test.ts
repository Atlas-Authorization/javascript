// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider } from './AtlasProvider';
import { SignUp } from './sign-up';
import { SignIn } from './sign-in';
import { PolicyGate } from './policies';
import { ATLAS_STYLES_CSS } from './styles';
import { EN_US } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}
type Route = (call: Call) => Response | undefined;

const wire = (over: Record<string, unknown> = {}) => ({
  key: 'tos',
  title: 'Terms of Service',
  display: 'checkbox',
  required: true,
  applies_to: 'sign_in_and_sign_up',
  version_id: 'polv_1',
  version: '2026-10-24',
  content_html: '<p>The terms.</p>',
  content_sha256: 'sha_tos',
  effective_at: '2026-10-24T00:00:00Z',
  summary_of_changes: 'Retention changed.',
  ...over,
});

let unmount: (() => void) | null = null;
let calls: Call[] = [];
beforeEach(() => {
  calls = [];
});
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function mount(child: ReactNode, routes: Route[], status: 'signed_out' | 'signed_in' = 'signed_out') {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    if (call.path === '/v1/client') {
      return json(status === 'signed_in' ? { session: { id: 'sess_1', status: 'active', expires_at: Date.now() + 1e6 }, user: { id: 'usr_1', email: 'a@b.co' } } : { session: null, user: null });
    }
    if (call.path === '/v1/appearance') {
      return json({ object: 'appearance', appearance: { legal: { termsUrl: 'https://x/terms', privacyUrl: null, required: true }, signUpFields: [] }, captchaFlows: {} });
    }
    for (const route of routes) {
      const res = route(call);
      if (res) return res;
    }
    return json({});
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(createElement(AtlasProvider, { publishableKey: 'pk_test_x', frontendApi: FAPI, fetchImpl, appearance: { instanceDesign: false }, children: child }));
  });
  unmount = () => act(() => root.unmount());
  return el;
}

function setInput(el: HTMLElement, name: string, value: string) {
  const input = el.querySelector(`input[name="${name}"]`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
async function submit(el: HTMLElement) {
  await act(async () => {
    el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}
async function click(node: Element | null) {
  expect(node).not.toBeNull();
  await act(async () => {
    (node as HTMLElement).click();
  });
}
/** The dialog's Accept, once the end of the text has been seen (the effect that enables it has run). */
async function clickAccept() {
  await vi.waitFor(() => expect((document.querySelector('[data-atlas-policy-accept]') as HTMLButtonElement | null)?.disabled).toBe(false));
  await click(document.querySelector('[data-atlas-policy-accept]'));
}
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);
const policiesRoute = (list: unknown[]): Route => (c) => (c.method === 'GET' && c.path === '/v1/client/policies' ? json({ policies: list }) : undefined);
const submitButton = (el: HTMLElement) => el.querySelector('button[type=submit]') as HTMLButtonElement;

describe('<SignUp> with policies', () => {
  it('replaces the legacy consent row, blocks the submit until ticked, and sends policy_acceptances', async () => {
    const el = await mount(createElement(SignUp), [
      policiesRoute([wire(), wire({ key: 'privacy', title: 'Privacy Policy', version_id: 'polv_2', content_sha256: 'sha_p' })]),
      (c) => (c.path === '/v1/client/sign_ups' ? json({ id: 'sua_1', status: 'needs_email_verification' }, 201) : undefined),
    ]);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-policies]')).not.toBeNull());
    expect(el.querySelector('input[name="consent"]')).toBeNull();
    expect(el.textContent).toContain('I agree to the Terms of Service and Privacy Policy');
    expect(submitButton(el).disabled).toBe(true);

    setInput(el, 'email', 'new@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    await click(el.querySelector('input[name="policies"]'));
    expect(submitButton(el).disabled).toBe(false);
    await submit(el);
    await vi.waitFor(() => expect(posts('/v1/client/sign_ups')).toHaveLength(1));
    expect(posts('/v1/client/sign_ups')[0]!.body!.policy_acceptances).toEqual([
      { policy: 'tos', version_id: 'polv_1', content_sha256: 'sha_tos', display: 'checkbox' },
      { policy: 'privacy', version_id: 'polv_2', content_sha256: 'sha_p', display: 'checkbox' },
    ]);
  });

  it('opens a document in the in-page viewer, not a new tab', async () => {
    const el = await mount(createElement(SignUp), [policiesRoute([wire()])]);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-policy-open]')).not.toBeNull());
    await click(el.querySelector('[data-atlas-policy-open="tos"]'));
    expect(el.querySelector('[data-atlas-policy-viewer="tos"]')?.textContent).toContain('The terms.');
    await click(el.querySelector('[data-atlas-policy-back]'));
    expect(el.querySelector('[data-atlas-policy-viewer]')).toBeNull();
  });

  it('on 422 POLICY_ACCEPTANCE_REQUIRED reloads the policies and asks again', async () => {
    let version = 'polv_1';
    const el = await mount(createElement(SignUp), [
      (c) => (c.method === 'GET' && c.path === '/v1/client/policies' ? json({ policies: [wire({ version_id: version })] }) : undefined),
      (c) => {
        if (c.path !== '/v1/client/sign_ups') return undefined;
        version = 'polv_2';
        return json({ errors: [{ code: 'POLICY_ACCEPTANCE_REQUIRED', message: 'Accept the updated terms.' }] }, 422);
      },
    ]);
    await vi.waitFor(() => expect(el.querySelector('input[name="policies"]')).not.toBeNull());
    setInput(el, 'email', 'new@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    await click(el.querySelector('input[name="policies"]'));
    await submit(el);
    await vi.waitFor(() => expect(calls.filter((c) => c.path === '/v1/client/policies')).toHaveLength(2));
    await vi.waitFor(() => expect((el.querySelector('input[name="policies"]') as HTMLInputElement).checked).toBe(false));
    expect(submitButton(el).disabled).toBe(true);
    expect(el.textContent).toContain('Accept the updated terms.');
  });

  it('draws a clickwrap sentence under the submit for link-mode policies, and accepts by submitting', async () => {
    const el = await mount(createElement(SignUp), [
      policiesRoute([wire({ display: 'link', title: 'Cookie Policy' })]),
      (c) => (c.path === '/v1/client/sign_ups' ? json({ id: 'sua_1', status: 'needs_email_verification' }, 201) : undefined),
    ]);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-policy-clickwrap]')).not.toBeNull());
    expect(el.querySelector('[data-atlas-policy-clickwrap]')!.textContent).toBe('By continuing you agree to the Cookie Policy.');
    expect(submitButton(el).disabled).toBe(false);
    setInput(el, 'email', 'new@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    await submit(el);
    await vi.waitFor(() => expect(posts('/v1/client/sign_ups')).toHaveLength(1));
    expect(posts('/v1/client/sign_ups')[0]!.body!.policy_acceptances).toEqual([
      { policy: 'tos', version_id: 'polv_1', content_sha256: 'sha_tos', display: 'link' },
    ]);
  });

  it('shows the unskippable dialog on submit for a scroll-mode policy; Decline cancels the sign-up', async () => {
    const el = await mount(createElement(SignUp), [
      policiesRoute([wire({ display: 'scroll' })]),
      (c) => (c.path === '/v1/client/sign_ups' ? json({ id: 'sua_1', status: 'needs_email_verification' }, 201) : undefined),
    ]);
    await vi.waitFor(() => expect(el.querySelector('input[name="email"]')).not.toBeNull());
    await vi.waitFor(() => expect(submitButton(el)).not.toBeNull());
    setInput(el, 'email', 'new@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    await submit(el);
    const dialog = document.querySelector('[role=dialog]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('The terms.');
    expect(posts('/v1/client/sign_ups')).toHaveLength(0);
    await click(document.querySelector('[data-atlas-policy-decline]'));
    expect(document.querySelector('[role=dialog]')).toBeNull();
    expect(el.querySelector('[data-atlas-policy-declined]')?.textContent).toContain('Terms of Service');
    expect(posts('/v1/client/sign_ups')).toHaveLength(0);
    // Try again and accept (the text fits, so Accept is live): the sign-up goes with scrolled_to_end.
    await submit(el);
    await clickAccept();
    await vi.waitFor(() => expect(posts('/v1/client/sign_ups')).toHaveLength(1));
    expect(posts('/v1/client/sign_ups')[0]!.body!.policy_acceptances).toEqual([
      expect.objectContaining({ policy: 'tos', version_id: 'polv_1', content_sha256: 'sha_tos', display: 'scroll', scrolled_to_end: true }),
    ]);
  });

  it('keeps Accept disabled until the end sentinel is visible', async () => {
    const observers: ((e: { isIntersecting: boolean }[]) => void)[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );
    const sh = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    const ch = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    // happy-dom defines these further up the chain, so "restore" means removing our own.
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 900 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 100 });
    try {
      const el = await mount(createElement(SignUp), [policiesRoute([wire({ display: 'scroll' })])]);
      await vi.waitFor(() => expect(el.querySelector('input[name="email"]')).not.toBeNull());
      await vi.waitFor(() => expect(submitButton(el)).not.toBeNull());
      setInput(el, 'email', 'a@b.co');
      setInput(el, 'password', 'blue tangerine anvil 71!');
      await submit(el);
      const accept = () => document.querySelector('[data-atlas-policy-accept]') as HTMLButtonElement;
      expect(accept().disabled).toBe(true);
      expect(document.querySelector('[role=dialog]')!.textContent).toContain('Scroll to the end to accept');
      await act(async () => observers.at(-1)!([{ isIntersecting: true }]));
      expect(accept().disabled).toBe(false);
    } finally {
      if (sh) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', sh);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
      if (ch) Object.defineProperty(HTMLElement.prototype, 'clientHeight', ch);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    }
  });
});

describe('<SignIn> with needs_policy_acceptance', () => {
  async function toPolicyStep(pending: unknown[]) {
    const el = await mount(createElement(SignIn), [
      policiesRoute([wire({ display: 'scroll' }), wire({ key: 'privacy', title: 'Privacy Policy', version_id: 'polv_2', content_sha256: 'sha_p' })]),
      (c) => (c.method === 'POST' && c.path === '/v1/client/sign_ins' ? json({ id: 'sia_1', status: 'needs_first_factor', supported_first_factors: ['password'] }) : undefined),
      (c) =>
        c.path === '/v1/client/sign_ins/sia_1/attempt_first_factor'
          ? json({ id: 'sia_1', status: 'needs_policy_acceptance', pending_policies: pending })
          : undefined,
      (c) => (c.path === '/v1/client/sign_ins/sia_1/accept_policies' ? json({ id: 'sia_1', status: 'needs_second_factor' }) : undefined),
    ]);
    setInput(el, 'identifier', 'a@b.co');
    await submit(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    setInput(el, 'password', 'pw');
    await submit(el);
    return el;
  }

  it('shows the dialog for a scroll policy and continues the attempt (to MFA) once accepted', async () => {
    const el = await toPolicyStep([{ key: 'tos', version_id: 'polv_1' }]);
    await vi.waitFor(() => expect(document.querySelector('[role=dialog]')).not.toBeNull());
    // Re-acceptance shows what changed.
    expect(document.querySelector('[data-atlas-policy-summary]')?.textContent).toContain('Retention changed.');
    await clickAccept();
    await vi.waitFor(() => expect(posts('/v1/client/sign_ins/sia_1/accept_policies')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins/sia_1/accept_policies')[0]!.body).toEqual({
      policy_acceptances: [expect.objectContaining({ policy: 'tos', version_id: 'polv_1', content_sha256: 'sha_tos', display: 'scroll', scrolled_to_end: true })],
    });
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
  });

  it('shows checkboxes for checkbox policies and sends them with the button', async () => {
    const el = await toPolicyStep([{ key: 'privacy', version_id: 'polv_2' }]);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-policy-step]')).not.toBeNull());
    await vi.waitFor(() => expect(el.querySelector('input[name="policies"]')).not.toBeNull());
    const cont = () => el.querySelector('[data-atlas-policy-continue]') as HTMLButtonElement;
    expect(cont().disabled).toBe(true);
    await click(el.querySelector('input[name="policies"]'));
    expect(cont().disabled).toBe(false);
    await click(cont());
    await vi.waitFor(() => expect(posts('/v1/client/sign_ins/sia_1/accept_policies')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins/sia_1/accept_policies')[0]!.body).toEqual({
      policy_acceptances: [{ policy: 'privacy', version_id: 'polv_2', content_sha256: 'sha_p', display: 'checkbox' }],
    });
  });

  it('declining cancels the attempt and says why', async () => {
    const el = await toPolicyStep([{ key: 'tos', version_id: 'polv_1' }]);
    await vi.waitFor(() => expect(document.querySelector('[role=dialog]')).not.toBeNull());
    await click(document.querySelector('[data-atlas-policy-decline]'));
    await vi.waitFor(() => expect(el.querySelector('input[name="identifier"]')).not.toBeNull());
    expect(el.textContent).toContain('You need to accept the Terms of Service');
    expect(posts('/v1/client/sign_ins/sia_1/accept_policies')).toHaveLength(0);
  });
});

describe('<PolicyGate>', () => {
  it('shows a re-acceptance banner for a signed-in user and posts the acceptance', async () => {
    const el = await mount(createElement(PolicyGate, { children: createElement('span', { id: 'app' }, 'app') }), [
      (c) =>
        c.method === 'GET' && c.path === '/v1/client/me/policies'
          ? json({ policies: [{ key: 'tos', title: 'Terms of Service', accepted_version: '1', current_version: '2', needs_reaccept: true, grace_ends_at: '2026-11-01T00:00:00Z' }] })
          : undefined,
      policiesRoute([wire({ display: 'scroll' })]),
      (c) => (c.path === '/v1/client/me/policies/accept' ? json({ ok: true }) : undefined),
    ], 'signed_in');
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-policy-banner]')).not.toBeNull());
    expect(el.querySelector('[data-atlas-policy-banner]')!.textContent).toContain('Accept by 2026-11-01');
    expect(el.querySelector('#app')).not.toBeNull();
    await click(el.querySelector('[data-atlas-policy-banner] button'));
    await vi.waitFor(() => expect(document.querySelector('[role=dialog]')).not.toBeNull());
    await clickAccept();
    await vi.waitFor(() => expect(posts('/v1/client/me/policies/accept')).toHaveLength(1));
    expect(posts('/v1/client/me/policies/accept')[0]!.body).toEqual({
      policy_acceptances: [expect.objectContaining({ policy: 'tos', version_id: 'polv_1', content_sha256: 'sha_tos', display: 'scroll', scrolled_to_end: true })],
    });
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-policy-banner]')).toBeNull());
  });

  it('renders nothing extra for a user with nothing to accept', async () => {
    const el = await mount(createElement(PolicyGate), [(c) => (c.path === '/v1/client/me/policies' ? json({ policies: [] }) : undefined)], 'signed_in');
    await act(async () => {});
    expect(el.querySelector('[data-atlas-policy-banner]')).toBeNull();
  });
});

describe('catalog and styles', () => {
  it('ships every policy string and the stylesheet', () => {
    for (const key of ['policy.agreeCombined', 'policy.scrollHint', 'policy.accept', 'policy.decline', 'policy.summaryTitle']) {
      expect(EN_US[key], key).toBeTruthy();
    }
    expect(ATLAS_STYLES_CSS).toContain('.atlas-policy-overlay');
  });
});

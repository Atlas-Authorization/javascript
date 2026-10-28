import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@solidjs/testing-library';
import { h } from './h';
import { AtlasProvider } from './provider';
import { PolicyGate, SignIn, SignUp } from './widgets';

/** Policy acceptance in the Solid widgets: sign-up consent, scroll dialog, sign-in step, in-app gate. */

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
  version: '1',
  content_html: '<p>Terms body</p>',
  content_sha256: 'sha_tos',
  effective_at: null,
  summary_of_changes: 'Retention changed.',
  ...over,
});

let calls: Call[] = [];
beforeEach(() => {
  calls = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mountFlow(component: typeof SignIn | typeof SignUp | typeof PolicyGate, routes: Route[], signedIn = false) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    if (call.path === '/v1/client') {
      return json(
        signedIn
          ? { session: { id: 'sess_1', status: 'active', last_active_organization_id: null }, user: { id: 'user_1', first_name: 'Ada', last_name: null, username: null, image_url: null, public_metadata: {}, unsafe_metadata: {}, mfa_enabled: false, has_password: true } }
          : { session: null, user: null },
      );
    }
    if (call.path === '/v1/appearance') {
      return json({ object: 'appearance', appearance: { legal: { termsUrl: null, privacyUrl: null, required: false }, signUpFields: [] }, captchaFlows: {} });
    }
    for (const route of routes) {
      const res = route(call);
      if (res) return res;
    }
    return json({});
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  const { container } = render(() => h(AtlasProvider, { publishableKey: 'pk_test_x', frontendApi: FAPI, fetchImpl }, h(component, {})));
  await vi.waitFor(() => expect(calls.some((c) => c.path === '/v1/appearance' || c.path === '/v1/client')).toBe(true));
  await new Promise((r) => setTimeout(r, 0));
  return container as HTMLElement;
}

function setInput(el: HTMLElement, name: string, value: string) {
  (el.querySelector(`input[name="${name}"]`) as HTMLInputElement).value = value;
}
const submit = (el: HTMLElement) => el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const policiesRoute = (list: unknown[]): Route => (c) => (c.method === 'GET' && c.path === '/v1/client/policies' ? json({ policies: list }) : undefined);
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

describe('<SignUp> with policies', () => {
  it('shows the consent block, gates the button, and posts policy_acceptances', async () => {
    const el = await mountFlow(SignUp, [
      policiesRoute([wire(), wire({ key: 'privacy', title: 'Privacy Policy', version_id: 'polv_2', content_sha256: 'sha_p' })]),
      (c) => (c.path === '/v1/client/sign_ups' ? json({ id: 'sua_1', status: 'needs_email_verification' }, 201) : undefined),
    ]);
    await vi.waitFor(() => expect(el.querySelector('input[name="policies"]')).not.toBeNull());
    expect(el.textContent).toContain('I agree to the Terms of Service and Privacy Policy');
    const button = () => el.querySelector('button[type=submit]') as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    (el.querySelector('input[name="policies"]') as HTMLInputElement).click();
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    setInput(el, 'email', 'new@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    submit(el);
    await vi.waitFor(() => expect(posts('/v1/client/sign_ups')).toHaveLength(1));
    const body = posts('/v1/client/sign_ups')[0]!.body!;
    expect(body.policy_acceptances).toEqual([
      { policy: 'tos', version_id: 'polv_1', content_sha256: 'sha_tos', display: 'checkbox' },
      { policy: 'privacy', version_id: 'polv_2', content_sha256: 'sha_p', display: 'checkbox' },
    ]);
    // The policy boxes are the controller's, never sign-up fields.
    expect(body.fields).toBeUndefined();
  });

  it('opens the unskippable dialog for a scroll policy on submit; Decline cancels', async () => {
    const el = await mountFlow(SignUp, [
      policiesRoute([wire({ display: 'scroll' })]),
      (c) => (c.path === '/v1/client/sign_ups' ? json({ id: 'sua_1', status: 'needs_email_verification' }, 201) : undefined),
    ]);
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/v1/client/policies')).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    setInput(el, 'email', 'new@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    submit(el);
    await vi.waitFor(() => expect(document.querySelector('[role=dialog]')).not.toBeNull());
    expect(document.querySelector('[role=dialog]')!.getAttribute('aria-modal')).toBe('true');
    (document.querySelector('[data-atlas-policy-decline]') as HTMLElement).click();
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-policy-declined]')).not.toBeNull());
    expect(posts('/v1/client/sign_ups')).toHaveLength(0);
  });
});

describe('<SignIn> with needs_policy_acceptance', () => {
  it('shows the dialog (with what changed) and continues the attempt once accepted', async () => {
    const el = await mountFlow(SignIn, [
      policiesRoute([wire({ display: 'scroll' })]),
      (c) => (c.method === 'POST' && c.path === '/v1/client/sign_ins' ? json({ id: 'sia_1', status: 'needs_policy_acceptance', pending_policies: [{ key: 'tos', version_id: 'polv_1' }] }) : undefined),
      (c) => (c.path === '/v1/client/sign_ins/sia_1/accept_policies' ? json({ id: 'sia_1', status: 'needs_second_factor' }) : undefined),
    ]);
    await vi.waitFor(() => expect(el.querySelector('input[name="identifier"]')).not.toBeNull());
    setInput(el, 'identifier', 'a@b.co');
    submit(el);
    await vi.waitFor(() => expect(document.querySelector('[role=dialog]')).not.toBeNull());
    expect(document.querySelector('[data-atlas-policy-summary]')!.textContent).toContain('Retention changed.');
    (document.querySelector('[data-atlas-policy-accept]') as HTMLElement).click();
    await vi.waitFor(() => expect(posts('/v1/client/sign_ins/sia_1/accept_policies')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins/sia_1/accept_policies')[0]!.body).toEqual({
      policy_acceptances: [expect.objectContaining({ policy: 'tos', version_id: 'polv_1', content_sha256: 'sha_tos', display: 'scroll', scrolled_to_end: true })],
    });
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
  });

  it('declining cancels the attempt and says why', async () => {
    const el = await mountFlow(SignIn, [
      policiesRoute([wire({ display: 'scroll' })]),
      (c) => (c.method === 'POST' && c.path === '/v1/client/sign_ins' ? json({ id: 'sia_1', status: 'needs_policy_acceptance', pending_policies: [{ key: 'tos', version_id: 'polv_1' }] }) : undefined),
    ]);
    await vi.waitFor(() => expect(el.querySelector('input[name="identifier"]')).not.toBeNull());
    setInput(el, 'identifier', 'a@b.co');
    submit(el);
    await vi.waitFor(() => expect(document.querySelector('[role=dialog]')).not.toBeNull());
    (document.querySelector('[data-atlas-policy-decline]') as HTMLElement).click();
    await vi.waitFor(() => expect(el.querySelector('input[name="identifier"]')).not.toBeNull());
    expect(el.textContent).toContain('You need to accept the Terms of Service');
  });
});

describe('<PolicyGate>', () => {
  it('shows a banner for a signed-in user whose policy needs re-acceptance and posts the acceptance', async () => {
    const el = await mountFlow(
      PolicyGate,
      [
        (c) =>
          c.method === 'GET' && c.path === '/v1/client/me/policies'
            ? json({ policies: [{ key: 'tos', title: 'Terms of Service', accepted_version: '1', current_version: '2', needs_reaccept: true, grace_ends_at: '2026-11-01T00:00:00Z' }] })
            : undefined,
        policiesRoute([wire({ display: 'scroll' })]),
        (c) => (c.path === '/v1/client/me/policies/accept' ? json({ ok: true }) : undefined),
      ],
      true,
    );
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-policy-banner]')).not.toBeNull());
    expect(el.querySelector('[data-atlas-policy-banner]')!.textContent).toContain('Accept by 2026-11-01');
    (el.querySelector('[data-atlas-policy-banner] button') as HTMLElement).click();
    await vi.waitFor(() => expect(document.querySelector('[role=dialog]')).not.toBeNull());
    (document.querySelector('[data-atlas-policy-accept]') as HTMLElement).click();
    await vi.waitFor(() => expect(posts('/v1/client/me/policies/accept')).toHaveLength(1));
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-policy-banner]')).toBeNull());
  });
});

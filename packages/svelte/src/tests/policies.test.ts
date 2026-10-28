import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { ATLAS_KEY, createAtlasClient } from '../lib/context';
import SignIn from '../lib/components/SignIn.svelte';
import SignUp from '../lib/components/SignUp.svelte';

/** Policy acceptance in the Svelte components: sign-up consent, scroll dialog, sign-in step. */
vi.mock('@atlasauth/js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@atlasauth/js')>();
  return { ...actual, readRedirectResult: () => null };
});

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
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mountFlow(component: typeof SignIn | typeof SignUp, routes: Route[]) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    if (call.path === '/v1/client') return json({ session: null, user: null });
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
  const client = createAtlasClient({ publishableKey: 'pk_test_x', frontendApi: FAPI, fetchImpl, manualBoot: true });
  const view = render(component, { context: new Map([[ATLAS_KEY, client]]) });
  await waitFor(() => expect(calls.some((c) => c.path === '/v1/appearance')).toBe(true));
  return view.container as HTMLElement;
}

async function setInput(el: HTMLElement, name: string, value: string) {
  await fireEvent.input(el.querySelector(`input[name="${name}"]`) as HTMLInputElement, { target: { value } });
}
const submit = (el: HTMLElement) => fireEvent.submit(el.querySelector('form')!);
const policiesRoute = (list: unknown[]): Route => (c) => (c.method === 'GET' && c.path === '/v1/client/policies' ? json({ policies: list }) : undefined);
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

describe('<SignUp> with policies', () => {
  it('replaces the legacy row, gates the button and posts policy_acceptances', async () => {
    const el = await mountFlow(SignUp, [
      policiesRoute([wire(), wire({ key: 'privacy', title: 'Privacy Policy', version_id: 'polv_2', content_sha256: 'sha_p' })]),
      (c) => (c.path === '/v1/client/sign_ups' ? json({ id: 'sua_1', status: 'needs_email_verification' }, 201) : undefined),
    ]);
    await waitFor(() => expect(el.querySelector('input[name="policies"]')).not.toBeNull());
    expect(el.textContent).toContain('I agree to the Terms of Service and Privacy Policy');
    expect((el.querySelector('button[type=submit]') as HTMLButtonElement).disabled).toBe(true);
    await setInput(el, 'email', 'new@example.com');
    await setInput(el, 'password', 'blue tangerine anvil 71!');
    (el.querySelector('input[name="policies"]') as HTMLInputElement).click();
    await waitFor(() => expect((el.querySelector('button[type=submit]') as HTMLButtonElement).disabled).toBe(false));
    await submit(el);
    await waitFor(() => expect(posts('/v1/client/sign_ups')).toHaveLength(1));
    expect(posts('/v1/client/sign_ups')[0]!.body!.policy_acceptances).toEqual([
      { policy: 'tos', version_id: 'polv_1', content_sha256: 'sha_tos', display: 'checkbox' },
      { policy: 'privacy', version_id: 'polv_2', content_sha256: 'sha_p', display: 'checkbox' },
    ]);
  });

  it('opens the unskippable dialog for a scroll policy on submit; Decline cancels', async () => {
    const el = await mountFlow(SignUp, [
      policiesRoute([wire({ display: 'scroll' })]),
      (c) => (c.path === '/v1/client/sign_ups' ? json({ id: 'sua_1', status: 'needs_email_verification' }, 201) : undefined),
    ]);
    await waitFor(() => expect(calls.some((c) => c.path === '/v1/client/policies')).toBe(true));
    await setInput(el, 'email', 'new@example.com');
    await setInput(el, 'password', 'blue tangerine anvil 71!');
    await submit(el);
    await waitFor(() => expect(document.querySelector('[role=dialog]')).not.toBeNull());
    expect(document.querySelector('[role=dialog]')!.getAttribute('aria-modal')).toBe('true');
    (document.querySelector('[data-atlas-policy-decline]') as HTMLElement).click();
    await waitFor(() => expect(el.querySelector('[data-atlas-policy-declined]')).not.toBeNull());
    expect(posts('/v1/client/sign_ups')).toHaveLength(0);
    await submit(el);
    await waitFor(() => expect(document.querySelector('[data-atlas-policy-accept]')).not.toBeNull());
    (document.querySelector('[data-atlas-policy-accept]') as HTMLElement).click();
    await waitFor(() => expect(posts('/v1/client/sign_ups')).toHaveLength(1));
    expect(posts('/v1/client/sign_ups')[0]!.body!.policy_acceptances).toEqual([
      expect.objectContaining({ policy: 'tos', version_id: 'polv_1', content_sha256: 'sha_tos', display: 'scroll', scrolled_to_end: true }),
    ]);
  });
});

describe('<SignIn> with needs_policy_acceptance', () => {
  async function toStep() {
    const el = await mountFlow(SignIn, [
      policiesRoute([wire({ display: 'scroll' })]),
      (c) => (c.method === 'POST' && c.path === '/v1/client/sign_ins' ? json({ id: 'sia_1', status: 'needs_policy_acceptance', pending_policies: [{ key: 'tos', version_id: 'polv_1' }] }) : undefined),
      (c) => (c.path === '/v1/client/sign_ins/sia_1/accept_policies' ? json({ id: 'sia_1', status: 'needs_second_factor' }) : undefined),
    ]);
    await setInput(el, 'identifier', 'a@b.co');
    await submit(el);
    await waitFor(() => expect(document.querySelector('[role=dialog]')).not.toBeNull());
    return el;
  }

  it('shows the dialog with what changed and continues the attempt once accepted', async () => {
    const el = await toStep();
    expect(document.querySelector('[data-atlas-policy-summary]')!.textContent).toContain('Retention changed.');
    (document.querySelector('[data-atlas-policy-accept]') as HTMLElement).click();
    await waitFor(() => expect(posts('/v1/client/sign_ins/sia_1/accept_policies')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins/sia_1/accept_policies')[0]!.body).toEqual({
      policy_acceptances: [expect.objectContaining({ policy: 'tos', version_id: 'polv_1', content_sha256: 'sha_tos', display: 'scroll', scrolled_to_end: true })],
    });
    await waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
  });

  it('declining cancels the attempt and says why', async () => {
    const el = await toStep();
    (document.querySelector('[data-atlas-policy-decline]') as HTMLElement).click();
    await waitFor(() => expect(el.querySelector('input[name="identifier"]')).not.toBeNull());
    expect(el.textContent).toContain('You need to accept the Terms of Service');
  });
});

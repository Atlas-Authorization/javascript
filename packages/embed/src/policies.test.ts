// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasWidget } from './widget';
import type { AppearanceResponse, PublicAppearance } from './appearance';

/** The widget's policy acceptance: sign-up consent block + sign-in `needs_policy_acceptance` step. */

const APPEARANCE: PublicAppearance = {
  applicationName: 'Acme',
  logoUrl: null,
  colorPrimary: '#5b5bd6',
  colorBackground: '#ffffff',
  colorText: '#1c1c1f',
  colorAccent: '#5b5bd6',
  colorCard: '#ffffff',
  colorBorder: '#e4e4e9',
  borderRadius: '10px',
  theme: 'light',
  fontStack: 'system-ui',
  layout: 'centered',
  headline: null,
  subheadline: null,
  footer: null,
  providerOrder: [],
  providerHidden: [],
};
const envelope = (): AppearanceResponse => ({
  object: 'appearance',
  appearance: APPEARANCE,
  providers: [],
  strategies: { password: true, emailCode: false, emailLink: false, passkey: false, phoneCode: false, siwe: false },
});

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

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}
function makeFetch(handlers: Record<string, (body: Record<string, unknown> | undefined) => { status?: number; body: unknown }>) {
  const calls: Recorded[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname, body });
    const handler = handlers[`${method} ${url.pathname}`];
    const result = handler ? handler(body) : { status: 404, body: { errors: [{ code: 'NO_ROUTE', message: 'no route' }] } };
    return new Response(JSON.stringify(result.body ?? {}), { status: result.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const flush = async (times = 8): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
};
const OPTS = { publishableKey: 'pk_test_1', frontendApi: 'https://accounts.acme.com' };

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function type(root: HTMLElement, name: string, value: string) {
  const input = root.querySelector(`input[name="${name}"]`) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('sign-up policies', () => {
  it('draws the consent block and clickwrap, gates the button, and posts policy_acceptances', async () => {
    const { impl, calls } = makeFetch({
      'GET /v1/appearance': () => ({ body: envelope() }),
      'GET /v1/client/policies': () => ({
        body: { policies: [wire(), wire({ key: 'cookies', title: 'Cookie Policy', display: 'link', version_id: 'polv_2', content_sha256: 'sha_c' })] },
      }),
      'POST /v1/client/sign_ups': () => ({ status: 201, body: { id: 'sua_1', status: 'needs_email_verification' } }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, mode: 'sign-up', fetchImpl: impl }).mount();
    await flush();

    expect(root.textContent).toContain('I agree to the Terms of Service');
    expect(root.querySelector('[data-atlas-policy-clickwrap]')!.textContent).toBe('By continuing you agree to the Cookie Policy.');
    const button = root.querySelector('button[type=submit]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    (root.querySelector('input[name="policies"]') as HTMLInputElement).click();
    expect(button.disabled).toBe(false);
    type(root, 'identifier', 'a@b.co');
    type(root, 'password', 'blue tangerine anvil 71!');
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    const post = calls.find((c) => c.method === 'POST' && c.path === '/v1/client/sign_ups')!;
    expect(post.body!.policy_acceptances).toEqual([
      { policy: 'tos', version_id: 'polv_1', content_sha256: 'sha_tos', display: 'checkbox' },
      { policy: 'cookies', version_id: 'polv_2', content_sha256: 'sha_c', display: 'link' },
    ]);
  });

  it('keeps the legacy consent row when the instance has no policies', async () => {
    const { impl } = makeFetch({ 'GET /v1/appearance': () => ({ body: envelope() }) });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, mode: 'sign-up', fetchImpl: impl }).mount();
    await flush();
    expect(root.querySelector('[data-atlas-policies]')).toBeNull();
    expect(root.querySelector('input[name="identifier"]')).not.toBeNull();
  });

  it('opens the unskippable dialog for a scroll policy on submit; Decline cancels', async () => {
    const { impl, calls } = makeFetch({
      'GET /v1/appearance': () => ({ body: envelope() }),
      'GET /v1/client/policies': () => ({ body: { policies: [wire({ display: 'scroll' })] } }),
      'POST /v1/client/sign_ups': () => ({ status: 201, body: { id: 'sua_1', status: 'needs_email_verification' } }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, mode: 'sign-up', fetchImpl: impl }).mount();
    await flush();
    type(root, 'identifier', 'a@b.co');
    type(root, 'password', 'blue tangerine anvil 71!');
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const dialog = root.querySelector('[role=dialog]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    (root.querySelector('[data-atlas-policy-decline]') as HTMLElement).click();
    await flush();
    expect(root.querySelector('[role=dialog]')).toBeNull();
    expect(calls.some((c) => c.path === '/v1/client/sign_ups')).toBe(false);
    expect(root.textContent).toContain('You need to accept the Terms of Service');
  });
});

describe('sign-in needs_policy_acceptance', () => {
  async function toStep(pending: unknown[]) {
    const fetched = makeFetch({
      'GET /v1/appearance': () => ({ body: envelope() }),
      'GET /v1/client/policies': () => ({ body: { policies: [wire({ display: 'scroll' })] } }),
      'POST /v1/client/sign_ins': () => ({ body: { id: 'sia_1', status: 'needs_policy_acceptance', pending_policies: pending } }),
      'POST /v1/client/sign_ins/sia_1/accept_policies': () => ({ body: { id: 'sia_1', status: 'needs_second_factor' } }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: fetched.impl }).mount();
    await flush();
    type(root, 'identifier', 'a@b.co');
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    return { root, ...fetched };
  }

  it('shows the dialog with the summary of changes and continues the attempt on Accept', async () => {
    const { root, calls } = await toStep([{ key: 'tos', version_id: 'polv_1' }]);
    expect(root.querySelector('[role=dialog]')).not.toBeNull();
    expect(root.querySelector('[data-atlas-policy-summary]')!.textContent).toContain('Retention changed.');
    (root.querySelector('[data-atlas-policy-accept]') as HTMLElement).click();
    await flush();
    const post = calls.find((c) => c.path === '/v1/client/sign_ins/sia_1/accept_policies')!;
    expect(post.body).toEqual({
      policy_acceptances: [expect.objectContaining({ policy: 'tos', version_id: 'polv_1', content_sha256: 'sha_tos', display: 'scroll', scrolled_to_end: true })],
    });
  });

  it('declining returns to the start with an explanation', async () => {
    const { root, calls } = await toStep([{ key: 'tos', version_id: 'polv_1' }]);
    (root.querySelector('[data-atlas-policy-decline]') as HTMLElement).click();
    await flush();
    expect(root.querySelector('input[name="identifier"]')).not.toBeNull();
    expect(root.textContent).toContain('You need to accept the Terms of Service');
    expect(calls.some((c) => c.path.endsWith('/accept_policies'))).toBe(false);
  });
});

// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider } from './AtlasProvider';
import { AttemptFlow, IDENTITY_POLL_MS } from './flow';
import { EN_US } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FAPI = 'https://fapi.example';
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const held = (idv?: Record<string, unknown>) => ({
  id: 'sia_1',
  object: 'sign_in_attempt' as const,
  status: 'needs_required_action',
  pending_required_actions: [{ id: 'ra_1', action: 'identity_verification', url: null, reason: null }],
  ...(idv ? { identity_verification: idv } : {}),
});

async function mount(attempt: ReturnType<typeof held>, onSubmit: (v: Record<string, string>) => void) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/client') return json({ session: null, user: null });
    if (path === '/v1/appearance') return json({ object: 'appearance', appearance: { legal: { termsUrl: null, privacyUrl: null, required: false }, signUpFields: [] }, captchaFlows: {} });
    return json({});
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  const render = async (a: ReturnType<typeof held>) =>
    act(async () => {
      root!.render(
        createElement(AtlasProvider, {
          publishableKey: 'pk_test_x',
          frontendApi: FAPI,
          fetchImpl,
          appearance: { instanceDesign: false },
          children: createElement(AttemptFlow, { attempt: a as never, onSubmit, busy: false, errors: [], titleKey: 'signIn.title' }),
        }),
      );
    });
  await render(attempt);
  return { el, render };
}

describe('<AttemptFlow> identity_verification required action', () => {
  it('offers a start button that asks the server to start the check', async () => {
    const onSubmit = vi.fn();
    const { el } = await mount(held(), onSubmit);
    expect(el.textContent).toContain(EN_US['requiredAction.idvIntro']);
    expect(el.querySelector('a')).toBeNull();
    const start = [...el.querySelectorAll('button')].find((b) => b.textContent === EN_US['requiredAction.idvStart']);
    await act(async () => start!.click());
    expect(onSubmit).toHaveBeenCalledWith({ action: 'identity_verification', step: 'start' });
  });

  it('opens the verification page in a new tab, re-reads on demand and keeps polling', async () => {
    vi.useFakeTimers();
    const onSubmit = vi.fn();
    const { el } = await mount(held({ status: 'pending', url: 'https://withpersona.com/verify?x=1', reason: null }), onSubmit);
    const link = el.querySelector('a') as HTMLAnchorElement;
    expect(link.href).toBe('https://withpersona.com/verify?x=1');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(el.textContent).toContain(EN_US['requiredAction.idvWaiting']);

    const done = [...el.querySelectorAll('button')].find((b) => b.textContent === EN_US['requiredAction.idvCheck']);
    await act(async () => done!.click());
    expect(onSubmit).toHaveBeenLastCalledWith({ action: 'identity_verification' });

    onSubmit.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(IDENTITY_POLL_MS * 2 + 10);
    });
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenCalledWith({ action: 'identity_verification' });
  });

  it('says so when the check is declined or in review, and offers to start again', async () => {
    const declined = await mount(held({ status: 'declined', url: null, reason: 'document_expired' }), vi.fn());
    expect(declined.el.textContent).toContain(EN_US['requiredAction.idvDeclined']);
    expect([...declined.el.querySelectorAll('button')].some((b) => b.textContent === EN_US['requiredAction.idvStart'])).toBe(true);
    await declined.render(held({ status: 'needs_review', url: 'https://v.example/x', reason: null }));
    expect(declined.el.textContent).toContain(EN_US['requiredAction.idvReview']);
  });

  it('stops polling when the page is no longer waiting on the check', async () => {
    vi.useFakeTimers();
    const onSubmit = vi.fn();
    const { render } = await mount(held({ status: 'pending', url: 'https://v.example/x', reason: null }), onSubmit);
    await render(held());
    onSubmit.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(IDENTITY_POLL_MS * 3);
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

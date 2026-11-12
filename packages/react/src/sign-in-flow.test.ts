// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider } from './AtlasProvider';
import { useSignInFlow } from './sign-in-flow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('useSignInFlow()', () => {
  it('re-renders with the next typed step and draws nothing itself', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/client/sign_ins')) {
        return json({ object: 'sign_in_attempt', id: 'sia_1', status: 'needs_first_factor', supported_first_factors: ['password'] }, 201);
      }
      return json({ session: null, user: null });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);

    let latest: ReturnType<typeof useSignInFlow> | null = null;
    const Probe = () => {
      latest = useSignInFlow();
      return null;
    };
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        createElement(AtlasProvider, {
          publishableKey: 'pk_test_x',
          frontendApi: 'https://fapi.example',
          fetchImpl,
          appearance: { instanceDesign: false },
          children: createElement(Probe),
        }),
      );
    });
    unmount = () => act(() => root.unmount());

    expect(latest!.snapshot.step).toEqual({ type: 'needs_identifier' });
    await act(async () => {
      await latest!.submitIdentifier('a@b.co');
    });
    expect(latest!.snapshot.step).toEqual({ type: 'needs_first_factor', factors: ['password'] });
    // Only the provider's own head/sprite markup is present: no form, control or text from the hook.
    expect(el.querySelectorAll('form, input, button, label, a, p, h1, h2')).toHaveLength(0);
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('style').forEach((n) => n.remove());
    expect(copy.textContent).toBe('');
  });
});

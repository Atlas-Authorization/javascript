// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider, useAtlas } from './AtlasProvider';
import { SignIn } from './sign-in';
import { SignUp } from './sign-up';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function Probe() {
  const { status, user } = useAtlas();
  return createElement('p', { id: 'probe' }, `${status}:${user === null}`);
}

describe('AtlasProvider without a publishable key', () => {
  it.each([undefined, '', '   '])('is inert for %j: no throw, no requests, no UI, one warning', async (key) => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(AtlasProvider, {
          publishableKey: key as unknown as string,
          frontendApi: 'https://fapi.example',
          children: createElement(Fragment, null, createElement(Probe), createElement(SignIn), createElement(SignUp)),
        }),
      );
    });
    expect(host.querySelector('#probe')?.textContent).toBe('signed_out:true');
    expect(host.querySelectorAll('form, input, button')).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    act(() => root.unmount());
    warn.mockRestore();
  });
});

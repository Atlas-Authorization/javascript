// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useDelegatedChallenge, useDelegatedFlow } from './delegated-ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

/** Render a hook and hand back its latest return value. */
async function hook<T>(use: () => T): Promise<{ current: () => T }> {
  let latest!: T;
  const el = document.createElement('div');
  const root = createRoot(el);
  const C = () => {
    latest = use();
    return null;
  };
  await act(async () => root.render(createElement(C)));
  unmount = () => act(() => root.unmount());
  return { current: () => latest };
}

describe('delegated login/consent hooks', () => {
  it('reads the challenge from a URL', async () => {
    const h = await hook(() => useDelegatedChallenge('https://a.test/signin?login_challenge=abc'));
    expect(h.current()).toEqual({ type: 'login', challenge: 'abc' });
  });

  it('decide() follows redirect_to; an error is surfaced without navigating', async () => {
    const nav: string[] = [];
    const ok = (async () => new Response(JSON.stringify({ redirect_to: 'https://op.test/x' }))) as unknown as typeof fetch;
    const h = await hook(() => useDelegatedFlow({ baseUrl: '/b', fetch: ok, navigate: (u) => nav.push(u) }));
    await act(async () => {
      await h.current().decide(() => h.current().client.acceptLogin('c', { subject: 'usr_1' }));
    });
    expect(nav).toEqual(['https://op.test/x']);
    unmount?.();

    const bad = (async () => new Response(JSON.stringify({ error: { message: 'Not signed in.' } }), { status: 401 })) as unknown as typeof fetch;
    const h2 = await hook(() => useDelegatedFlow({ baseUrl: '/b', fetch: bad, navigate: (u) => nav.push(u) }));
    await act(async () => {
      await h2.current().decide(() => h2.current().client.rejectLogin('c'));
    });
    expect(h2.current().error).toBe('Not signed in.');
    expect(nav).toHaveLength(1);
  });
});

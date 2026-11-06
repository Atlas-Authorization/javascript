// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FapiClient } from './fapi';
import { AtlasProvider } from './AtlasProvider';
import { AttemptFlow, SocialSignInButtons } from './flow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const popup = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));
vi.mock('@atlasauth/js', async (importActual) => ({
  ...(await importActual<typeof import('@atlasauth/js')>()),
  startOauthPopup: vi.fn(async () => popup.result),
}));

// Fake context for the button tests; the real provider for the AttemptFlow test.
const ctx = vi.hoisted(() => ({ real: false }));
vi.mock('./AtlasProvider', async (importActual) => {
  const actual = await importActual<typeof import('./AtlasProvider')>();
  return {
    ...actual,
    useAtlas: () =>
      ctx.real
        ? actual.useAtlas()
        : {
            oauthMode: 'popup',
            appearance: undefined,
            environment: { social_providers: [{ provider: 'restorehub', allow_sign_in: true }] },
            appearanceData: null,
            loadEnvironment: async () => null,
          },
  };
});

let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  ctx.real = false;
  document.body.innerHTML = '';
});

async function clickSocial(result: Record<string, unknown>) {
  popup.result = result;
  const onComplete = vi.fn();
  const client = { get: vi.fn(), post: vi.fn() } as unknown as FapiClient;
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(createElement(SocialSignInButtons, { client, onComplete }));
  });
  await act(async () => {
    (el.querySelector('[data-atlas-provider="restorehub"]') as HTMLElement).click();
  });
  return onComplete;
}

describe('popup-mode social completion hands finish a state with errors', () => {
  it('ticket result: errors is [] alongside the ticket and attempt id', async () => {
    const onComplete = await clickSocial({ ticket: 't', attemptId: 'sia_1' });
    expect(onComplete).toHaveBeenCalledTimes(1);
    const next = onComplete.mock.calls[0]![0] as { errors: unknown; ticket: string; attempt: { id: string } };
    expect(next.errors).toEqual([]);
    expect(next.ticket).toBe('t');
    expect(next.attempt.id).toBe('sia_1');
  });

  it('sessionDetected result: errors is []', async () => {
    const onComplete = await clickSocial({ sessionDetected: true });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect((onComplete.mock.calls[0]![0] as { errors: unknown }).errors).toEqual([]);
  });
});

describe('AttemptFlow without an errors prop', () => {
  it('renders a complete attempt without throwing', async () => {
    ctx.real = true;
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => {
      root!.render(
        createElement(AtlasProvider, {
          publishableKey: 'pk_test_x',
          frontendApi: 'https://fapi.example',
          fetchImpl,
          children: createElement(AttemptFlow, {
            attempt: { id: 'sia_1', object: 'sign_in_attempt', status: 'complete' } as never,
            onSubmit: () => {},
            busy: true,
            titleKey: 'signIn.title',
          }),
        }),
      );
    });
  });
});

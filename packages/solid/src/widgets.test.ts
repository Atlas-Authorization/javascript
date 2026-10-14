import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@solidjs/testing-library';
import { h } from './h';
import { AtlasContext } from './context';
import { AtlasProvider } from './provider';
import { SignIn, UserButton } from './widgets';
import type { AtlasClient } from './provider';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(cleanup);

describe('mountable widgets', () => {
  it('calls the client mount seam with an element and disposes it on cleanup', () => {
    const dispose = vi.fn();
    const mountSignIn = vi.fn((_el: HTMLElement) => dispose);
    // A stub client standing in for the real one — the widget only needs the
    // mount seam and never touches the network here.
    const client = {
      mountSignIn,
      mountSignUp: vi.fn(() => vi.fn()),
      mountUserButton: vi.fn(() => vi.fn()),
      state: { status: 'loading', user: null, session: null, claims: null, memberships: [] },
    } as unknown as AtlasClient;

    const { unmount } = render(() =>
      h(AtlasContext.Provider, { value: client }, h(SignIn, {})),
    );

    expect(mountSignIn).toHaveBeenCalledTimes(1);
    expect(mountSignIn.mock.calls[0]![0]).toBeInstanceOf(HTMLElement);
    expect(dispose).not.toHaveBeenCalled();

    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('mounts a real UserButton that appears once signed in', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json({
        session: { id: 'sess_1', status: 'active', last_active_organization_id: null },
        user: {
          id: 'user_1',
          first_name: 'Ada',
          last_name: null,
          username: null,
          image_url: null,
          public_metadata: {},
          unsafe_metadata: {},
          mfa_enabled: false,
          has_password: true,
        },
      }),
    );

    const { container } = render(() =>
      h(AtlasProvider, { publishableKey: 'pk_test', fetchImpl }, h(UserButton, {})),
    );

    // Signed out at first: the button renders nothing.
    expect(container.querySelector('.atlas-avatar')).toBeNull();

    await flush();

    const avatar = container.querySelector('.atlas-avatar');
    expect(avatar).not.toBeNull();
    // Ada → the avatar falls back to the name's initial when there is no image.
    expect(avatar?.textContent).toContain('A');
  });
});

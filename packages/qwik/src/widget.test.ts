import { describe, expect, it, vi } from 'vitest';
import { mountAtlasWidget } from './widget';

/**
 * The mountable `<SignIn>`/`<SignUp>` mount the `@atlasauth/embed` DOM widget
 * into a ref'd element from a `useVisibleTask$` and tear it down on cleanup.
 * The mount function is injected here, so the helper is exercised without the
 * real widget or a network — the spec's "unit-test the mount/cleanup helper
 * functions directly" path.
 */

describe('mountAtlasWidget', () => {
  it('mounts into the given host with the instance overrides', () => {
    const host = document.createElement('div');
    const mounter = vi.fn();

    mountAtlasWidget(host, 'sign-in', {
      publishableKey: 'pk_test',
      frontendApi: 'https://fapi.example',
      redirect: '/after',
      mounter,
    });

    expect(mounter).toHaveBeenCalledTimes(1);
    const [calledHost, overrides] = mounter.mock.calls[0]!;
    expect(calledHost).toBe(host);
    expect(overrides).toEqual({
      publishableKey: 'pk_test',
      frontendApi: 'https://fapi.example',
      redirect: '/after',
    });
  });

  it('omits an unset redirect', () => {
    const host = document.createElement('div');
    const mounter = vi.fn();

    mountAtlasWidget(host, 'sign-up', {
      publishableKey: 'pk_test',
      frontendApi: 'https://fapi.example',
      mounter,
    });

    const overrides = mounter.mock.calls[0]![1] as Record<string, unknown>;
    expect(overrides).not.toHaveProperty('redirect');
  });

  it('cleanup clears the host it rendered into', () => {
    const host = document.createElement('div');
    // Simulate the widget having rendered a panel into the host.
    const mounter = vi.fn((h: HTMLElement) => {
      h.appendChild(document.createElement('form'));
    });

    const teardown = mountAtlasWidget(host, 'sign-in', {
      publishableKey: 'pk_test',
      frontendApi: 'https://fapi.example',
      mounter,
    });

    expect(host.childElementCount).toBe(1);
    teardown();
    expect(host.childElementCount).toBe(0);
    // Idempotent: a second cleanup (e.g. after the host detached) is a no-op.
    expect(() => teardown()).not.toThrow();
  });
});

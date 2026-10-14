import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@solidjs/testing-library';
import { h } from './h';
import { AtlasProvider } from './provider';
import { useAtlas } from './context';
import { useAuth, useUser } from './accessors';

/**
 * Provider tests drive the REAL client through a mocked `fetch` (the `fetchImpl`
 * prop), so the boot path — read `/v1/client`, resolve `status` — runs exactly
 * as it does in a browser, with the network as the only seam. This mirrors how
 * `@atlasauth/vue`'s plugin tests work, rather than stubbing `@atlasauth/js`
 * (which has no single loadable instance to stub — the binding assembles the
 * reactive client from its primitives).
 */

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** Let queued microtasks AND the boot's chained awaits settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// A valid-enough JWT: the client decodes the payload for `exp` + claims, which
// is what populates `userId()` (it reads `claims.sub`, not the user object).
const makeJwt = (payload: Record<string, unknown>) => {
  const seg = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${seg({ alg: 'none' })}.${seg(payload)}.sig`;
};

const SIGNED_IN = {
  session: { id: 'sess_1', status: 'active', last_active_organization_id: null },
  jwt: makeJwt({ sub: 'user_1', sid: 'sess_1', exp: Math.floor(Date.now() / 1000) + 3600 }),
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
};

afterEach(cleanup);

describe('AtlasProvider', () => {
  it('provides the client through context', () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ session: null, user: null }));
    const Probe = () => {
      const client = useAtlas();
      return h('span', { 'data-testid': 'pk' }, client.publishableKey);
    };

    const { getByTestId } = render(() =>
      h(AtlasProvider, { publishableKey: 'pk_test', fetchImpl }, h(Probe, {})),
    );

    expect(getByTestId('pk').textContent).toBe('pk_test');
  });

  it('reflects a signed-in → signed-out transition reactively', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      // The sign-out revoke POST — answer OK so signOut completes.
      if (String(url).includes('/revoke')) return json({});
      return json(SIGNED_IN);
    });

    let auth!: ReturnType<typeof useAuth>;
    const Probe = () => {
      const user = useUser();
      auth = useAuth();
      return h('span', { 'data-testid': 'status' }, () =>
        user.isSignedIn()
          ? `in:${user.user()?.id}`
          : user.isLoaded()
            ? 'out'
            : 'loading',
      );
    };

    const { getByTestId } = render(() =>
      h(AtlasProvider, { publishableKey: 'pk_test', fetchImpl }, h(Probe, {})),
    );

    // Boot has not resolved yet: the accessor reports loading, not a false
    // signed-out (the flash this design exists to avoid).
    expect(getByTestId('status').textContent).toBe('loading');

    await flush();
    expect(getByTestId('status').textContent).toBe('in:user_1');
    expect(auth.isSignedIn()).toBe(true);
    expect(auth.status()).toBe('signed_in');
    expect(auth.session()).not.toBeNull();
    expect(auth.userId()).toBe('user_1');

    await auth.signOut();
    await flush();
    expect(getByTestId('status').textContent).toBe('out');
    expect(auth.isSignedIn()).toBe(false);
    expect(auth.status()).toBe('signed_out');
    expect(auth.session()).toBeNull();

    // The boot hit the client endpoint with the publishable key and cookies.
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).credentials).toBe('include');
    expect(((init as RequestInit).headers as Record<string, string>)['x-publishable-key']).toBe(
      'pk_test',
    );
  });
});

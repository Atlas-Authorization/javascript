import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './client';
import type { AtlasSnapshot } from './types';

/**
 * The client tests drive the real engine through a mocked `fetch`, so the boot
 * path — read the session, resolve `status`, cache the token — runs end to end
 * exactly as it does in a browser, with the network as the only seam. This is
 * the non-component logic the spec asks us to prioritise.
 */

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** A syntactically valid, UNSIGNED JWT with the given claims. */
function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.sig`;
}

const futureExp = () => Math.floor(Date.now() / 1000) + 3600;

const signedInBody = (jwt: string) => ({
  session: { id: 'sess_1', status: 'active', last_active_organization_id: null },
  user: {
    id: 'user_1',
    first_name: 'Ada',
    last_name: 'Lovelace',
    username: null,
    image_url: null,
    public_metadata: {},
    unsafe_metadata: {},
    mfa_enabled: false,
    has_password: true,
  },
  jwt,
  organization_memberships: [],
});

describe('createAtlasClient boots the session', () => {
  it('resolves to signed_out when /v1/client has no session', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ session: null, user: null }));
    const client = createAtlasClient({
      publishableKey: 'pk_test',
      frontendApi: 'https://fapi.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(client.snapshot().status).toBe('loading');
    await client.boot();

    expect(client.snapshot().status).toBe('signed_out');
    expect(client.snapshot().user).toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://fapi.example/v1/client',
      expect.objectContaining({ credentials: 'include' }),
    );
    client.destroy();
  });

  it('resolves to signed_in, exposes the user/claims and caches the token', async () => {
    const jwt = makeJwt({ sub: 'user_1', sid: 'sess_1', exp: futureExp() });
    const fetchImpl = vi.fn(async () => jsonResponse(signedInBody(jwt)));
    const client = createAtlasClient({
      publishableKey: 'pk_test',
      frontendApi: 'https://fapi.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.boot();

    const snap = client.snapshot();
    expect(snap.status).toBe('signed_in');
    expect(snap.user?.id).toBe('user_1');
    expect(snap.claims?.sub).toBe('user_1');
    // getToken serves the cached JWT without another round trip.
    await expect(client.getToken()).resolves.toBe(jwt);
    client.destroy();
  });
});

describe('createAtlasClient change listener', () => {
  it('notifies subscribers on each transition and stops after unsubscribe', async () => {
    const jwt = makeJwt({ sub: 'user_1', sid: 'sess_1', exp: futureExp() });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith('/v1/client')) return jsonResponse(signedInBody(jwt));
      // revoke on sign out
      return jsonResponse({});
    });
    const client = createAtlasClient({
      publishableKey: 'pk_test',
      frontendApi: 'https://fapi.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const seen: AtlasSnapshot[] = [];
    const unsubscribe = client.subscribe((snap) => seen.push(snap));

    await client.boot();
    expect(seen.at(-1)?.status).toBe('signed_in');

    await client.signOut();
    expect(seen.at(-1)?.status).toBe('signed_out');
    expect(client.snapshot().user).toBeNull();

    const countBefore = seen.length;
    unsubscribe();
    await client.reload();
    expect(seen.length).toBe(countBefore);

    client.destroy();
  });
});

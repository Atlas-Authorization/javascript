import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createAtlasClient, type AtlasClient } from '../lib/context';

/**
 * getAuth() needs a component context for useAtlas(); stub it to return a
 * client built directly so the derived store can be read with get().
 */
let current: AtlasClient;
vi.mock('../lib/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/context')>();
  return { ...actual, useAtlas: () => current };
});

const { getAuth } = await import('../lib/accessors');

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe('getAuth status/session', () => {
  // Field report: code read `status`/`session` off the auth accessor and got
  // undefined. Both are present now and agree with isLoaded/isSignedIn.
  it('carries status and session through loading → signed_in → signed_out', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> =>
      jsonResponse({
        user: { id: 'user_1' },
        session: { id: 'sess_1', status: 'active' },
        organization_memberships: [],
      }),
    );
    current = createAtlasClient({
      publishableKey: 'pk_test',
      manualBoot: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const auth = getAuth();

    expect(get(auth).status).toBe('loading');
    expect(get(auth).session).toBeNull();
    expect(get(auth).isLoaded).toBe(false);

    await current.reload();
    expect(get(auth).status).toBe('signed_in');
    expect(get(auth).session?.id).toBe('sess_1');
    expect(get(auth).isSignedIn).toBe(true);

    fetchImpl.mockImplementation(async () => jsonResponse({ user: null, session: null }));
    await current.reload();
    expect(get(auth).status).toBe('signed_out');
    expect(get(auth).session).toBeNull();
    expect(get(auth).isLoaded).toBe(true);
    expect(get(auth).isSignedIn).toBe(false);
  });
});

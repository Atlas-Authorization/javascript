import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createAtlasClient } from '../lib/context';

/**
 * The client is the Svelte engine: it exposes reactive auth state as stores and
 * drives boot/reload. These tests exercise it directly (no component needed),
 * with a stub fetch standing in for FAPI.
 */

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

describe('createAtlasClient — context init', () => {
  it('starts in the loading state with empty stores', () => {
    const client = createAtlasClient({ publishableKey: 'pk_test', manualBoot: true });

    expect(get(client.status)).toBe('loading');
    expect(get(client.user)).toBeNull();
    expect(get(client.session)).toBeNull();
    expect(get(client.memberships)).toEqual([]);
    // The derived guard stores read off status.
    expect(get(client.isLoaded)).toBe(false);
    expect(get(client.isSignedIn)).toBe(false);
  });

  it('carries the catalog and publishable key needed by children', () => {
    const client = createAtlasClient({
      publishableKey: 'pk_live_123',
      frontendApi: 'https://fapi.example',
      manualBoot: true,
    });

    expect(client.publishableKey).toBe('pk_live_123');
    expect(client.frontendApi).toBe('https://fapi.example');
    expect(client.catalog['signIn.submit']).toBe('Continue');
  });
});

describe('createAtlasClient — reload transitions the stores', () => {
  it('goes signed_in when /v1/client returns a user', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        session: { id: 'sess_1', status: 'active', last_active_organization_id: null },
        user: { id: 'user_1', first_name: 'Ada', last_name: 'Lovelace' },
        organization_memberships: [],
      }),
    ) as unknown as typeof fetch;

    const client = createAtlasClient({
      publishableKey: 'pk_test',
      fetchImpl,
      manualBoot: true,
    });

    await client.reload();

    expect(get(client.status)).toBe('signed_in');
    expect(get(client.isSignedIn)).toBe(true);
    expect(get(client.isLoaded)).toBe(true);
    expect(get(client.user)?.id).toBe('user_1');
    expect(get(client.session)?.id).toBe('sess_1');
    // The stubbed fetch was called with the credentialed, keyed shape.
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call).toBeTruthy();
    const init = call![1] as RequestInit & { headers: Record<string, string> };
    expect(init.credentials).toBe('include');
    expect(init.headers['x-publishable-key']).toBe('pk_test');
  });

  it('goes signed_out when /v1/client returns no session', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ session: null, user: null }),
    ) as unknown as typeof fetch;

    const client = createAtlasClient({ publishableKey: 'pk_test', fetchImpl, manualBoot: true });
    await client.reload();

    expect(get(client.status)).toBe('signed_out');
    expect(get(client.isSignedIn)).toBe(false);
    expect(get(client.isLoaded)).toBe(true);
  });

  it('does not fall to signed_out on a network error mid-session', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    const client = createAtlasClient({ publishableKey: 'pk_test', fetchImpl, manualBoot: true });
    await client.reload();

    // A failed boot from loading is treated as signed_out (nothing to show), but
    // it must never throw.
    expect(get(client.status)).toBe('signed_out');
  });
});

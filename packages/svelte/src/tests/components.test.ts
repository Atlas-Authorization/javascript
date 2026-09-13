import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { ATLAS_KEY, createAtlasClient } from '../lib/context';
import SignedInHarness from './harness/SignedInHarness.svelte';
import SignedOutHarness from './harness/SignedOutHarness.svelte';

/**
 * §10.2 the loading-gate components. `<SignedIn>`/`<SignedOut>` must render on
 * OPPOSITE sides of the auth state and BOTH render nothing while loading — the
 * guard against a flash of the wrong branch on every page load.
 *
 * `@atlasauth/js` is mocked so the client never reads `window.location` for a
 * redirect result; every other primitive is the real one.
 */
vi.mock('@atlasauth/js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@atlasauth/js')>();
  return { ...actual, readRedirectResult: () => null };
});

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

async function signedInClient() {
  const fetchImpl = vi.fn(async () =>
    jsonResponse({
      session: { id: 'sess_1', status: 'active', last_active_organization_id: null },
      user: { id: 'user_1', first_name: 'Ada', last_name: 'Lovelace' },
      organization_memberships: [],
    }),
  ) as unknown as typeof fetch;
  const client = createAtlasClient({ publishableKey: 'pk_test', fetchImpl, manualBoot: true });
  await client.reload();
  return client;
}

async function signedOutClient() {
  const fetchImpl = vi.fn(async () =>
    jsonResponse({ session: null, user: null }),
  ) as unknown as typeof fetch;
  const client = createAtlasClient({ publishableKey: 'pk_test', fetchImpl, manualBoot: true });
  await client.reload();
  return client;
}

function ctx(client: unknown) {
  return { context: new Map([[ATLAS_KEY, client]]) };
}

describe('<SignedIn> / <SignedOut>', () => {
  it('shows <SignedIn> children only when signed in', async () => {
    const { queryByTestId } = render(SignedInHarness, ctx(await signedInClient()));
    expect(queryByTestId('in')).toBeInTheDocument();
  });

  it('hides <SignedIn> children when signed out', async () => {
    const { queryByTestId } = render(SignedInHarness, ctx(await signedOutClient()));
    expect(queryByTestId('in')).toBeNull();
  });

  it('shows <SignedOut> children only when signed out', async () => {
    const { queryByTestId } = render(SignedOutHarness, ctx(await signedOutClient()));
    expect(queryByTestId('out')).toBeInTheDocument();
  });

  it('hides <SignedOut> children when signed in', async () => {
    const { queryByTestId } = render(SignedOutHarness, ctx(await signedInClient()));
    expect(queryByTestId('out')).toBeNull();
  });

  it('renders neither branch while the SDK is still loading', () => {
    // A fresh client with no reload is in `loading`; both gates must be empty.
    const loading = createAtlasClient({ publishableKey: 'pk_test', manualBoot: true });
    const inTree = render(SignedInHarness, ctx(loading));
    expect(inTree.queryByTestId('in')).toBeNull();
    const outTree = render(SignedOutHarness, ctx(loading));
    expect(outTree.queryByTestId('out')).toBeNull();
  });
});

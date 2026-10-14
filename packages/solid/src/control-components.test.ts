import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@solidjs/testing-library';
import { h } from './h';
import { AtlasProvider } from './provider';
import { Protect, SignedIn, SignedOut } from './control-components';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A valid-enough JWT: the client decodes the payload for `exp` + claims. */
const makeJwt = (payload: Record<string, unknown>) => {
  const seg = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${seg({ alg: 'none' })}.${seg(payload)}.sig`;
};

const signedIn = (claims?: Record<string, unknown>) => ({
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
  ...(claims
    ? { jwt: makeJwt({ sub: 'user_1', sid: 'sess_1', exp: Math.floor(Date.now() / 1000) + 3600, ...claims }) }
    : {}),
});

afterEach(cleanup);

describe('control components', () => {
  it('renders SignedIn / SignedOut conditionally, and neither while loading', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ session: null, user: null }));

    const { container } = render(() =>
      h(AtlasProvider, { publishableKey: 'pk_test', frontendApi: 'https://fapi.example', fetchImpl }, [
        h(SignedIn, {}, h('span', { class: 'in' }, 'in')),
        h(SignedOut, {}, h('span', { class: 'out' }, 'out')),
      ]),
    );

    // Still booting: neither branch — no flash of the signed-out form.
    expect(container.querySelector('.in')).toBeNull();
    expect(container.querySelector('.out')).toBeNull();

    await flush();
    expect(container.querySelector('.out')).not.toBeNull();
    expect(container.querySelector('.in')).toBeNull();
  });

  it('shows SignedIn children once signed in', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json(signedIn()));

    const { container } = render(() =>
      h(AtlasProvider, { publishableKey: 'pk_test', frontendApi: 'https://fapi.example', fetchImpl }, [
        h(SignedIn, {}, h('span', { class: 'in' }, 'in')),
        h(SignedOut, {}, h('span', { class: 'out' }, 'out')),
      ]),
    );

    await flush();
    expect(container.querySelector('.in')).not.toBeNull();
    expect(container.querySelector('.out')).toBeNull();
  });

  // Each Protect is rendered in its OWN provider tree. Authoring with
  // `solid-js/h`, a bare ARRAY of component children is flattened eagerly and
  // only the last survives — purely a test-authoring artifact of `h` (real
  // consumers use the Solid JSX compiler, which does not), so sibling Protects
  // are split across two renders rather than listed in one array.
  it('Protect renders children when the permission is held', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json(signedIn({ org_id: 'org_1', org_role: 'admin', org_permissions: ['org:x:manage'] })),
    );

    const { container } = render(() =>
      h(
        AtlasProvider,
        { publishableKey: 'pk_test', frontendApi: 'https://fapi.example', fetchImpl },
        h(Protect, { permission: 'org:x:manage' }, h('span', { class: 'allowed' }, 'ok')),
      ),
    );

    await flush();
    expect(container.querySelector('.allowed')).not.toBeNull();
  });

  it('Protect shows the fallback and hides children when the permission is missing', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json(signedIn({ org_id: 'org_1', org_role: 'admin', org_permissions: ['org:x:manage'] })),
    );

    const { container } = render(() =>
      h(
        AtlasProvider,
        { publishableKey: 'pk_test', frontendApi: 'https://fapi.example', fetchImpl },
        h(
          Protect,
          { permission: 'org:x:delete', fallback: h('span', { class: 'denied' }, 'no') },
          h('span', { class: 'secret' }, 'secret'),
        ),
      ),
    );

    await flush();
    // Missing permission → fallback shown, guarded content never rendered.
    expect(container.querySelector('.secret')).toBeNull();
    expect(container.querySelector('.denied')).not.toBeNull();
  });
});

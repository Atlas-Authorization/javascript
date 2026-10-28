import { afterEach, describe, expect, it, vi } from 'vitest';
import './index';
import type { AtlasProvider, AtlasProtect, AtlasSignIn } from './elements';

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims: Record<string, unknown>) =>
  `${b64({ alg: 'RS256' })}.${b64({ sub: 'user_1', sid: 'sess_1', exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;

function fakeFetch(signedIn: boolean, claims: Record<string, unknown> = {}) {
  return vi.fn(async (url: string) => {
    if (String(url).endsWith('/v1/client')) {
      const body = signedIn
        ? {
            session: { id: 'sess_1', status: 'active', last_active_organization_id: null },
            user: { id: 'user_1', first_name: 'Ada', last_name: null, username: null, image_url: null, public_metadata: {}, unsafe_metadata: {}, mfa_enabled: false, has_password: true },
            jwt: jwt(claims),
          }
        : { session: null, user: null };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
}

async function mount(fetchImpl: typeof fetch, inner: string) {
  const provider = document.createElement('atlas-provider') as AtlasProvider;
  provider.publishableKey = 'pk_test_1';
  provider.frontendApi = 'https://auth.example.com';
  provider.fetchImpl = fetchImpl;
  provider.innerHTML = inner;
  document.body.append(provider);
  // Let the boot request settle and the consumers re-render.
  await new Promise((r) => setTimeout(r, 20));
  await Promise.all([...provider.querySelectorAll('*')].map((el) => (el as { updateComplete?: Promise<unknown> }).updateComplete));
  return provider;
}

const shows = (el: Element) => !!el.shadowRoot?.querySelector('slot:not([name])');

afterEach(() => {
  document.body.replaceChildren();
});

describe('atlas elements', () => {
  it('shows the signed-in content and hides the signed-out content for a signed-in user', async () => {
    const p = await mount(fakeFetch(true), '<atlas-signed-in>in</atlas-signed-in><atlas-signed-out>out</atlas-signed-out><atlas-loading>wait</atlas-loading>');
    expect(shows(p.querySelector('atlas-signed-in')!)).toBe(true);
    expect(shows(p.querySelector('atlas-signed-out')!)).toBe(false);
    expect(shows(p.querySelector('atlas-loading')!)).toBe(false);
  });

  it('shows the signed-out content once a booted visitor has no session', async () => {
    const p = await mount(fakeFetch(false), '<atlas-signed-in>in</atlas-signed-in><atlas-signed-out>out</atlas-signed-out>');
    expect(shows(p.querySelector('atlas-signed-in')!)).toBe(false);
    expect(shows(p.querySelector('atlas-signed-out')!)).toBe(true);
  });

  it('atlas-protect passes only when the session has the permission', async () => {
    const allowed = await mount(fakeFetch(true, { org_id: 'o1', org_role: 'admin', org_permissions: ['billing:read'] }), '<atlas-protect permission="billing:read">x</atlas-protect>');
    expect(shows(allowed.querySelector('atlas-protect')!)).toBe(true);
    document.body.replaceChildren();
    const denied = await mount(fakeFetch(true, { org_id: 'o1', org_role: 'member', org_permissions: [] }), '<atlas-protect permission="billing:read">x</atlas-protect>');
    const el = denied.querySelector('atlas-protect') as AtlasProtect;
    expect(shows(el)).toBe(false);
    expect(el.shadowRoot?.querySelector('slot[name="fallback"]')).not.toBeNull();
  });

  it('atlas-protect never passes a signed-out visitor', async () => {
    const p = await mount(fakeFetch(false), '<atlas-protect require-role="admin">x</atlas-protect>');
    expect(shows(p.querySelector('atlas-protect')!)).toBe(false);
  });

  it('the sign-in element mounts the widget with the provider keys and cleans up on removal', async () => {
    const mounter = vi.fn((host: HTMLElement, _options?: unknown) => {
      host.innerHTML = '<form></form>';
    });
    const provider = document.createElement('atlas-provider') as AtlasProvider;
    provider.publishableKey = 'pk_test_1';
    provider.frontendApi = 'https://auth.example.com';
    provider.fetchImpl = fakeFetch(false);
    const signIn = document.createElement('atlas-sign-in') as AtlasSignIn;
    signIn.mounter = mounter;
    signIn.redirect = '/app';
    provider.append(signIn);
    document.body.append(provider);
    await new Promise((r) => setTimeout(r, 20));
    await signIn.updateComplete;
    expect(mounter).toHaveBeenCalledTimes(1);
    expect(mounter.mock.calls[0]![1]).toMatchObject({ publishableKey: 'pk_test_1', frontendApi: 'https://auth.example.com', redirect: '/app' });
    expect(signIn.querySelector('form')).not.toBeNull();
    signIn.remove();
    expect(signIn.querySelector('form')).toBeNull();
  });
});

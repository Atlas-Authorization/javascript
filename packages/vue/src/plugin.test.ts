import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createAtlas } from './plugin';
import { SignedIn, SignedOut } from './components';
import { useAuth } from './composables';

/**
 * §10.1 provider tests. These drive the real client through a mocked `fetch`, so
 * the boot path — read the session, resolve `status` — is exercised end to end
 * exactly as it runs in a browser, with the network as the only seam.
 */

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const Harness = defineComponent({
  setup() {
    return () =>
      h('div', [
        h(SignedIn, () => h('span', { class: 'in' }, 'in')),
        h(SignedOut, () => h('span', { class: 'out' }, 'out')),
      ]);
  },
});

describe('createAtlas boots the session', () => {
  it('resolves to signed-out when /v1/client has no session', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ session: null, user: null }),
    );

    const wrapper = mount(Harness, {
      global: {
        plugins: [createAtlas({ publishableKey: 'pk_test', fetchImpl: fetchImpl as unknown as typeof fetch })],
      },
    });

    // While booting, NEITHER branch renders — no flash of the signed-out form.
    expect(wrapper.find('.in').exists()).toBe(false);
    expect(wrapper.find('.out').exists()).toBe(false);

    await flushPromises();

    expect(wrapper.find('.out').exists()).toBe(true);
    expect(wrapper.find('.in').exists()).toBe(false);
    // The boot hit the client endpoint with the publishable key attached.
    expect(fetchImpl).toHaveBeenCalled();
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).credentials).toBe('include');
    expect(((init as RequestInit).headers as Record<string, string>)['x-publishable-key']).toBe('pk_test');
  });

  it('resolves to signed-in when /v1/client returns a session and user', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        session: { id: 'sess_1', status: 'active', last_active_organization_id: null },
        user: { id: 'user_1', first_name: 'Ada', last_name: null, username: null, image_url: null },
      }),
    );

    const wrapper = mount(Harness, {
      global: {
        plugins: [createAtlas({ publishableKey: 'pk_test', fetchImpl: fetchImpl as unknown as typeof fetch })],
      },
    });

    await flushPromises();

    expect(wrapper.find('.in').exists()).toBe(true);
    expect(wrapper.find('.out').exists()).toBe(false);
  });

  it('exposes a working useAuth().has() gate off the session claims', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ session: null, user: null }),
    );
    let auth: ReturnType<typeof useAuth> | null = null;

    const Probe = defineComponent({
      setup() {
        auth = useAuth();
        return () => h('div');
      },
    });

    mount(Probe, {
      global: {
        plugins: [createAtlas({ publishableKey: 'pk_test', fetchImpl: fetchImpl as unknown as typeof fetch })],
      },
    });
    await flushPromises();

    // Signed out: every permission gate is denied, and isSignedIn is false.
    expect(auth!.isSignedIn.value).toBe(false);
    expect(auth!.has({ permission: 'org:billing:manage' })).toBe(false);
  });

  it('throws when a composable is used without the plugin', () => {
    const Orphan = defineComponent({
      setup() {
        useAuth();
        return () => h('div');
      },
    });
    expect(() => mount(Orphan)).toThrow(/Atlas composables must be used after/);
  });
});

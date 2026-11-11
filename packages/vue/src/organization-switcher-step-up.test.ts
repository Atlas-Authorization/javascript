import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, shallowRef, type App } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { ATLAS_INJECTION_KEY } from './context';
import type { AtlasClient, AuthStatus } from './plugin';
import { OrganizationSwitcher } from './components';
import { EN_US } from './i18n';
import type { AtlasOrganizationMembership, AtlasSession, AtlasUser, SessionClaims } from './types';

const ORG: AtlasOrganizationMembership = {
  role: 'org:admin',
  organization: { id: 'org_1', name: 'Acme', slug: 'acme', image_url: null },
};

const stepUpError = Object.assign(new Error('step up'), { code: 'STEP_UP_REQUIRED', reason: 'org_mfa_step_up_required', allowedFactors: ['totp'] });

function signedInClient(): AtlasClient {
  return {
    publishableKey: 'pk_test',
    frontendApi: 'https://fapi.example',
    appearance: undefined,
    catalog: EN_US,
    status: shallowRef<AuthStatus>('signed_in'),
    user: shallowRef<AtlasUser | null>(null),
    session: shallowRef<AtlasSession | null>(null),
    claims: shallowRef<SessionClaims | null>({ sub: 'user_1', sid: 'sess_1', exp: 0, org_id: 'org_1' }),
    memberships: shallowRef<AtlasOrganizationMembership[]>([ORG]),
    pendingAttempt: null,
    getToken: async () => null,
    getProviderToken: async () => null,
    signOut: async () => ({ revoked: true }),
    setActiveOrganization: async () => undefined,
    reload: async () => true,
    endImpersonation: async () => ({ ended: false, resumed: false, status: 0 }),
    onSignOut: () => () => undefined,
  };
}


afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<OrganizationSwitcher/> step-up (Vue)', () => {
  it('prompts for a code when setActive needs a step-up, then retries', async () => {
    const client = signedInClient();
    client.claims.value = { sub: 'user_1', sid: 'sess_1', exp: 0 };
    const setActive = vi.fn().mockRejectedValueOnce(stepUpError).mockResolvedValue(undefined);
    client.setActiveOrganization = setActive;
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ object: 'client', stepped_up: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    const wrapper = mount(defineComponent({ setup: () => () => h(OrganizationSwitcher) }), {
      global: { plugins: [{ install: (app: App) => app.provide(ATLAS_INJECTION_KEY, client) }] },
    });
    await wrapper.findAll('button')[1]!.trigger('click');
    await flushPromises();
    const dialog = wrapper.find('[data-atlas="organization-step-up"]');
    expect(dialog.exists()).toBe(true);
    await dialog.find('input').setValue('123456');
    await dialog.findAll('button')[0]!.trigger('click');
    await flushPromises();
    expect(urls[0]).toBe('https://fapi.example/v1/client/me/step_up');
    expect(setActive).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-atlas="organization-step-up"]').exists()).toBe(false);
  });
});

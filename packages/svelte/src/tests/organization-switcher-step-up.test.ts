import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { ATLAS_KEY, createAtlasClient } from '../lib/context';
import OrganizationSwitcher from '../lib/components/OrganizationSwitcher.svelte';

vi.mock('@atlasauth/js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@atlasauth/js')>();
  return { ...actual, readRedirectResult: () => null };
});

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const JWT = `${b64({ alg: 'none' })}.${b64({ sid: 'sess_1', sub: 'user_1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function setup(allowedFactors: string[]) {
  const calls: { url: string; body: unknown }[] = [];
  let touches = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/v1/client')) {
      return json({
        session: { id: 'sess_1', status: 'active', last_active_organization_id: null },
        user: { id: 'user_1', first_name: 'Me' },
        jwt: JWT,
        organization_memberships: [{ role: 'org:admin', organization: { id: 'org_1', name: 'Acme', slug: 'acme', image_url: null } }],
      });
    }
    if (url.endsWith('/touch')) {
      // The first activation is refused until the step-up has happened.
      if (touches++ === 0) {
        return json({ errors: [{ code: 'STEP_UP_REQUIRED', reason: 'org_mfa_step_up_required', message: 'Step up', meta: { allowed_factors: allowedFactors } }] }, 403);
      }
      return json({ jwt: JWT });
    }
    return json({ object: 'client', stepped_up: true });
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  vi.stubGlobal('PublicKeyCredential', class {});
  const client = createAtlasClient({ publishableKey: 'pk_test', frontendApi: 'https://fapi.example', fetchImpl, manualBoot: true });
  await client.reload();
  const view = render(OrganizationSwitcher, { context: new Map([[ATLAS_KEY, client]]) });
  const acme = [...view.container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Acme')!;
  await fireEvent.click(acme);
  await waitFor(() => expect(view.container.querySelector('[data-atlas="organization-step-up"]')).not.toBeNull());
  return { ...view, calls };
}

describe('<OrganizationSwitcher> step-up (Svelte)', () => {
  it('prompts for a code, steps up, then retries the activation; the passkey button shows only when allowed', async () => {
    const { container, calls } = await setup(['totp', 'passkey']);
    const dialog = container.querySelector('[data-atlas="organization-step-up"]')!;
    // code submit + passkey + cancel
    expect(dialog.querySelectorAll('button')).toHaveLength(3);

    await fireEvent.input(dialog.querySelector('input')!, { target: { value: '123456' } });
    await fireEvent.click(dialog.querySelector('button')!);
    await waitFor(() => expect(container.querySelector('[data-atlas="organization-step-up"]')).toBeNull());
    expect(calls.find((c) => c.url === 'https://fapi.example/v1/client/me/step_up')?.body).toEqual({ strategy: 'totp', code: '123456' });
    expect(calls.filter((c) => c.url.endsWith('/touch'))).toHaveLength(2);
  });

  it('hides the passkey button when only totp is allowed', async () => {
    const { container } = await setup(['totp']);
    expect(container.querySelector('[data-atlas="organization-step-up"]')!.querySelectorAll('button')).toHaveLength(2);
  });
});

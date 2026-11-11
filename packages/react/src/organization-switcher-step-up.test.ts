// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider } from './AtlasProvider';
import { OrganizationSwitcher } from './organization';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const JWT = `${b64({ alg: 'none' })}.${b64({ sid: 'sess_1', sub: 'user_1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mount(allowedFactors: string[]) {
  const calls: { url: string; body: unknown }[] = [];
  let touches = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/v1/client')) {
      return json({
        session: { id: 'sess_1', status: 'active' },
        user: { id: 'user_1' },
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

  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      createElement(AtlasProvider, {
        publishableKey: 'pk_test_x',
        frontendApi: 'https://fapi.example',
        fetchImpl,
        appearance: { instanceDesign: false },
        children: createElement(OrganizationSwitcher),
      }),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  unmount = () => act(() => root.unmount());
  const acme = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Acme')!;
  await act(async () => {
    acme.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return { el, calls };
}

describe('<OrganizationSwitcher/> step-up (React)', () => {
  it('prompts for a code, steps up, then retries the activation; the passkey button shows only when allowed', async () => {
    const { el, calls } = await mount(['totp', 'passkey']);
    const dialog = el.querySelector('[data-atlas="organization-step-up"]')!;
    expect(dialog).not.toBeNull();
    // code submit + passkey + cancel
    expect(dialog.querySelectorAll('button')).toHaveLength(3);

    const input = dialog.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '123456');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      el.querySelector('[data-atlas="organization-step-up"] button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const stepUp = calls.find((c) => c.url === 'https://fapi.example/v1/client/me/step_up');
    expect(stepUp?.body).toEqual({ strategy: 'totp', code: '123456' });
    expect(calls.filter((c) => c.url.endsWith('/touch'))).toHaveLength(2);
    expect(el.querySelector('[data-atlas="organization-step-up"]')).toBeNull();
  });

  it('hides the passkey button when only totp is allowed', async () => {
    const { el } = await mount(['totp']);
    expect(el.querySelector('[data-atlas="organization-step-up"]')!.querySelectorAll('button')).toHaveLength(2);
  });
});

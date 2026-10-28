// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider } from './AtlasProvider';
import { OrganizationDomains, OrganizationIpAllowlist, OrganizationLogStreams, OrganizationApiKeys } from './organization-admin';
import { OrganizationProfile } from './organization';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The tenant-admin widgets follow the server's gate and show one-time secrets once. */

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims: Record<string, unknown>) =>
  `${b64({ alg: 'none' })}.${b64({ sid: 'sess_1', sub: 'user_1', exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ADMIN = { org_id: 'org_1', org_role: 'org:admin', org_permissions: ['org:sys_memberships:manage'] };

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mount(child: unknown, routes: (url: string, method: string) => Response | null) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/v1/client')) {
      return json({
        session: { id: 'sess_1', status: 'active' },
        user: { id: 'user_1' },
        jwt: jwt(ADMIN),
        organization_memberships: [{ role: 'org:admin', organization: { id: 'org_1', name: 'Acme', slug: 'acme', image_url: null } }],
      });
    }
    return routes(url, method) ?? json({ object: 'list', data: [], has_more: false });
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
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
        children: child as never,
      }),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  unmount = () => act(() => root.unmount());
  return { el, calls };
}

const button = (el: HTMLElement, label: string) => {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}" in: ${el.innerHTML}`);
  return found;
};
const click = (t: HTMLElement) => act(async () => { t.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

describe('tenant-admin widgets', () => {
  it('<OrganizationDomains/> lists claimed domains with their TXT record and adds one', async () => {
    const domain = { object: 'org_domain', id: 'dom_1', domain: 'acme.com', status: 'pending', verification: { record_type: 'TXT', record_name: '_atlas.acme.com', record_value: 'tok123' } };
    const { el, calls } = await mount(createElement(OrganizationDomains), (url, method) =>
      url.endsWith('/organizations/org_1/domains') && method === 'GET' ? json({ object: 'list', data: [domain], has_more: false }) : null,
    );
    expect(el.textContent).toContain('acme.com');
    expect(el.textContent).toContain('tok123');
    const input = el.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'new.example.com');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button(el, 'Add domain'));
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/organizations/org_1/domains') && (c.body as { domain: string }).domain === 'new.example.com')).toBe(true);
  });

  it('<OrganizationApiKeys/> shows the new secret once, not in the list', async () => {
    const { el } = await mount(createElement(OrganizationApiKeys), (url, method) =>
      url.endsWith('/organizations/org_1/api_keys') && method === 'POST'
        ? json({ object: 'api_key', id: 'k1', name: null, prefix: 'ak_abc', secret: 'ak_abc_SECRET', created_at: 1 }, 201)
        : null,
    );
    await click(button(el, 'Create key'));
    const shown = el.querySelector('[data-atlas="one-time-secret"] input') as HTMLInputElement;
    expect(shown.value).toBe('ak_abc_SECRET');
  });

  it('<OrganizationLogStreams/> and <OrganizationIpAllowlist/> render for an admin; a 404 hides them', async () => {
    const ok = await mount(createElement(OrganizationLogStreams), () => null);
    expect(ok.el.querySelector('[data-atlas="organization-log-streams"]')).not.toBeNull();
    unmount?.();
    document.body.innerHTML = '';
    const hidden = await mount(createElement(OrganizationIpAllowlist), (url) =>
      url.endsWith('/ip_allowlist') ? json({ errors: [{ code: 'NOT_FOUND', message: 'Unknown organization.' }] }, 404) : null,
    );
    expect(hidden.el.querySelector('[data-atlas="organization-ip-allowlist"]')).toBeNull();
  });

  it('<OrganizationProfile adminSections/> renders the requested sections for an admin only', async () => {
    const { el } = await mount(createElement(function Profile() { return OrganizationProfile({ adminSections: ['domains', 'apiKeys'] }); }), () => null);
    expect(el.querySelector('[data-atlas="organization-admin-domains"]')).not.toBeNull();
    expect(el.querySelector('[data-atlas="organization-admin-apiKeys"]')).not.toBeNull();
    expect(el.querySelector('[data-atlas="organization-admin-sso"]')).toBeNull();
  });
});

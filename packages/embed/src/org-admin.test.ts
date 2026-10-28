// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mountOrganizationAdmin } from './org-admin';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tick = () => new Promise((r) => setTimeout(r, 10));

function setup(routes: (url: string, method: string) => Response) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: init.method ?? 'GET' });
    return routes(String(input), init.method ?? 'GET');
  }) as unknown as typeof fetch;
  const host = document.createElement('div');
  document.body.append(host);
  return { host, fetchImpl, calls };
}

describe('mountOrganizationAdmin', () => {
  it('renders domains and adds one through the org-admin API', async () => {
    const { host, fetchImpl, calls } = setup((url, method) =>
      method === 'GET'
        ? json({ object: 'list', data: [{ id: 'dom_1', domain: 'acme.com', status: 'verified', verification: { record_name: 'n', record_value: 'v' } }] })
        : json({ id: 'dom_2' }, 201),
    );
    mountOrganizationAdmin(host, { section: 'domains', organizationId: 'org_1', publishableKey: 'pk_test_x', frontendApi: 'https://fapi.example', fetchImpl });
    await tick();
    expect(host.textContent).toContain('acme.com');
    (host.querySelector('input') as HTMLInputElement).value = 'new.example.com';
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add domain')!.click();
    await tick();
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/v1/client/organizations/org_1/domains'))).toBe(true);
  });

  it('shows a new API key once and renders nothing for a refused caller', async () => {
    const keys = setup((url, method) =>
      method === 'POST' ? json({ object: 'api_key', id: 'k1', prefix: 'ak_x', secret: 'ak_x_SECRET' }, 201) : json({ object: 'list', data: [] }),
    );
    mountOrganizationAdmin(keys.host, { section: 'apiKeys', organizationId: 'org_1', publishableKey: 'pk_test_x', frontendApi: 'https://fapi.example', fetchImpl: keys.fetchImpl });
    await tick();
    [...keys.host.querySelectorAll('button')].find((b) => b.textContent === 'Create key')!.click();
    await tick();
    expect(keys.host.querySelector('[data-atlas="one-time-secret"]')?.textContent).toContain('ak_x_SECRET');

    const denied = setup(() => json({ errors: [{ code: 'NOT_FOUND', message: 'Unknown organization.' }] }, 404));
    mountOrganizationAdmin(denied.host, { section: 'ipAllowlist', organizationId: 'org_2', publishableKey: 'pk_test_x', frontendApi: 'https://fapi.example', fetchImpl: denied.fetchImpl });
    await tick();
    expect(denied.host.textContent).toBe('');
  });
});

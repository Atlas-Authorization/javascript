import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { createStore } from 'solid-js/store';
import { h } from './h';
import { AtlasContext } from './context';
import * as sdk from './index';
import { OrganizationAuditLog } from './organization';
import type { AtlasClient, AtlasState } from './provider';

const ORG = { role: 'org:admin', organization: { id: 'org_1', name: 'Acme', slug: 'acme', image_url: null } };

function fakeClient() {
  const [state, setState] = createStore<AtlasState>({
    status: 'signed_in',
    user: null,
    session: null,
    claims: { sub: 'user_1', sid: 'sess_1', exp: 0, org_id: 'org_1' },
    memberships: [ORG],
  });
  const client = { publishableKey: 'pk_test', frontendApi: 'https://fapi.example', state } as unknown as AtlasClient;
  return { client, setState };
}

const entry = (id: string, action: string) => ({
  object: 'audit_log',
  id,
  action,
  actor: { type: 'user', id: 'user_1' },
  target: { type: null, id: null },
  organization_id: 'org_1',
  ip: null,
  user_agent: null,
  metadata: {},
  created_at: 1_700_000_000_000,
});

function stubFetch(handler: (url: string) => { status: number; body: unknown }) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const { status, body } = handler(url);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return urls;
}

const mountLog = (client: AtlasClient, props: Record<string, unknown> = {}) =>
  render(() => h(AtlasContext.Provider, { value: client }, h(OrganizationAuditLog, props)));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<OrganizationAuditLog/> (Solid)', () => {
  it('is exported with its accessor', () => {
    expect(sdk.OrganizationAuditLog).toBeTypeOf('function');
    expect(sdk.useOrganizationAuditLog).toBeTypeOf('function');
  });

  it("lists the active organization's entries and pages with Load more", async () => {
    const urls = stubFetch((url) =>
      url.includes('starting_after')
        ? { status: 200, body: { data: [entry('aud_3', 'organization.updated')], has_more: false, next_cursor: null } }
        : {
            status: 200,
            body: {
              data: [entry('aud_1', 'organization_invitation.created'), entry('aud_2', 'organization_membership.created')],
              has_more: true,
              next_cursor: 'aud_2',
            },
          },
    );
    const view = mountLog(fakeClient().client, { pageSize: 2 });
    await waitFor(() => expect(view.container.querySelectorAll('li')).toHaveLength(2));
    expect(urls[0]).toBe('https://fapi.example/v1/client/organizations/org_1/audit_logs?limit=2');
    expect(view.getByText('Organization invitation created')).toBeTruthy();
    fireEvent.click(view.getByText('Load more'));
    await waitFor(() => expect(view.container.querySelectorAll('li')).toHaveLength(3));
    expect(urls[1]).toContain('starting_after=aud_2');
    expect(view.queryByText('Load more')).toBeNull();
  });

  it('renders nothing for a member who may not read the log', async () => {
    const urls = stubFetch(() => ({ status: 403, body: { errors: [{ code: 'FORBIDDEN', message: 'no' }] } }));
    const view = mountLog(fakeClient().client);
    await waitFor(() => expect(urls).toHaveLength(1));
    await waitFor(() => expect(view.container.querySelector('[data-atlas="organization-audit-log"]')).toBeNull());
  });

  it('follows the active organization', async () => {
    const urls = stubFetch(() => ({ status: 200, body: { data: [], has_more: false, next_cursor: null } }));
    const { client, setState } = fakeClient();
    const view = mountLog(client);
    await waitFor(() => expect(view.getByText('No activity recorded yet.')).toBeTruthy());
    setState('memberships', [ORG, { role: 'org:admin', organization: { id: 'org_2', name: 'Beta', slug: 'beta', image_url: null } }]);
    setState('claims', { sub: 'user_1', sid: 'sess_1', exp: 0, org_id: 'org_2' });
    await waitFor(() => expect(urls.at(-1)).toContain('/organizations/org_2/audit_logs'));
  });
});

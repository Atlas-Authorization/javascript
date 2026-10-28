import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FapiClient, nextStep } from '@atlasauth/js';
import { AtlasFlowController } from './flow-controller';
import { EN_US, translate } from '../i18n';

/**
 * Policy acceptance in the Angular flow engine: the sign-up sends the accepted
 * policies and reloads them after a 422, a sign-in in `needs_policy_acceptance`
 * maps to the policies step and posts `accept_policies`, and declining cancels
 * the attempt. Runs under vitest (node) against the plain controller class.
 */

const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}
type Route = (call: Call) => Response | undefined;

const wire = (over: Record<string, unknown> = {}) => ({
  key: 'tos',
  title: 'Terms of Service',
  display: 'checkbox',
  required: true,
  applies_to: 'sign_in_and_sign_up',
  version_id: 'polv_1',
  version: '1',
  content_html: '<p>Terms body</p>',
  content_sha256: 'sha_tos',
  effective_at: null,
  summary_of_changes: null,
  ...over,
});

let calls: Call[] = [];
beforeEach(() => {
  calls = [];
});
afterEach(() => vi.unstubAllGlobals());

async function controller(routes: Route[], pending: { id: string; status: string } | null = null) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    if (call.path === '/v1/appearance') {
      return json({ object: 'appearance', appearance: { legal: { termsUrl: null, privacyUrl: null, required: false }, signUpFields: [] }, captchaFlows: {} });
    }
    for (const route of routes) {
      const res = route(call);
      if (res) return res;
    }
    return json({});
  }) as unknown as typeof fetch;
  const flow = new AtlasFlowController(
    new FapiClient({ publishableKey: 'pk_test_x', baseUrl: FAPI, fetchImpl }),
    async () => true,
    pending,
    (key) => translate(EN_US, key),
  );
  await flow.loadSettings();
  return flow;
}

const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

describe('AtlasFlowController policies', () => {
  it('loads the sign-up policies and create() sends the acceptances', async () => {
    const flow = await controller([
      (c) => (c.method === 'GET' && c.path === '/v1/client/policies' ? json({ policies: [wire()] }) : undefined),
      (c) => (c.path === '/v1/client/sign_ups' ? json({ id: 'sua_1', status: 'needs_email_verification' }, 201) : undefined),
    ]);
    await flow.loadPolicies();
    expect(flow.policies.policies).toHaveLength(1);
    expect(flow.policies.canSubmit()).toBe(false);
    flow.policies.setAllChecked(true);
    await flow.create({ email: 'a@b.co', password: 'blue tangerine anvil 71!' });
    expect(posts('/v1/client/sign_ups')[0]!.body!.policy_acceptances).toEqual([
      { policy: 'tos', version_id: 'polv_1', content_sha256: 'sha_tos', display: 'checkbox' },
    ]);
  });

  it('reloads the policies when the server answers POLICY_ACCEPTANCE_REQUIRED', async () => {
    let version = 'polv_1';
    const flow = await controller([
      (c) => (c.method === 'GET' && c.path === '/v1/client/policies' ? json({ policies: [wire({ version_id: version })] }) : undefined),
      (c) => {
        if (c.path !== '/v1/client/sign_ups') return undefined;
        version = 'polv_2';
        return json({ errors: [{ code: 'POLICY_ACCEPTANCE_REQUIRED', message: 'Accept the updated terms.' }] }, 422);
      },
    ]);
    await flow.loadPolicies();
    flow.policies.setAllChecked(true);
    await flow.create({ email: 'a@b.co', password: 'blue tangerine anvil 71!' });
    expect(flow.policies.policies[0]!.versionId).toBe('polv_2');
    expect(flow.policies.isChecked('tos')).toBe(false);
    expect(flow.state().errors[0]!.code).toBe('POLICY_ACCEPTANCE_REQUIRED');
  });

  it('a needs_policy_acceptance attempt maps to the policies step and posts accept_policies', async () => {
    const flow = await controller(
      [(c) => (c.path === '/v1/client/sign_ins/sia_1/accept_policies' ? json({ id: 'sia_1', status: 'needs_second_factor' }) : undefined)],
      { id: 'sia_1', status: 'needs_policy_acceptance' },
    );
    expect(nextStep(flow.state().attempt!).kind).toBe('accept_policies');
    flow.submit({ policy_acceptances: JSON.stringify([{ policy: 'tos', version_id: 'polv_1', content_sha256: 'h', display: 'scroll', scrolled_to_end: true }]) });
    await vi.waitFor(() => expect(posts('/v1/client/sign_ins/sia_1/accept_policies')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins/sia_1/accept_policies')[0]!.body).toEqual({
      policy_acceptances: [{ policy: 'tos', version_id: 'polv_1', content_sha256: 'h', display: 'scroll', scrolled_to_end: true }],
    });
    await vi.waitFor(() => expect(flow.state().attempt?.status).toBe('needs_second_factor'));
  });

  it('declining cancels the attempt and says why', async () => {
    const flow = await controller([], { id: 'sia_1', status: 'needs_policy_acceptance' });
    flow.declinePolicy('Terms of Service');
    expect(flow.state().attempt).toBeNull();
    expect(flow.state().errors[0]!.message).toContain('Terms of Service');
  });
});

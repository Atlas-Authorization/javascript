import { describe, expect, it, vi } from 'vitest';
import { nextStep } from './attempt';
import type { FapiClient, FlowState } from './fapi';
import { initialFlow } from './fapi';
import { acceptAttemptPolicies, acceptPolicies, buildPolicyAcceptances, getMyPolicies, getPolicies } from './policies';
import { mapOAuthPopupPayload, readRedirectResult, stripRedirectParams } from './redirect';

const PENDING = {
  policy: 'tos',
  policy_id: 'pol_1',
  title: 'Terms',
  display: 'scroll',
  version_id: 'polv_2',
  version: '2026-11-01',
  content_sha256: 'a'.repeat(64),
  reaccept: true,
  summary_of_changes: 'Changed.',
};

function stubClient(answer: (path: string, body?: unknown) => { ok: boolean; data?: unknown; errors?: unknown[] }) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const respond = async (path: string, body?: unknown) => {
    calls.push({ path, body });
    const a = answer(path, body);
    return { ok: a.ok, status: a.ok ? 200 : 422, data: a.data ?? null, errors: a.errors ?? [] };
  };
  const client = {
    request: vi.fn((path: string) => respond(path)),
    post: vi.fn((path: string, body?: unknown) => respond(path, body)),
  } as unknown as FapiClient;
  return { client, calls };
}

describe('policy acceptance helpers', () => {
  it('maps needs_policy_acceptance to the accept_policies step', () => {
    expect(nextStep({ id: 'sia_1', status: 'needs_policy_acceptance', pending_policies: [PENDING] })).toEqual({
      kind: 'accept_policies',
      policies: [PENDING],
    });
  });

  it('builds acceptances from public or pending policies with reading evidence', () => {
    expect(buildPolicyAcceptances([PENDING], { tos: { scrolledToEnd: true, viewMs: 1234.4 } }, { locale: 'en' })).toEqual([
      { policy: 'tos', version_id: 'polv_2', content_sha256: 'a'.repeat(64), display: 'scroll', scrolled_to_end: true, view_ms: 1234, locale: 'en' },
    ]);
    expect(buildPolicyAcceptances([{ key: 'privacy', version_id: 'polv_9', content_sha256: 'b'.repeat(64), display: 'checkbox' }])).toEqual([
      { policy: 'privacy', version_id: 'polv_9', content_sha256: 'b'.repeat(64), display: 'checkbox' },
    ]);
  });

  it('continues a held attempt with its token and picks up the ticket', async () => {
    const { client, calls } = stubClient(() => ({ ok: true, data: { id: 'sia_1', status: 'complete', ticket: 'tkt' } }));
    const state: FlowState = { ...initialFlow, attempt: { id: 'sia_1', status: 'needs_policy_acceptance' }, policyToken: 'ptok' };
    const next = await acceptAttemptPolicies(client, state, buildPolicyAcceptances([PENDING], { tos: { scrolledToEnd: true } }));
    expect(calls[0]!.path).toBe('/v1/client/sign_ins/sia_1/accept_policies');
    expect(calls[0]!.body).toMatchObject({ policy_acceptance_token: 'ptok', policy_acceptances: [expect.objectContaining({ policy: 'tos' })] });
    expect(next).toMatchObject({ ticket: 'tkt', attempt: { status: 'complete' }, policyToken: null });
  });

  it('falls back to the poll secret, and keeps the attempt on an error', async () => {
    const { client, calls } = stubClient(() => ({ ok: false, errors: [{ code: 'POLICY_ACCEPTANCE_REQUIRED', message: 'x' }] }));
    const state: FlowState = { ...initialFlow, attempt: { id: 'sia_2', status: 'needs_policy_acceptance' }, pollSecret: 'ps' };
    const next = await acceptAttemptPolicies(client, state, []);
    expect(calls[0]!.body).toMatchObject({ poll_secret: 'ps' });
    expect(next.attempt?.id).toBe('sia_2');
    expect(next.errors[0]!.code).toBe('POLICY_ACCEPTANCE_REQUIRED');
  });

  it('reads policies and the user standing, and accepts in-app', async () => {
    const { client, calls } = stubClient((path) => ({ ok: true, data: { object: 'list', data: [], path } }));
    expect((await getPolicies(client, { locale: 'de' })).ok).toBe(true);
    expect(calls[0]!.path).toBe('/v1/client/policies?locale=de');
    await getMyPolicies(client);
    expect(calls[1]!.path).toBe('/v1/client/me/policies');
    await acceptPolicies(client, [{ policy: 'tos', version_id: 'v', content_sha256: 'c'.repeat(64) }]);
    expect(calls[2]).toMatchObject({ path: '/v1/client/me/policies/accept', body: { policy_acceptances: [{ policy: 'tos' }] } });
  });

  it('reads the policy token from a redirect and a popup, and strips it', () => {
    expect(readRedirectResult('?__atlas_attempt=sia_1&__atlas_status=needs_policy_acceptance&__atlas_policy_token=pt')).toEqual({
      attemptId: 'sia_1',
      status: 'needs_policy_acceptance',
      policyToken: 'pt',
    });
    expect(readRedirectResult('?__atlas_attempt=sia_1&__atlas_status=needs_second_factor&__atlas_policy_token=pt')).toEqual({
      attemptId: 'sia_1',
      status: 'needs_second_factor',
    });
    expect(mapOAuthPopupPayload({ type: 'atlas:oauth:continue', status: 'needs_policy_acceptance', attemptId: 'sia_1', policyToken: 'pt' })).toMatchObject({ policyToken: 'pt' });
    expect(stripRedirectParams('https://app.test/?__atlas_attempt=a&__atlas_policy_token=p&x=1')).toBe('https://app.test/?x=1');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { AtlasApiError } from './client/error';
import { agentDelegator } from './machine-delegation';
import { dpopThumbprint, generateDpopKey } from './machine-dpop';

const ok = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const lastCall = (f: typeof fetch) => (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit];

describe('agentDelegator', () => {
  const pem = generateDpopKey();

  it('sends the token with a DPoP proof bound to it, the publishable key and the body', async () => {
    const f = ok({ object: 'agent_delegation', id: 'dlg_1' }, 201);
    const agent = agentDelegator({ publishableKey: 'pk_test_x', privateKeyPem: pem, token: () => 'tok_1', baseUrl: 'https://auth.example.test/', fetch: f });
    const out = await agent.delegate({ child_machine_id: 'mch_2', scopes: ['reports:read'], expires_in_seconds: 900 });
    expect(out.id).toBe('dlg_1');
    const [url, init] = lastCall(f);
    expect(url).toBe('https://auth.example.test/v1/client/agent_delegations');
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe('DPoP tok_1');
    expect(h['x-publishable-key']).toBe('pk_test_x');
    const [head, payload] = h.dpop!.split('.').slice(0, 2).map((p) => JSON.parse(Buffer.from(p, 'base64url').toString()));
    expect(head.typ).toBe('dpop+jwt');
    expect(payload).toMatchObject({ htm: 'POST', htu: 'https://auth.example.test/v1/client/agent_delegations' });
    expect(payload.ath).toBeTypeOf('string');
    expect(JSON.parse(init.body as string)).toEqual({ child_machine_id: 'mch_2', scopes: ['reports:read'], expires_in_seconds: 900 });
    expect(dpopThumbprint(pem)).toBeTypeOf('string');
  });

  it('lists and revokes under the agent, and turns a failure into an AtlasApiError', async () => {
    const list = ok({ object: 'list', data: [], has_more: false });
    expect((await agentDelegator({ publishableKey: 'pk', privateKeyPem: pem, token: 't', baseUrl: 'https://a.test', fetch: list }).list()).data).toEqual([]);
    expect(lastCall(list)[1].method).toBe('GET');
    const rev = ok({ object: 'agent_delegation_revocation', revoked: [], disabled_machine_ids: [], count: 0 });
    await agentDelegator({ publishableKey: 'pk', privateKeyPem: pem, token: 't', baseUrl: 'https://a.test', fetch: rev }).revoke('dlg/1', 'done');
    expect(lastCall(rev)[0]).toBe('https://a.test/v1/client/agent_delegations/dlg%2F1/revoke');
    expect(JSON.parse(lastCall(rev)[1].body as string)).toEqual({ reason: 'done' });
    const denied = ok({ errors: [{ code: 'FORBIDDEN', message: 'no', reason: 'delegation_inactive' }] }, 403);
    await expect(agentDelegator({ publishableKey: 'pk', privateKeyPem: pem, token: 't', baseUrl: 'https://a.test', fetch: denied }).delegate({ child_machine_id: 'm', scopes: ['a'] })).rejects.toBeInstanceOf(AtlasApiError);
  });
});

import { AtlasApiError, type AtlasErrorItem } from './client/error';
import type { AgentDelegation, AgentDelegationRevocation, CreateAgentDelegationBody } from './client/trust';
import { DEFAULT_API_URL } from './client/request';
import { createDpopProof } from './machine-dpop';

/**
 * An agent delegating to another agent for itself: hand a narrower part of the delegation the agent acts under to a
 * sub-agent, with the agent's OWN DPoP-bound machine token (no secret key involved). Needs `agentFabric.allowSelfDelegation`
 * on the instance. Node only (it signs the DPoP proofs with `node:crypto`); import it from `@atlasauth/backend/machine`.
 *
 *   const agent = agentDelegator({ publishableKey, privateKeyPem: dpopKey, token: () => machine.token() });
 *   await agent.delegate({ child_machine_id: 'mch_...', scopes: ['reports:read'], expires_in_seconds: 900 });
 *
 * `token` is a machine token minted under a delegation with a DPoP proof from the same `privateKeyPem` (so it carries
 * `cnf.jkt`) and no resource-server audience. Each call signs a fresh proof bound to the token.
 */
export interface AgentDelegatorOptions {
  publishableKey: string;
  /** The PKCS#8 PEM of the DPoP key the token is bound to. */
  privateKeyPem: string;
  /** The machine token, or a function that returns a current one. */
  token: string | (() => string | Promise<string>);
  /** The Frontend API origin that serves your instance. Default: the Atlas API. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export function agentDelegator(options: AgentDelegatorOptions) {
  const base = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const token = typeof options.token === 'function' ? await options.token() : options.token;
    const url = `${base}${path}`;
    const res = await doFetch(url, {
      method,
      headers: {
        authorization: `DPoP ${token}`,
        dpop: createDpopProof({ privateKeyPem: options.privateKeyPem, method, url, accessToken: token }),
        'x-publishable-key': options.publishableKey,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : {};
    if (!res.ok) throw new AtlasApiError(res.status, ((json as { errors?: AtlasErrorItem[] }).errors ?? []) as AtlasErrorItem[]);
    return json as T;
  }

  return {
    /** Delegate a narrower part of this agent's own delegation to another agent of the same owner. */
    delegate(body: Pick<CreateAgentDelegationBody, 'child_machine_id' | 'scopes' | 'resource' | 'expires_in_seconds' | 'expires_at'>): Promise<AgentDelegation> {
      return call('POST', '/v1/client/agent_delegations', body);
    },
    /** The delegations below this agent's own. */
    list(): Promise<{ object: 'list'; data: AgentDelegation[]; has_more: boolean }> {
      return call('GET', '/v1/client/agent_delegations');
    },
    /** Revoke one of them, with everything below it. */
    revoke(id: string, reason?: string): Promise<AgentDelegationRevocation> {
      return call('POST', `/v1/client/agent_delegations/${encodeURIComponent(id)}/revoke`, reason ? { reason } : {});
    },
  };
}

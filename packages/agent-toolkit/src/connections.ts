import { z } from 'zod';
import type { AgentTool } from './types';

/**
 * The connections tools: what an AI agent can do with the third-party accounts people connected to it. Unlike the
 * identity toolkit (which manages Atlas itself with a secret key), these run as the AGENT: they call the agent endpoints
 * with the agent token, so everything is limited to connections the agent holds a grant for, and a provider credential
 * never reaches the model (there is deliberately no tool that returns a token; calls go through Atlas).
 */
export interface ConnectionsToolkitOptions {
  /** The Atlas API origin of the instance, e.g. https://clerk.example.com or https://api.atlasauth.net. */
  baseUrl: string;
  /** The agent token (Bearer), or a function returning a fresh one (tokens are short-lived). */
  agentToken: string | (() => string | Promise<string>);
  /** The instance's publishable key, when `baseUrl` is not the instance's own frontend host. */
  publishableKey?: string;
  /** Where a person returns after connecting an account; lets a 402 carry an authorize link. */
  redirectUrl?: string;
  /** Together these enable `request_connection_access` (the access-request endpoint authenticates with the agent secret). */
  agentId?: string;
  agentSecret?: string;
  fetch?: typeof fetch;
}

const connection = z.string().min(1).describe('A connection id, or provider:<key> (for example provider:github) to use the owner\'s connection to that provider.');

/** What a failed call returns to the model: enough to act on (ask the person to connect, request access), never a stack. */
interface Failure {
  ok: false;
  status: number;
  error: string;
  code?: string;
  authorize_url?: string;
  reason?: string;
}

export function createConnectionsToolkit(options: ConnectionsToolkitOptions): AgentTool[] {
  const f = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');

  async function call(method: 'GET' | 'POST', path: string, body?: unknown, auth = true): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (auth) {
      const token = typeof options.agentToken === 'function' ? await options.agentToken() : options.agentToken;
      headers.authorization = `Bearer ${token}`;
    }
    if (options.publishableKey) headers['x-publishable-key'] = options.publishableKey;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await f(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 2000) };
    }
    if (res.ok) return json;
    const err = (json as { errors?: { code?: string; message?: string; meta?: Record<string, unknown> }[] }).errors?.[0];
    const failure: Failure = {
      ok: false,
      status: res.status,
      error: err?.message ?? `The request failed with ${res.status}.`,
      ...(err?.code ? { code: err.code } : {}),
      ...(typeof err?.meta?.authorize_url === 'string' ? { authorize_url: err.meta.authorize_url } : {}),
      ...(typeof err?.meta?.reason === 'string' ? { reason: err.meta.reason } : {}),
    };
    return failure;
  }
  const ref = (c: string) => encodeURIComponent(c);

  const tools: AgentTool[] = [
    {
      name: 'list_connections',
      description: 'List the third-party accounts (GitHub, Slack, Google, ...) this agent has been given access to, with the status of each.',
      readOnly: true,
      schema: z.object({}),
      execute: () => call('GET', '/v1/agents/connections'),
    },
    {
      name: 'list_connection_actions',
      description: 'List the typed actions available on a connection (for example create_issue on GitHub), each with its input schema.',
      readOnly: true,
      schema: z.object({ connection }),
      execute: (a) => call('GET', `/v1/agents/connections/${ref((a as { connection: string }).connection)}/actions`),
    },
    {
      name: 'run_connection_action',
      description:
        'Run one action on a connection with the given input (see list_connection_actions for the input schema). ' +
        'If the account is not connected the answer says so and may carry an authorize_url to give the person. Use dry_run to see the request without sending it.',
      schema: z.object({
        connection,
        action: z.string().min(1).describe('The action name, for example create_issue.'),
        input: z.record(z.unknown()).default({}).describe('The action input.'),
        dry_run: z.boolean().optional().describe('Return the request that would be sent, without sending it.'),
      }),
      execute: (a) => {
        const x = a as { connection: string; action: string; input: Record<string, unknown>; dry_run?: boolean };
        return call('POST', `/v1/agents/connections/${ref(x.connection)}/actions/${ref(x.action)}`, { input: x.input, dry_run: x.dry_run, redirect_url: options.redirectUrl });
      },
    },
    {
      name: 'call_provider_api',
      description:
        'Make a raw HTTPS call to the provider\'s API through a connection, for anything no action covers. Atlas adds the credential; ' +
        'only the connection\'s allowed hosts and methods work. Returns the status, headers and body.',
      schema: z.object({
        connection,
        method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
        url: z.string().url().describe('The absolute https URL on one of the connection\'s allowed hosts.'),
        headers: z.record(z.string()).optional(),
        body: z.unknown().optional().describe('A string, or JSON for POST, PUT, PATCH and DELETE.'),
      }),
      execute: (a) => {
        const x = a as { connection: string; method: string; url: string; headers?: Record<string, string>; body?: unknown };
        return call('POST', `/v1/agents/connections/${ref(x.connection)}/relay`, { method: x.method, url: x.url, headers: x.headers, body: x.body, redirect_url: options.redirectUrl });
      },
    },
  ];

  if (options.agentId && options.agentSecret) {
    const { agentId, agentSecret } = options;
    tools.push({
      name: 'request_connection_access',
      description: 'Ask a person to approve this agent using a connection (or every connection to a provider, with provider:<key>). Returns the pending request.',
      schema: z.object({ connection, reason: z.string().max(500).optional().describe('Why the agent needs it; shown to the approver.') }),
      execute: (a) => {
        const x = a as { connection: string; reason?: string };
        return call('POST', '/v1/agents/access_requests', { agent_id: agentId, agent_secret: agentSecret, kind: 'connection', resource: x.connection, reason: x.reason }, false);
      },
    });
  }
  return tools;
}

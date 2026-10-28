import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/** Policy for one tool behind an MCP gateway. */
export interface McpToolPolicy {
  allow?: boolean;
  /** Scopes the agent token must hold. */
  scopes?: string[];
  conditions?: Array<{ arg: string; op: 'eq' | 'neq' | 'lte' | 'gte' | 'in' | 'not_in' | 'present'; value?: unknown }>;
  /** Hold the call until a human approves an access request. */
  approval?: boolean;
  mask?: { fields?: string[]; presets?: Array<'email' | 'card' | 'ssn' | 'phone'> };
}

/** One URL (`url`) in front of your MCP server, with per-tool policy. */
export interface McpGateway {
  object: 'mcp_gateway';
  id: string;
  name: string;
  /** Null for a gateway made only of upstreams. */
  upstream_url: string | null;
  /** The upstream Authorization header is write-only. */
  has_upstream_authorization: boolean;
  default_policy: 'allow' | 'deny';
  tools: Record<string, McpToolPolicy>;
  enabled: boolean;
  /** Authorize every tool call through the ABAC policy engine too. */
  abac: McpGatewayAbac;
  /** A caller sees only the tools of packs assigned to them. */
  packs_enforced: boolean;
  /** Upstreams must be approved in the registry. */
  registry_only: boolean;
  guard: McpGatewayGuard;
  user_auth: McpGatewayUserAuth;
  /** The URL (and RFC 8707 resource) MCP clients connect to. */
  resource: string;
  resource_metadata_url: string;
  url: string;
  created_at: number;
}

/** Response and argument guardrails of a gateway. */
export interface McpGatewayGuard {
  /** Block tool results shaped like prompt injection. */
  injection: boolean;
  /** Redacted in results, refused in arguments: email, card, ssn, phone. */
  pii: Array<'email' | 'card' | 'ssn' | 'phone'>;
  block_patterns: string[];
  /** Pin each tool's description and schema; block a tool whose definition changed. */
  pin_tools: boolean;
  max_result_chars: number;
}

/** End-user OAuth: MCP clients sign people in with Atlas and call with their token. */
export interface McpGatewayUserAuth {
  enabled: boolean;
  allow_agents: boolean;
  /** Group name (`*` = everyone) to the tool names (a trailing `*` is a prefix) that group may use. */
  groups: Record<string, string[]>;
  required_scopes: string[];
}

/**
 * Each call is checked as: principal = the agent (type `Agent`: name, tier, owner_user_id,
 * organization_id, scopes, data), action = the tool name, resource = the tool (type `McpTool`:
 * gateway_id, gateway_name, tool, args). With `enabled` and no permitting policy, every call is denied.
 */
export interface McpGatewayAbac {
  enabled: boolean;
  /** The policies consulted; empty means every enabled policy. */
  policy_ids: string[];
}

/** A ceiling across calls: calls, cost units, or calls per window, per agent or per session. */
export interface McpBudget {
  object: 'mcp_budget';
  id: string;
  gateway_id: string;
  name: string;
  /** `agent`: each agent counts apart. `session`: each session (the Mcp-Session-Id an initialize returns). */
  scope: 'agent' | 'session';
  agent_id: string | null;
  tool: string | null;
  metric: 'calls' | 'cost' | 'rate';
  limit: number;
  /** Fixed windows; null never resets. */
  window_seconds: number | null;
  cost_per_call: number;
  /** A dot path to a number in the call arguments that is the cost of the call. */
  cost_arg: string | null;
  enabled: boolean;
  created_at: number;
}

export interface CreateMcpBudgetBody {
  name: string;
  metric: 'calls' | 'cost' | 'rate';
  limit: number;
  scope?: 'agent' | 'session';
  /** Required for `rate`. */
  window_seconds?: number | null;
  agent_id?: string | null;
  tool?: string | null;
  cost_per_call?: number;
  cost_arg?: string | null;
  enabled?: boolean;
}

export interface McpBudgetUsage {
  object: 'mcp_budget_usage';
  budget_id: string;
  agent_id: string;
  used: number;
  limit: number;
  remaining: number;
  resets_at: number | null;
}

export interface CreateMcpGatewayBody {
  name: string;
  /** Omit for a gateway made only of upstreams. */
  upstream_url?: string | null;
  upstream_authorization?: string;
  default_policy?: 'allow' | 'deny';
  tools?: Record<string, McpToolPolicy>;
  enabled?: boolean;
  abac?: Partial<McpGatewayAbac>;
  packs_enforced?: boolean;
  registry_only?: boolean;
  guard?: Partial<Omit<McpGatewayGuard, 'block_patterns'>> & { block_patterns?: string[] };
  user_auth?: Partial<McpGatewayUserAuth>;
}

export type UpdateMcpGatewayBody = Partial<CreateMcpGatewayBody>;

/** One upstream of a gateway: an MCP server, an OpenAPI-described API, or a connection's managed actions. */
export interface McpGatewayUpstream {
  object: 'mcp_gateway_upstream';
  id: string;
  gateway_id: string;
  namespace: string;
  kind: 'mcp' | 'openapi' | 'actions';
  url: string | null;
  auth_kind: 'none' | 'static' | 'connection';
  has_authorization: boolean;
  connection_id: string | null;
  connection_owner: 'org' | 'agent_owner';
  connect_redirect_url: string | null;
  action_names: string[];
  tool_count: number | null;
  stream: boolean;
  enabled: boolean;
  created_at: number;
}

export interface McpGatewayUpstreamBody {
  namespace?: string;
  kind?: 'mcp' | 'openapi' | 'actions';
  url?: string;
  /** openapi: an OpenAPI 3.x document. */
  openapi?: Record<string, unknown>;
  auth_kind?: 'none' | 'static' | 'connection';
  /** Write-only. */
  authorization?: string;
  connection_id?: string;
  connection_owner?: 'org' | 'agent_owner';
  connect_redirect_url?: string | null;
  action_names?: string[];
  stream?: boolean;
  enabled?: boolean;
}

export interface McpToolPack {
  object: 'mcp_tool_pack';
  id: string;
  gateway_id: string;
  name: string;
  description: string | null;
  tools: string[];
  agent_ids: string[];
  org_ids: string[];
  groups: string[];
  created_at: number;
}

export interface McpToolPackBody {
  name?: string;
  description?: string | null;
  tools?: string[];
  agent_ids?: string[];
  org_ids?: string[];
  groups?: string[];
}

export interface McpToolPin {
  object: 'mcp_tool_pin';
  gateway_id: string;
  tool: string;
  status: 'approved' | 'changed';
  approved_by: string | null;
  approved_at: number;
  changed_at: number | null;
}

export function mcpGatewaysResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<McpGateway>> {
      return request({ method: 'GET', path: '/v1/mcp_gateways' });
    },
    create(body: CreateMcpGatewayBody, idempotencyKey?: string): Promise<McpGateway> {
      return request({ method: 'POST', path: '/v1/mcp_gateways', body, idempotencyKey });
    },
    get(id: string): Promise<McpGateway> {
      return request({ method: 'GET', path: `/v1/mcp_gateways/${enc(id)}` });
    },
    /** `tools` is replaced as a whole. */
    update(id: string, body: UpdateMcpGatewayBody): Promise<McpGateway> {
      return request({ method: 'PATCH', path: `/v1/mcp_gateways/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'mcp_gateway'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/mcp_gateways/${enc(id)}` });
    },
    /** Cross-call budgets of one gateway. */
    budgets: {
      list(gatewayId: string): Promise<ListPage<McpBudget>> {
        return request({ method: 'GET', path: `/v1/mcp_gateways/${enc(gatewayId)}/budgets` });
      },
      create(gatewayId: string, body: CreateMcpBudgetBody): Promise<McpBudget> {
        return request({ method: 'POST', path: `/v1/mcp_gateways/${enc(gatewayId)}/budgets`, body });
      },
      get(gatewayId: string, budgetId: string): Promise<McpBudget> {
        return request({ method: 'GET', path: `/v1/mcp_gateways/${enc(gatewayId)}/budgets/${enc(budgetId)}` });
      },
      update(gatewayId: string, budgetId: string, body: Partial<CreateMcpBudgetBody>): Promise<McpBudget> {
        return request({ method: 'PATCH', path: `/v1/mcp_gateways/${enc(gatewayId)}/budgets/${enc(budgetId)}`, body });
      },
      delete(gatewayId: string, budgetId: string): Promise<{ object: 'mcp_budget'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/mcp_gateways/${enc(gatewayId)}/budgets/${enc(budgetId)}` });
      },
      /** What an agent (and, for a per-session budget, one session) has used of the budget now. */
      usage(gatewayId: string, budgetId: string, query: { agent_id?: string; session_id?: string } = {}): Promise<McpBudgetUsage> {
        return request({ method: 'GET', path: `/v1/mcp_gateways/${enc(gatewayId)}/budgets/${enc(budgetId)}/usage`, query: { ...query } });
      },
    },
    /** MCP servers and APIs behind one gateway, each under a namespace (`<namespace>__<tool>`). */
    upstreams: {
      list(gatewayId: string): Promise<ListPage<McpGatewayUpstream>> {
        return request({ method: 'GET', path: `/v1/mcp_gateways/${enc(gatewayId)}/upstreams` });
      },
      create(gatewayId: string, body: McpGatewayUpstreamBody): Promise<McpGatewayUpstream> {
        return request({ method: 'POST', path: `/v1/mcp_gateways/${enc(gatewayId)}/upstreams`, body });
      },
      get(gatewayId: string, upstreamId: string): Promise<McpGatewayUpstream> {
        return request({ method: 'GET', path: `/v1/mcp_gateways/${enc(gatewayId)}/upstreams/${enc(upstreamId)}` });
      },
      update(gatewayId: string, upstreamId: string, body: McpGatewayUpstreamBody): Promise<McpGatewayUpstream> {
        return request({ method: 'PATCH', path: `/v1/mcp_gateways/${enc(gatewayId)}/upstreams/${enc(upstreamId)}`, body });
      },
      delete(gatewayId: string, upstreamId: string): Promise<{ object: 'mcp_gateway_upstream'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/mcp_gateways/${enc(gatewayId)}/upstreams/${enc(upstreamId)}` });
      },
      /** Reach the upstream and list the tools it would add. */
      test(gatewayId: string, upstreamId: string): Promise<{ object: 'mcp_upstream_test'; ok: boolean; tools: string[]; error: string | null }> {
        return request({ method: 'POST', path: `/v1/mcp_gateways/${enc(gatewayId)}/upstreams/${enc(upstreamId)}/test` });
      },
    },
    /** Named tool sets assigned to agents, organizations or groups. */
    packs: {
      list(gatewayId: string): Promise<ListPage<McpToolPack>> {
        return request({ method: 'GET', path: `/v1/mcp_gateways/${enc(gatewayId)}/packs` });
      },
      create(gatewayId: string, body: McpToolPackBody & { name: string }): Promise<McpToolPack> {
        return request({ method: 'POST', path: `/v1/mcp_gateways/${enc(gatewayId)}/packs`, body });
      },
      get(gatewayId: string, packId: string): Promise<McpToolPack> {
        return request({ method: 'GET', path: `/v1/mcp_gateways/${enc(gatewayId)}/packs/${enc(packId)}` });
      },
      update(gatewayId: string, packId: string, body: McpToolPackBody): Promise<McpToolPack> {
        return request({ method: 'PATCH', path: `/v1/mcp_gateways/${enc(gatewayId)}/packs/${enc(packId)}`, body });
      },
      delete(gatewayId: string, packId: string): Promise<{ object: 'mcp_tool_pack'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/mcp_gateways/${enc(gatewayId)}/packs/${enc(packId)}` });
      },
    },
    /** Pinned tool definitions (`guard.pin_tools`): review what changed, approve it. */
    pins: {
      list(gatewayId: string, query: { status?: 'approved' | 'changed' } = {}): Promise<ListPage<McpToolPin>> {
        return request({ method: 'GET', path: `/v1/mcp_gateways/${enc(gatewayId)}/pins`, query: { ...query } });
      },
      approve(gatewayId: string, tool: string): Promise<McpToolPin> {
        return request({ method: 'POST', path: `/v1/mcp_gateways/${enc(gatewayId)}/pins/${enc(tool)}/approve` });
      },
      delete(gatewayId: string, tool: string): Promise<{ object: 'mcp_tool_pin'; gateway_id: string; tool: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/mcp_gateways/${enc(gatewayId)}/pins/${enc(tool)}` });
      },
    },
  };
}

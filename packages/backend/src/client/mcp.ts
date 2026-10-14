import type { RequestFn } from './request';

/** `GET /v1/mcp` — the MCP server descriptor and the tools this key may call. */
export interface McpServerDescriptor {
  object: 'mcp_server';
  protocol_version: string;
  server: { name?: string; version?: string };
  capabilities: Record<string, unknown>;
  /** MCP tool definitions (name, description, inputSchema, annotations…). */
  tools: Array<Record<string, unknown>>;
  rate_limit?: unknown;
  recommended_agent_scopes?: string[];
}

/** The JSON-RPC 2.0 envelope `POST /v1/mcp` answers with. */
export interface McpJsonRpcResponse<R = Record<string, unknown>> {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: R;
  error?: { code: number; message: string };
}

/** A `tools/call` result. A refused call is a result with `isError: true`, not a JSON-RPC error. */
export interface McpToolCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  [key: string]: unknown;
}

/** The instance's remote MCP connector (OAuth-protected MCP for end users). */
export interface McpConnector {
  object: 'mcp_connector';
  enabled: boolean;
  name: string | null;
  exposed_scopes: string[];
  dynamic_registration: boolean;
  allowed_redirect_hosts: string[];
  /** The RFC 9728 protected-resource metadata URL. */
  discovery_url: string | null;
  /** The RFC 8707 resource identifier (token audience). */
  resource: string | null;
  /** Whether the MCP resource server has been provisioned. */
  resource_server_exists: boolean;
}

/** User-scoped tool groups the connector can expose. */
export type McpConnectorScope = 'profile' | 'email' | 'mfa' | 'sessions' | 'organizations';

/** `PUT /v1/mcp_connector` — only the fields you send change. */
export interface UpdateMcpConnectorBody {
  /** Master switch. Enabling provisions the MCP resource server and needs a frontend API host. */
  enabled?: boolean;
  /** Display name on the consent screen (max 80 chars). */
  name?: string;
  exposed_scopes?: McpConnectorScope[];
  /** Let MCP clients self-register an OAuth client (RFC 7591). */
  dynamic_registration?: boolean;
  /** Extra redirect-URI hostnames allowed for dynamic registration. */
  allowed_redirect_hosts?: string[];
}

export function mcpResource(request: RequestFn) {
  let nextId = 1;
  const rpc = <R = Record<string, unknown>>(
    method: string,
    params?: unknown,
    id?: string | number,
  ): Promise<McpJsonRpcResponse<R>> =>
    request({
      method: 'POST',
      path: '/v1/mcp',
      body: { jsonrpc: '2.0', id: id ?? nextId++, method, ...(params !== undefined ? { params } : {}) },
    });

  return {
    /** The server descriptor and the tools this secret key may call. */
    describe(): Promise<McpServerDescriptor> {
      return request({ method: 'GET', path: '/v1/mcp' });
    },
    /**
     * Send one JSON-RPC call (`initialize`, `tools/list`, `tools/call`, `ping`).
     * A JSON-RPC error comes back in `error`, not as a thrown exception.
     */
    rpc,
    /** `tools/list` — the tools this key may call. */
    listTools(): Promise<McpJsonRpcResponse<{ tools: Array<Record<string, unknown>> }>> {
      return rpc('tools/list');
    },
    /** `tools/call` — run one tool with its arguments. */
    callTool(
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<McpJsonRpcResponse<McpToolCallResult>> {
      return rpc('tools/call', { name, arguments: args });
    },
  };
}

export function mcpConnectorResource(request: RequestFn) {
  return {
    get(): Promise<McpConnector> {
      return request({ method: 'GET', path: '/v1/mcp_connector' });
    },
    /** Configure the connector. Only the fields you send change; an unknown scope is a 422. */
    update(body: UpdateMcpConnectorBody, idempotencyKey?: string): Promise<McpConnector> {
      return request({ method: 'PUT', path: '/v1/mcp_connector', body, idempotencyKey });
    },
    /** Disable it. Preferences are kept for a later re-enable; issued tokens stop working at once. */
    disable(): Promise<McpConnector> {
      return request({ method: 'DELETE', path: '/v1/mcp_connector' });
    },
  };
}

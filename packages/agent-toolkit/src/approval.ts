/**
 * Approvals v2 for agent tools. The gate, the wrapper and the errors live in `@atlasauth/backend` so the agent toolkit,
 * the MCP server, `@atlasauth/langchain` and `@atlasauth/llamaindex` share one implementation and one option shape:
 *
 *   const gate = createApprovalGate({ client: atlas, jwks });
 *   const toolkit = createAtlasToolkit({ backend: atlas, scopes: ['users:write'], approvals: { gate, user: 'user_123' } });
 *
 * A tool that needs approval creates a request bound to the tool and its exact arguments, waits for the approver (or,
 * with `mode: 'resume'`, throws `ApprovalPendingError` carrying the approval id; call the tool again with
 * `approval_id`), spends the approval once, checks the signed receipt, and then runs.
 */
export {
  ApprovalDeniedError,
  ApprovalPendingError,
  ToolUsageDeniedError,
  bindingFor,
  createApprovalGate,
  guardToolCall,
  withApproval,
} from '@atlasauth/backend';
export type { ApprovalGate, ApprovalGateClient, ApprovalGateOptions, ApprovalToolOptions } from '@atlasauth/backend';

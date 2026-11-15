import { enc, type RequestFn } from './request';
import type { ConnectionOAuthClient, ConnectionOwnerType, ConnectionEnvironment } from './connections';

/** TypeScript declarations for the action catalog, generated from the same schemas Atlas validates with. */
export interface ConnectionActionTypes {
  object: 'connection_action_types';
  provider: string | null;
  /** How many actions the declarations cover. */
  actions: number;
  /** TypeScript source: save it to a .ts file. */
  source: string;
}

export type ConnectionProviderChangeKind = 'output_drift' | 'deprecation' | 'endpoint_gone';

/** What a provider changed under one of your actions. Header values and schema paths only, never a body. */
export interface ConnectionProviderChange {
  object: 'connection_provider_change';
  id: string;
  provider: string;
  kind: ConnectionProviderChangeKind;
  action: string;
  detail: Record<string, unknown>;
  status: 'open' | 'acknowledged' | 'resolved';
  occurrences: number;
  first_seen_at: number;
  last_seen_at: number;
  handled_by: string | null;
  handled_at: number | null;
}

export interface ListConnectionProviderChangesParams {
  provider?: string;
  /** Default `open`. */
  status?: 'open' | 'acknowledged' | 'resolved' | 'all';
  kind?: ConnectionProviderChangeKind;
  limit?: number;
  starting_after?: string;
}

export type ConnectionPermission = 'read_token' | 'relay' | 'run_actions' | 'sign';

export interface ConnectionAccessRuleInput {
  principal_type: 'api_key' | 'user' | 'org_role';
  principal_id: string;
  permissions: ConnectionPermission[];
}

export interface ConnectionAccessRules {
  object: 'connection_access_rules';
  connection_id: string;
  /** False while there is no rule: every key with the route's scope may use the connection. */
  restricted: boolean;
  rules: Array<ConnectionAccessRuleInput & { object: 'connection_access_rule'; id: string; connection_id: string; created_at: number }>;
}

export interface RegisterConnectionOAuthClientBody {
  /** Omit, or `{type: 'instance'}`, for the instance-wide client. */
  owner?: { type: ConnectionOwnerType; id: string } | { type: 'instance' };
  provider: string;
  environment?: ConnectionEnvironment;
  /** The provider's registration endpoint (https). */
  registration_endpoint: string;
  /** A token the provider requires to register. Sent once, never stored. */
  initial_access_token?: string;
  client_name?: string;
  redirect_uri?: string;
  scopes?: string[];
  /** Default `client_secret_basic`. `private_key_jwt`: Atlas generates the key and registers its public half. */
  token_endpoint_auth_method?: 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt';
}

export function connectionActionsDepthResource(request: RequestFn) {
  return {
    /** TypeScript declarations for the catalog (every provider, or one): `ConnectionActionCatalog[provider][action]` is `{ input, output }`. */
    types(query: { provider?: string } = {}): Promise<ConnectionActionTypes> {
      return request({ method: 'GET', path: '/v1/connection_actions/types', query: { ...query } });
    },
  };
}

export function connectionProviderChangesResource(request: RequestFn) {
  return {
    list(params: ListConnectionProviderChangesParams = {}): Promise<{ object: 'list'; data: ConnectionProviderChange[]; has_more: boolean; next_cursor: string | null }> {
      return request({ method: 'GET', path: '/v1/connection_provider_changes', query: { ...params } });
    },
    get(id: string): Promise<ConnectionProviderChange> {
      return request({ method: 'GET', path: `/v1/connection_provider_changes/${enc(id)}` });
    },
    acknowledge(id: string): Promise<ConnectionProviderChange> {
      return request({ method: 'POST', path: `/v1/connection_provider_changes/${enc(id)}/acknowledge` });
    },
    /** Mark a change dealt with; if the provider does it again it reopens. */
    resolve(id: string): Promise<ConnectionProviderChange> {
      return request({ method: 'POST', path: `/v1/connection_provider_changes/${enc(id)}/resolve` });
    },
  };
}

export function connectionAccessRulesResource(request: RequestFn) {
  return {
    get(connectionId: string): Promise<ConnectionAccessRules> {
      return request({ method: 'GET', path: `/v1/connections/${enc(connectionId)}/access_rules` });
    },
    /** Replace the rules (at most 100). An empty list opens the connection again. */
    set(connectionId: string, rules: ConnectionAccessRuleInput[]): Promise<ConnectionAccessRules> {
      return request({ method: 'PUT', path: `/v1/connections/${enc(connectionId)}/access_rules`, body: { rules } });
    },
    clear(connectionId: string): Promise<void> {
      return request({ method: 'DELETE', path: `/v1/connections/${enc(connectionId)}/access_rules` });
    },
    /** Create the OAuth client at the provider (dynamic client registration, RFC 7591). */
    registerOAuthClient(body: RegisterConnectionOAuthClientBody): Promise<ConnectionOAuthClient & { secret_expires_at: number | null }> {
      return request({ method: 'POST', path: '/v1/connections/oauth_clients/register', body });
    },
  };
}

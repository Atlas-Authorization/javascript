import { enc, type RequestFn } from './request';



export interface ChatIntegrationsListQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type ChatIntegrationsListResult = {
  object: 'list';
  data: ({
    object: 'chat_integration';
    id: string;
    provider: 'slack' | 'teams';
    name: string;
    /** Non-secret settings (workspace, default channel or conversation). Credentials are never returned. */
    config?: Record<string, unknown>;
    /** Which channel or conversation each kind of approval goes to: iga_request, campaign_item, workflow_approval, agent_access, feature_flag, or * for the rest. */
    routing?: {
      [key: string]: string;
    };
    enabled: boolean;
    created_at?: number;
    updated_at?: number;
  })[];
  has_more?: boolean;
};

export type ChatIntegrationsCreateBody = {
  provider: 'slack' | 'teams';
  name: string;
  /** Slack: bot_token and signing_secret. Teams: app_id and app_password (your Azure Bot). Stored in the vault, write-only. */
  credentials: {
    [key: string]: string;
  };
  config?: Record<string, unknown>;
  routing?: {
    [key: string]: string;
  };
};

export type ChatIntegrationsCreateResult = {
  object: 'chat_integration';
  id: string;
  provider: 'slack' | 'teams';
  name: string;
  /** Non-secret settings (workspace, default channel or conversation). Credentials are never returned. */
  config?: Record<string, unknown>;
  /** Which channel or conversation each kind of approval goes to: iga_request, campaign_item, workflow_approval, agent_access, feature_flag, or * for the rest. */
  routing?: {
    [key: string]: string;
  };
  enabled: boolean;
  created_at?: number;
  updated_at?: number;
};

export type ChatIntegrationsGetResult = {
  object: 'chat_integration';
  id: string;
  provider: 'slack' | 'teams';
  name: string;
  /** Non-secret settings (workspace, default channel or conversation). Credentials are never returned. */
  config?: Record<string, unknown>;
  /** Which channel or conversation each kind of approval goes to: iga_request, campaign_item, workflow_approval, agent_access, feature_flag, or * for the rest. */
  routing?: {
    [key: string]: string;
  };
  enabled: boolean;
  created_at?: number;
  updated_at?: number;
};

export type ChatIntegrationsUpdateBody = {
  enabled?: boolean;
  config?: Record<string, unknown>;
  credentials?: {
    [key: string]: string;
  };
  routing?: {
    [key: string]: string;
  };
};

export type ChatIntegrationsUpdateResult = {
  object: 'chat_integration';
  id: string;
  provider: 'slack' | 'teams';
  name: string;
  /** Non-secret settings (workspace, default channel or conversation). Credentials are never returned. */
  config?: Record<string, unknown>;
  /** Which channel or conversation each kind of approval goes to: iga_request, campaign_item, workflow_approval, agent_access, feature_flag, or * for the rest. */
  routing?: {
    [key: string]: string;
  };
  enabled: boolean;
  created_at?: number;
  updated_at?: number;
};

export type ChatIntegrationsDeleteResult = {
  object?: string;
  id?: string;
  deleted: true;
};

export type ChatIntegrationsTestResult = {
  object?: 'chat_integration_test';
  id?: string;
  sent?: number;
};

export interface ChatIntegrationsListUserLinksQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type ChatIntegrationsListUserLinksResult = {
  object: 'list';
  data: ({
    object: 'chat_user_link';
    id: string;
    chat_user_id: string;
    user_id: string;
    source?: 'email' | 'manual';
    created_at?: number;
  })[];
  has_more?: boolean;
};

export type ChatIntegrationsCreateUserLinkBody = {
  chat_user_id: string;
  user_id: string;
};

export type ChatIntegrationsCreateUserLinkResult = {
  object: 'chat_user_link';
  id: string;
  chat_user_id: string;
  user_id: string;
  source?: 'email' | 'manual';
  created_at?: number;
};

export type ChatIntegrationsDeleteUserLinkResult = {
  object?: string;
  id?: string;
  deleted: true;
};

export interface ChatIntegrationsListInteractionsQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type ChatIntegrationsListInteractionsResult = {
  object: 'list';
  data: ({
    object?: 'chat_interaction';
    id?: string;
    subject_type?: string;
    subject_id?: string;
    chat_user_id?: string;
    user_id?: string | null;
    decision?: string;
    outcome?: 'applied' | 'refused' | 'unlinked' | 'stale';
    detail?: string | null;
    created_at?: number;
  })[];
  has_more?: boolean;
};

/** Operations on `/v1/chat_integrations` (10). */
export function chatIntegrationsOpsResource(request: RequestFn) {
  return {
    /** List chat integrations (Slack workspaces and Teams bots). */
    list(query?: ChatIntegrationsListQuery): Promise<ChatIntegrationsListResult> {
      return request({ method: 'GET', path: '/v1/chat_integrations', query: { ...query } });
    },
    /** Connect a Slack workspace or a Teams bot using your own app. Slack credentials are checked with the workspace before saving. */
    create(body: ChatIntegrationsCreateBody, idempotencyKey?: string): Promise<ChatIntegrationsCreateResult> {
      return request({ method: 'POST', path: '/v1/chat_integrations', body, idempotencyKey });
    },
    /** Read one chat integration. */
    get(id: string): Promise<ChatIntegrationsGetResult> {
      return request({ method: 'GET', path: `/v1/chat_integrations/${enc(id)}` });
    },
    /** Turn an integration on or off, change its routing, settings or credentials. `config.agent_approver_user_ids` lists who may decide agent access requests from chat. */
    update(id: string, body: ChatIntegrationsUpdateBody): Promise<ChatIntegrationsUpdateResult> {
      return request({ method: 'PATCH', path: `/v1/chat_integrations/${enc(id)}`, body });
    },
    /** Remove an integration and its stored credentials. */
    delete(id: string): Promise<ChatIntegrationsDeleteResult> {
      return request({ method: 'DELETE', path: `/v1/chat_integrations/${enc(id)}` });
    },
    /** Post a harmless test message to the default channel or conversation. */
    test(id: string): Promise<ChatIntegrationsTestResult> {
      return request({ method: 'POST', path: `/v1/chat_integrations/${enc(id)}/test` });
    },
    /** Chat users linked to Atlas users. A link is made automatically on first click when the chat profile email matches a verified email. */
    listUserLinks(id: string, query?: ChatIntegrationsListUserLinksQuery): Promise<ChatIntegrationsListUserLinksResult> {
      return request({ method: 'GET', path: `/v1/chat_integrations/${enc(id)}/user_links`, query: { ...query } });
    },
    /** Link a chat user to an Atlas user by hand. */
    createUserLink(id: string, body: ChatIntegrationsCreateUserLinkBody, idempotencyKey?: string): Promise<ChatIntegrationsCreateUserLinkResult> {
      return request({ method: 'POST', path: `/v1/chat_integrations/${enc(id)}/user_links`, body, idempotencyKey });
    },
    /** Remove the link between a chat user and an Atlas user. */
    deleteUserLink(id: string, linkId: string): Promise<ChatIntegrationsDeleteUserLinkResult> {
      return request({ method: 'DELETE', path: `/v1/chat_integrations/${enc(id)}/user_links/${enc(linkId)}` });
    },
    /** The latest button clicks and what became of them (applied, refused, unlinked, stale). */
    listInteractions(id: string, query?: ChatIntegrationsListInteractionsQuery): Promise<ChatIntegrationsListInteractionsResult> {
      return request({ method: 'GET', path: `/v1/chat_integrations/${enc(id)}/interactions`, query: { ...query } });
    },
  };
}

import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/**
 * Instance-level groups (independent of organizations) and the rules engine.
 * Groups nest, carry attributes, map to app roles, can ride the session token as
 * `groups`, and fill by hand, by filter, from SSO claims or by rules.
 */
export interface Group {
  object: 'group';
  id: string;
  slug: string;
  name: string;
  description: string | null;
  parent_id: string | null;
  attributes: Record<string, unknown>;
  app_role_keys: string[];
  include_in_token: boolean;
  dynamic_filter: Record<string, unknown> | null;
  sso_match: { claim: string; equals?: string; contains?: string; matches?: string } | null;
  member_count?: number;
  /** `users.groups` only: how the user joined. */
  source?: 'manual' | 'dynamic' | 'sso' | 'rule';
  created_at: number;
  updated_at: number;
}

export interface GroupBody {
  slug?: string;
  name?: string;
  description?: string | null;
  parent_id?: string | null;
  attributes?: Record<string, unknown>;
  app_role_keys?: string[];
  include_in_token?: boolean;
  /** A user-search filter tree. */
  dynamic_filter?: Record<string, unknown> | null;
  sso_match?: Group['sso_match'];
}

export interface GroupMember {
  object: 'group_member';
  group_id: string;
  user_id: string;
  source: 'manual' | 'dynamic' | 'sso' | 'rule';
  source_ref: string | null;
  created_at: number;
}

export type GroupRuleAction =
  | { type: 'add_to_group'; group: string }
  | { type: 'add_app_role'; role: string }
  | { type: 'set_trait'; key: string; value: unknown };

export interface GroupRule {
  object: 'group_rule';
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  condition: Record<string, unknown>;
  actions: GroupRuleAction[];
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface GroupRuleBody {
  name?: string;
  enabled?: boolean;
  priority?: number;
  condition?: Record<string, unknown>;
  actions?: GroupRuleAction[];
}

export interface GroupRuleResult {
  object: 'group_rule_result';
  rule_id: string;
  matched: number;
  groups_added: number;
  groups_removed: number;
  roles_granted: number;
  traits_set: number;
}

export function groupsResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<Group>> {
      return request({ method: 'GET', path: '/v1/groups' });
    },
    get(idOrSlug: string): Promise<Group> {
      return request({ method: 'GET', path: `/v1/groups/${enc(idOrSlug)}` });
    },
    create(body: GroupBody & { slug: string; name: string }, idempotencyKey?: string): Promise<Group> {
      return request({ method: 'POST', path: '/v1/groups', body, idempotencyKey });
    },
    update(idOrSlug: string, body: GroupBody): Promise<Group> {
      return request({ method: 'PATCH', path: `/v1/groups/${enc(idOrSlug)}`, body });
    },
    delete(idOrSlug: string): Promise<{ object: 'group'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/groups/${enc(idOrSlug)}` });
    },
    listMembers(idOrSlug: string, query: { limit?: number; starting_after?: string } = {}): Promise<ListPage<GroupMember> & { next_cursor: string | null }> {
      return request({ method: 'GET', path: `/v1/groups/${enc(idOrSlug)}/members`, query });
    },
    /** Add up to 500 users by hand. */
    addMembers(idOrSlug: string, userIds: string[]): Promise<{ added: number; promoted: number; already_member: number; skipped: number }> {
      return request({ method: 'POST', path: `/v1/groups/${enc(idOrSlug)}/members`, body: { user_ids: userIds } });
    },
    removeMembers(idOrSlug: string, userIds: string[]): Promise<{ removed: number }> {
      return request({ method: 'POST', path: `/v1/groups/${enc(idOrSlug)}/members/remove`, body: { user_ids: userIds } });
    },
    /** Re-evaluate a dynamic group's filter now. */
    reapply(idOrSlug: string): Promise<{ matched: number; added: number; removed: number }> {
      return request({ method: 'POST', path: `/v1/groups/${enc(idOrSlug)}/reapply` });
    },
    /** A user's direct groups. */
    forUser(userId: string): Promise<ListPage<Group>> {
      return request({ method: 'GET', path: `/v1/users/${enc(userId)}/groups` });
    },
    rules: {
      list(): Promise<ListPage<GroupRule>> {
        return request({ method: 'GET', path: '/v1/group_rules' });
      },
      get(id: string): Promise<GroupRule> {
        return request({ method: 'GET', path: `/v1/group_rules/${enc(id)}` });
      },
      create(body: GroupRuleBody & { name: string; condition: Record<string, unknown>; actions: GroupRuleAction[] }, idempotencyKey?: string): Promise<GroupRule> {
        return request({ method: 'POST', path: '/v1/group_rules', body, idempotencyKey });
      },
      update(id: string, body: GroupRuleBody): Promise<GroupRule> {
        return request({ method: 'PATCH', path: `/v1/group_rules/${enc(id)}`, body });
      },
      delete(id: string): Promise<{ object: 'group_rule'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/group_rules/${enc(id)}` });
      },
      /** Run one rule now. */
      apply(id: string): Promise<GroupRuleResult> {
        return request({ method: 'POST', path: `/v1/group_rules/${enc(id)}/apply` });
      },
      /** Run every enabled rule in priority order. */
      applyAll(): Promise<ListPage<GroupRuleResult>> {
        return request({ method: 'POST', path: '/v1/group_rules/apply' });
      },
    },
  };
}

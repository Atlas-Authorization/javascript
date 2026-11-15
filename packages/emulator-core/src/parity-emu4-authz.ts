import type { ParityRequest } from './parity';

const q = (id: string, method: ParityRequest['method'], path: string, rest: Partial<ParityRequest> = {}): ParityRequest => ({ id, method, path, ...rest });

const DSL = 'model\n  schema 1.1\ntype user\ntype group\n  relations\n    define member: [user]\ntype folder\n  relations\n    define viewer: [user, group#member]\ntype doc\n  relations\n    define parent: [folder]\n    define editor: [user]\n    define blocked: [user]\n    define viewer: [user, user:*] or editor or viewer from parent\n    define can_view: viewer but not blocked';

/** Round-four authorization: FGA models and queries, Cedar templates and links, access-policy simulation and zone checks, the agent delegation graph. Self-contained: each run makes its own store, users, machines and templates. */
export const emu4AuthzParityRequests: ParityRequest[] = [
  q('e4a user', 'POST', '/v1/users', { body: { email_address: 'e4a-{{rand}}@example.com' }, capture: { e4au: 'id' } }),
  // ── FGA model, tuples and queries ──
  q('e4a fga store', 'POST', '/v1/fga/stores', { body: { name: 'e4a-{{rand}}' }, capture: { e4as: 'id' } }),
  q('e4a fga model empty', 'POST', '/v1/fga/stores/{{e4as}}/authorization-models', { body: {} }),
  q('e4a fga model bad dsl', 'POST', '/v1/fga/stores/{{e4as}}/authorization-models', { body: { dsl: 'type doc\n  relations\n    define viewer: editor' } }),
  q('e4a fga model', 'POST', '/v1/fga/stores/{{e4as}}/authorization-models', { body: { dsl: DSL }, capture: { e4am: 'id' } }),
  q('e4a fga models', 'GET', '/v1/fga/stores/{{e4as}}/authorization-models'),
  q('e4a fga model read', 'GET', '/v1/fga/stores/{{e4as}}/authorization-models/{{e4am}}'),
  q('e4a fga model unknown', 'GET', '/v1/fga/stores/{{e4as}}/authorization-models/fgm_unknown_{{rand}}'),
  q('e4a fga write', 'POST', '/v1/fga/stores/{{e4as}}/write', { body: { writes: [{ user: 'user:{{e4au}}', relation: 'viewer', object: 'folder:f1' }, { user: 'folder:f1', relation: 'parent', object: 'doc:d1' }, { user: 'user:{{e4au}}', relation: 'blocked', object: 'doc:d2' }, { user: 'user:{{e4au}}', relation: 'editor', object: 'doc:d2' }] } }),
  q('e4a fga write wrong type', 'POST', '/v1/fga/stores/{{e4as}}/write', { body: { writes: [{ user: 'folder:f1', relation: 'editor', object: 'doc:d1' }] } }),
  q('e4a fga batch', 'POST', '/v1/fga/stores/{{e4as}}/batch-check', { body: { checks: [{ user: 'user:{{e4au}}', relation: 'can_view', object: 'doc:d1', correlation_id: 'a' }, { user: 'user:{{e4au}}', relation: 'can_view', object: 'doc:d2', correlation_id: 'b' }] }, tolerate: ['consistency_token'] }),
  q('e4a fga batch empty', 'POST', '/v1/fga/stores/{{e4as}}/batch-check', { body: { checks: [] } }),
  q('e4a fga list objects', 'POST', '/v1/fga/stores/{{e4as}}/list-objects', { body: { user: 'user:{{e4au}}', relation: 'viewer', type: 'doc' }, tolerate: ['consistency_token', 'next_cursor'] }),
  q('e4a fga list objects invalid', 'POST', '/v1/fga/stores/{{e4as}}/list-objects', { body: { user: 'user:{{e4au}}' } }),
  q('e4a fga expand', 'POST', '/v1/fga/stores/{{e4as}}/expand', { body: { object: 'doc:d1', relation: 'can_view' } }),
  q('e4a fga expand invalid', 'POST', '/v1/fga/stores/{{e4as}}/expand', { body: { object: 'doc:d1' } }),
  q('e4a fga list users', 'POST', '/v1/fga/stores/{{e4as}}/list-users', { body: { object: 'doc:d1', relation: 'viewer', user_filters: [{ type: 'user' }] }, tolerate: ['consistency_token', 'continuation_token'] }),
  // ── Cedar templates and links ──
  q('e4a template', 'POST', '/v1/abac_templates', { body: { name: 'e4a-{{rand}}', source: 'permit (principal == ?principal, action == Action::"read", resource in ?resource) when { context.ip.isInRange(ip("10.0.0.0/8")) };' }, capture: { e4at: 'id' } }),
  q('e4a template bad', 'POST', '/v1/abac_templates', { body: { name: 'e4abad-{{rand}}', source: 'permit (' } }),
  q('e4a templates', 'GET', '/v1/abac_templates'),
  q('e4a template read', 'GET', '/v1/abac_templates/{{e4at}}'),
  q('e4a template unknown', 'GET', '/v1/abac_templates/abt_unknown_{{rand}}'),
  q('e4a template update', 'PATCH', '/v1/abac_templates/{{e4at}}', { body: { description: 'edited' } }),
  q('e4a link missing slot', 'POST', '/v1/abac_policy_links', { body: { template_id: '{{e4at}}', name: 'e4a-bad-{{rand}}', principal: { type: 'User', id: 'u1' } } }),
  q('e4a link', 'POST', '/v1/abac_policy_links', { body: { template_id: '{{e4at}}', name: 'e4a-{{rand}}', principal: { type: 'User', id: 'u1' }, resource: { type: 'Folder', id: 'f1' } }, capture: { e4al: 'id' } }),
  q('e4a links', 'GET', '/v1/abac_policy_links'),
  q('e4a link read', 'GET', '/v1/abac_policy_links/{{e4al}}'),
  q('e4a link update', 'PATCH', '/v1/abac_policy_links/{{e4al}}', { body: { enabled: false } }),
  q('e4a template delete linked', 'DELETE', '/v1/abac_templates/{{e4at}}'),
  q('e4a link delete', 'DELETE', '/v1/abac_policy_links/{{e4al}}'),
  q('e4a template delete', 'DELETE', '/v1/abac_templates/{{e4at}}'),
  // ── access policies: simulation and zone checks ──
  q('e4a access policy', 'POST', '/v1/access_policies', { body: { name: 'e4a-{{rand}}', grants: [{ type: 'block' }], conditions: { countries: ['KP'] } }, capture: { e4ap: 'id' } }),
  q('e4a simulate', 'POST', '/v1/access_policies/simulate', { body: { policy_id: '{{e4ap}}', country: 'KP' } }),
  q('e4a simulate other country', 'POST', '/v1/access_policies/simulate', { body: { policy_id: '{{e4ap}}', country: 'DE' } }),
  q('e4a simulate bad stage', 'POST', '/v1/access_policies/simulate', { body: { stage: 'nope' } }),
  q('e4a simulate unknown policy', 'POST', '/v1/access_policies/simulate', { body: { policy_id: 'apol_unknown_{{rand}}' } }),
  q('e4a zone', 'POST', '/v1/network_zones', { body: { name: 'e4a-{{rand}}', cidrs: ['198.51.100.0/24'] }, capture: { e4az: 'id' } }),
  q('e4a zone check', 'POST', '/v1/network_zones/{{e4az}}/check', { body: { ip: '198.51.100.7' } }),
  q('e4a zone check no ip', 'POST', '/v1/network_zones/{{e4az}}/check', { body: {} }),
  q('e4a zone check unknown', 'POST', '/v1/network_zones/zone_unknown_{{rand}}/check', { body: { ip: '198.51.100.7' } }),
  // ── agent delegation graph ──
  q('e4a machine parent', 'POST', '/v1/machines', { body: { name: 'e4a-parent-{{rand}}' }, capture: { e4mp: 'id' }, group: 'agents', tolerate: ['secret'] }),
  q('e4a machine child', 'POST', '/v1/machines', { body: { name: 'e4a-child-{{rand}}' }, capture: { e4mc: 'id' }, group: 'agents', tolerate: ['secret'] }),
  q('e4a delegation no delegator', 'POST', '/v1/agent_delegations', { body: { child_machine_id: '{{e4mp}}', scopes: ['read'] }, group: 'agents' }),
  q('e4a delegation', 'POST', '/v1/agent_delegations', { body: { child_machine_id: '{{e4mp}}', delegator_user_id: '{{e4au}}', scopes: ['read', 'write'] }, capture: { e4d: 'id' }, group: 'agents' }),
  q('e4a delegation child', 'POST', '/v1/agent_delegations', { body: { child_machine_id: '{{e4mc}}', parent_delegation_id: '{{e4d}}', scopes: ['read'] }, capture: { e4dc: 'id' }, group: 'agents' }),
  q('e4a delegation widening', 'POST', '/v1/agent_delegations', { body: { child_machine_id: '{{e4mc}}', parent_delegation_id: '{{e4d}}', scopes: ['admin'] }, group: 'agents' }),
  q('e4a delegations', 'GET', '/v1/agent_delegations', { group: 'agents' }),
  q('e4a delegation read', 'GET', '/v1/agent_delegations/{{e4d}}', { group: 'agents' }),
  q('e4a delegation unknown', 'GET', '/v1/agent_delegations/dlg_unknown_{{rand}}', { group: 'agents' }),
  q('e4a delegation graph', 'GET', '/v1/agent_delegations/{{e4d}}/graph', { group: 'agents' }),
  q('e4a delegation evaluate', 'POST', '/v1/agent_delegations/{{e4d}}/evaluate', { body: {}, group: 'agents', tolerate: ['posture'] }),
  q('e4a delegation revoke child', 'POST', '/v1/agent_delegations/{{e4dc}}/revoke', { body: { reason: 'parity' }, group: 'agents' }),
  q('e4a delegation revoke user', 'POST', '/v1/agent_delegations/revoke_for_user', { body: { user_id: '{{e4au}}' }, group: 'agents' }),
  q('e4a delegation revoke user missing', 'POST', '/v1/agent_delegations/revoke_for_user', { body: {}, group: 'agents' }),
  q('e4a delegation revoke', 'POST', '/v1/agent_delegations/{{e4d}}/revoke', { body: {}, group: 'agents' }),
];

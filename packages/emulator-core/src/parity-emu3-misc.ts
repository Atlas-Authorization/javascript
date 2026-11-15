import type { ParityRequest } from './parity';

/**
 * Parity requests for the round-three misc routes: Action bindings, organization policy, data-subject requests (with extend and
 * receipt) and the per-user export, connection import, and SCIM Bulk. Each request builds its own users and organizations.
 */
const q = (id: string, method: ParityRequest['method'], path: string, rest: Partial<ParityRequest> = {}): ParityRequest => ({ id, method, path, ...rest });
const asScim = { authorization: 'Bearer {{m3st}}' };
const asUser = { authorization: 'Bearer {{m3jwt}}' };
const SCIM_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const BULK = 'urn:ietf:params:scim:api:messages:2.0:BulkRequest';

export const emu3MiscParityRequests: ParityRequest[] = [
  // ── fixtures ──
  q('m3 user', 'POST', '/v1/users', { body: { email_address: 'm3-{{rand}}@example.com' }, capture: { m3u: 'id' } }),
  q('m3 user 2', 'POST', '/v1/users', { body: { email_address: 'm3b-{{rand}}@example.com' }, capture: { m3u2: 'id' } }),
  q('m3 user 3', 'POST', '/v1/users', { body: { email_address: 'm3c-{{rand}}@example.com' }, capture: { m3u3: 'id' } }),
  q('m3 org', 'POST', '/v1/organizations', { body: { name: 'Misc {{rand}}' }, capture: { m3o: 'id' } }),
  q('m3 session', 'POST', '/v1/sessions', { body: { user_id: '{{m3u}}' }, capture: { m3jwt: 'jwt' }, tolerate: ['jwt', 'refresh_token'] }),
  // ── rate-limit policies and overrides ──
  q('m3 machine', 'POST', '/v1/machines', { body: { name: 'Misc {{rand}}' }, capture: { m3m: 'id' } }),
  q('m3 rl policy', 'POST', '/v1/rate_limit_policies', { body: { name: 'm3-{{rand}}', subject: 'machine', limit: 100, window_seconds: 60, burst: 10 }, capture: { m3p: 'id' }, group: 'rate_limit' }),
  q('m3 rl policies', 'GET', '/v1/rate_limit_policies?subject=machine', { group: 'rate_limit', tolerate: ['data'] }),
  q('m3 rl policy get', 'GET', '/v1/rate_limit_policies/{{m3p}}', { group: 'rate_limit' }),
  q('m3 rl policy patch', 'PATCH', '/v1/rate_limit_policies/{{m3p}}', { body: { limit: 200 }, group: 'rate_limit' }),
  q('m3 rl override set', 'PUT', '/v1/rate_limit_overrides/machine/{{m3m}}', { body: { policy_id: '{{m3p}}', reason: 'parity' }, group: 'rate_limit' }),
  q('m3 rl override get', 'GET', '/v1/rate_limit_overrides/machine/{{m3m}}', { group: 'rate_limit' }),
  q('m3 rl overrides', 'GET', '/v1/rate_limit_overrides?subject_type=machine', { group: 'rate_limit', tolerate: ['data'] }),
  q('m3 rl resolve', 'GET', '/v1/rate_limit_policies/resolve?machine_id={{m3m}}', { group: 'rate_limit' }),
  q('m3 rl override delete', 'DELETE', '/v1/rate_limit_overrides/machine/{{m3m}}', { group: 'rate_limit' }),
  q('m3 rl policy delete', 'DELETE', '/v1/rate_limit_policies/{{m3p}}', { group: 'rate_limit' }),
  // ── Action bindings ──
  q('m3 bindings get', 'GET', '/v1/actions/bindings/pre_token'),
  q('m3 bindings set', 'PUT', '/v1/actions/bindings/pre_token', { body: { action_ids: [] } }),
  // ── organization policy ──
  q('m3 policy get', 'GET', '/v1/organizations/{{m3o}}/policy'),
  q('m3 policy set', 'PATCH', '/v1/organizations/{{m3o}}/policy', { body: { maxSessions: 3 } }),
  q('m3 policy clear', 'PATCH', '/v1/organizations/{{m3o}}/policy', { body: { maxSessions: null } }),
  // ── data-subject requests ──
  q('m3 dsr access', 'POST', '/v1/data_subject_requests', { body: { user_id: '{{m3u2}}', type: 'access' }, capture: { m3d1: 'id' } }),
  q('m3 dsr list', 'GET', '/v1/data_subject_requests?user_id={{m3u2}}', { tolerate: ['data'] }),
  q('m3 dsr get', 'GET', '/v1/data_subject_requests/{{m3d1}}', { tolerate: ['result'] }),
  q('m3 dsr fulfil', 'POST', '/v1/data_subject_requests/{{m3d1}}/fulfill', { tolerate: ['result'] }),
  q('m3 dsr restriction', 'POST', '/v1/data_subject_requests', { body: { user_id: '{{m3u2}}', type: 'restriction' }, capture: { m3d2: 'id' } }),
  q('m3 dsr extend', 'POST', '/v1/data_subject_requests/{{m3d2}}/extend', { body: { due_at: 4102444800000, reason: 'Complex request' } }),
  q('m3 dsr reject', 'POST', '/v1/data_subject_requests/{{m3d2}}/reject', { body: { reason: 'Identity not verified' } }),
  q('m3 dsr erasure', 'POST', '/v1/data_subject_requests', { body: { user_id: '{{m3u3}}', type: 'erasure' }, capture: { m3d3: 'id' } }),
  q('m3 dsr cancel', 'POST', '/v1/data_subject_requests/{{m3d3}}/cancel'),
  q('m3 dsr erasure 2', 'POST', '/v1/data_subject_requests', { body: { user_id: '{{m3u3}}', type: 'erasure' }, capture: { m3d4: 'id' } }),
  q('m3 dsr erasure fulfil', 'POST', '/v1/data_subject_requests/{{m3d4}}/fulfill', { tolerate: ['result'] }),
  q('m3 dsr receipt', 'GET', '/v1/data_subject_requests/{{m3d4}}/receipt', { tolerate: ['receipt', 'claims', 'kid', 'jwks_uri'] }),
  // ── the user's own export ──
  q('m3 export create', 'POST', '/v1/client/me/data_export', { anonymous: true, headers: asUser, capture: { m3x: 'id' } }),
  q('m3 export list', 'GET', '/v1/client/me/data_export', { anonymous: true, headers: asUser }),
  q('m3 export get', 'GET', '/v1/client/me/data_export/{{m3x}}', { anonymous: true, headers: asUser, tolerate: ['result'] }),
  // ── connection import ──
  q('m3 connection import', 'POST', '/v1/connections/import', { body: { dry_run: true, validate: false, connections: [{ provider: 'github', owner: { type: 'user', id: '{{m3u}}' }, external_id: 'gh-{{rand}}', access_token: 'gho_parity_token' }] }, group: 'connections' }),
  // ── SCIM Bulk ──
  q('m3 scim token', 'POST', '/v1/scim_tokens', { body: { organization_id: '{{m3o}}', name: 'misc' }, capture: { m3sid: 'id', m3st: 'token' }, tolerate: ['token', 'prefix'], group: 'scim' }),
  q('m3 scim bulk', 'POST', '/scim/v2/Bulk', { anonymous: true, headers: asScim, body: { schemas: [BULK], Operations: [{ method: 'POST', bulkId: 'u1', path: '/Users', data: { schemas: [SCIM_USER], userName: 'm3-bulk-{{rand}}@example.com', active: true } }] }, tolerate: ['Operations'], group: 'scim' }),
  q('m3 scim token revoke', 'POST', '/v1/scim_tokens/{{m3sid}}/revoke', { group: 'scim' }),
];

import { defaultParityRequests, type ParityRequest } from './parity';
import type { Engine } from './engine';
import { emu3AuthzParityRequests } from './parity-emu3-authz';
import { emu3BillingParityRequests } from './parity-emu3-billing';
import { emu3MessagingParityRequests } from './parity-emu3-messaging';
import { emu3MiscParityRequests } from './parity-emu3-misc';
import { emu3OauthParityRequests } from './parity-emu3-oauth';
import { emu4FederationParityRequests } from './parity-emu4-federation';
import { emu4ComplianceParityRequests } from './parity-emu4-compliance';
import { emu4TrustParityRequests } from './parity-emu4-trust';
import { ndbParityRequests } from './parity-ndb';
import { emu4MessagingParityRequests } from './parity-emu4-messaging';
import { emu4BillingParityRequests } from './parity-emu4-billing';
import { emu4ActionsParityRequests } from './parity-emu4-actions';
import { emu4OauthParityRequests } from './parity-emu4-oauth';
import { emu4AuthzParityRequests } from './parity-emu4-authz';

/**
 * The rest of the parity contract: one or more requests for every other hand-written route (access, webhooks, the change
 * feed, keys, grants and usage, sessions and tokens, the machine device-key flow, agents, the OAuth provider, SCIM, the
 * Passkey API and the round-two routes). Together with `defaultParityRequests` it covers every route the emulator
 * answers by hand: `uncoveredRoutes` proves it, and a test fails when a new hand-written route has no request.
 *
 * Each request is self-contained (its own users and organizations, named with `{{rand}}`) and cleans up after itself.
 * Requests that need a feature switched on in the reference instance carry a `group`; `runParity({ groups })` selects them.
 */
const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const CB = 'https://app.example/callback';

const q = (id: string, method: ParityRequest['method'], path: string, rest: Partial<ParityRequest> = {}): ParityRequest => ({ id, method, path, ...rest });

export const extraParityRequests: ParityRequest[] = [
  // ── fixtures ──
  q('x user', 'POST', '/v1/users', { body: { email_address: 'x-{{rand}}@example.com', first_name: 'Ex', password: 'Correct-horse-9-battery' }, capture: { xu: 'id' } }),
  q('x user 2', 'POST', '/v1/users', { body: { email_address: 'x2-{{rand}}@example.com' }, capture: { xu2: 'id' } }),
  q('x org', 'POST', '/v1/organizations', { body: { name: 'Extra {{rand}}' }, capture: { xo: 'id' } }),
  // ── users and organizations ──
  q('user actions ban', 'POST', '/v1/users/{{xu2}}/ban'),
  q('user actions unban', 'POST', '/v1/users/{{xu2}}/unban'),
  q('user lock', 'POST', '/v1/users/{{xu2}}/lock'),
  q('user unlock', 'POST', '/v1/users/{{xu2}}/unlock'),
  q('user email add', 'POST', '/v1/users/{{xu}}/email_addresses', { body: { email_address: 'x-alt-{{rand}}@example.com' } }),
  q('user memberships', 'GET', '/v1/users/{{xu}}/organization_memberships'),
  q('org update', 'PATCH', '/v1/organizations/{{xo}}', { body: { name: 'Extra renamed {{rand}}' } }),
  q('org metadata', 'PUT', '/v1/organizations/{{xo}}/metadata', { body: { public_metadata: { tier: 'a' } } }),
  q('org member add', 'POST', '/v1/organizations/{{xo}}/memberships', { body: { user_id: '{{xu}}', role: 'org:member' } }),
  q('org member role', 'PATCH', '/v1/organizations/{{xo}}/memberships/{{xu}}', { body: { role: 'org:admin' } }),
  q('org invitation', 'POST', '/v1/organizations/{{xo}}/invitations', { body: { email: 'x-inv-{{rand}}@example.com' } }),
  q('invitations list', 'GET', '/v1/invitations'),
  q('org invitations by email', 'GET', '/v1/organization_invitations?status=pending'),
  q('org list', 'GET', '/v1/organizations?limit=2'),
  q('org member remove', 'DELETE', '/v1/organizations/{{xo}}/memberships/{{xu}}'),
  // ── roles and permissions ──
  q('permission create', 'POST', '/v1/permissions', { body: { key: 'org:x_{{rand}}:read', name: 'Extra read' }, capture: { xp: 'id' } }),
  q('role create', 'POST', '/v1/roles', { body: { key: 'org:x_{{rand}}', name: 'Extra role', permissions: [] }, capture: { xr: 'id' } }),
  q('role update', 'PATCH', '/v1/roles/{{xr}}', { body: { name: 'Extra role 2' } }),
  q('role permissions', 'PUT', '/v1/roles/{{xr}}/permissions', { body: { permissions: ['org:read'] } }),
  q('role delete', 'DELETE', '/v1/roles/{{xr}}'),
  q('permission rename', 'POST', '/v1/permissions/{{xp}}/rename', { body: { key: 'org:x_renamed_{{rand}}:read' }, tolerate: ['key', 'previous_key', 'alias'] }),
  q('alias create', 'POST', '/v1/permission_aliases', { body: { alias: 'org:legacy_read', permission_key: 'org:read' } }),
  q('alias put', 'PUT', '/v1/permission_aliases/org:legacy_read', { body: { permission_key: 'org:read' } }),
  q('alias list', 'GET', '/v1/permission_aliases', { tolerate: ['data', 'next_cursor', 'has_more', 'total_count'] }),
  q('alias delete', 'DELETE', '/v1/permission_aliases/org:legacy_read'),
  q('permission delete', 'DELETE', '/v1/permissions/{{xp}}'),
  // ── webhooks, events and the change feed ──
  q('hook create', 'POST', '/v1/webhook_endpoints', { body: { url: 'https://example.com/hooks/x-{{rand}}', enabled_events: ['user.created'] }, capture: { xh: 'id' }, tolerate: ['secret'] }),
  q('hook list', 'GET', '/v1/webhook_endpoints'),
  q('hook update', 'PATCH', '/v1/webhook_endpoints/{{xh}}', { body: { description: 'x' } }),
  q('hook deliveries', 'GET', '/v1/webhook_endpoints/{{xh}}/deliveries'),
  q('hook rotate', 'POST', '/v1/webhook_endpoints/{{xh}}/rotate_secret', { tolerate: ['secret'] }),
  q('hook reveal', 'POST', '/v1/webhook_endpoints/{{xh}}/reveal_secret', { tolerate: ['secret'] }),
  q('hook redeliver', 'POST', '/v1/webhook_endpoints/{{xh}}/redeliver', { body: { status: 'failed' } }),
  q('hook replay', 'POST', '/v1/webhook_endpoints/{{xh}}/replay', { body: { status: 'failed' } }),
  q('hook test', 'POST', '/v1/webhook_endpoints/{{xh}}/test'),
  q('hook delete', 'DELETE', '/v1/webhook_endpoints/{{xh}}'),
  q('changes snapshot', 'GET', '/v1/changes/snapshot/user?limit=1'),
  q('consumer ack', 'PUT', '/v1/changes/consumers/parity-{{rand}}/ack', { body: { seq: 0 } }),
  q('consumer get', 'GET', '/v1/changes/consumers/parity-{{rand}}'),
  q('consumers list', 'GET', '/v1/changes/consumers', { tolerate: ['data'] }),
  // ── API keys ──
  q('key create', 'POST', '/v1/api_keys', { body: { subject_type: 'user', subject_id: '{{xu}}', name: 'x', scopes: ['read'], expires_in_seconds: 86400 }, capture: { xk: 'id', xks: 'secret' }, tolerate: ['secret'] }),
  q('key list', 'GET', '/v1/api_keys?subject_id={{xu}}'),
  q('key get', 'GET', '/v1/api_keys/{{xk}}'),
  q('key update', 'PATCH', '/v1/api_keys/{{xk}}', { body: { name: 'x2' } }),
  q('key verify', 'POST', '/v1/api_keys/verify', { body: { secret: '{{xks}}' } }),
  q('key token', 'POST', '/v1/api_keys/token', { body: { secret: '{{xks}}' }, tolerate: ['token', 'jti', 'expires_in', 'expires_at', 'issuer'] }),
  q('key revoked list', 'GET', '/v1/api_keys/revoked'),
  q('key dies with', 'POST', '/v1/api_keys', { body: { subject_type: 'user', subject_id: '{{xu}}', dies_with: 'sign_out_everywhere', metadata: { team: 'ops' } }, capture: { xkd: 'id' }, tolerate: ['secret', 'prefix'] }),
  q('key dies with bad', 'POST', '/v1/api_keys', { body: { subject_type: 'user', subject_id: '{{xu}}', dies_with: 'forever' } }),
  q('key dies with revoke', 'DELETE', '/v1/api_keys/{{xkd}}'),
  q('revocations start', 'GET', '/v1/revocations', { tolerate: ['next_cursor'] }),
  q('revocations bad cursor', 'GET', '/v1/revocations?after=evt_x'),
  q('revocations bad kind', 'GET', '/v1/revocations?after=0&kinds=nope'),
  q('machine revoked feed', 'GET', '/v1/machines/revoked', { tolerate: ['data', 'next_cursor'] }),
  q('key posture', 'GET', '/v1/api_keys/posture', { group: 'round2' }),
  q('key callers', 'GET', '/v1/api_keys/{{xk}}/callers', { group: 'round2' }),
  q('key rotate', 'POST', '/v1/api_keys/{{xk}}/rotate', { body: { overlap_seconds: 60 }, capture: { xk2: 'id' }, tolerate: ['secret'], group: 'round2' }),
  q('key rotated revoke', 'DELETE', '/v1/api_keys/{{xk2}}', { group: 'round2' }),
  q('key revoke', 'DELETE', '/v1/api_keys/{{xk}}'),
  // ── machines, grants and usage counters ──
  q('m create', 'POST', '/v1/machines', { body: { name: 'x machine {{rand}}' }, capture: { xm: 'id', xms: 'secret' }, tolerate: ['secret'] }),
  q('m list', 'GET', '/v1/machines?limit=2'),
  q('m update', 'PATCH', '/v1/machines/{{xm}}', { body: { name: 'x machine 2' } }),
  q('m rotate secret', 'POST', '/v1/machines/{{xm}}/rotate_secret', { tolerate: ['secret'] }),
  q('m verify', 'POST', '/v1/m2m_tokens/verify', { body: { token: '{{xms}}' } }),
  q('m verify unknown', 'POST', '/v1/m2m_tokens/verify', { body: { token: 'mk_unknown' } }),
  q('m grant create', 'POST', '/v1/machines/{{xm}}/grants', { body: { resource_server_id: 'rs_parity_{{rand}}', scopes: ['read'], constraints: { counters: { calls: { limit: 5, window: 'day' } } } }, capture: { xg: 'id' } }),
  q('m grants', 'GET', '/v1/machines/{{xm}}/grants'),
  q('m grant update', 'PATCH', '/v1/machines/{{xm}}/grants/{{xg}}', { body: { scopes: ['read', 'write'] } }),
  q('grant consume', 'POST', '/v1/grants/machine/{{xg}}/consume', { body: { counter: 'calls', idempotency_key: 'c-{{rand}}', lease: true, ttl_seconds: 60 }, capture: { xl: 'lease.id' } }),
  q('grant usage', 'GET', '/v1/grants/machine/{{xg}}/usage'),
  q('grant lease release', 'POST', '/v1/grants/machine/{{xg}}/leases/{{xl}}/release', { body: { consumed: 0 } }),
  q('grant consume 2', 'POST', '/v1/grants/machine/{{xg}}/consume', { body: { counter: 'calls', idempotency_key: 'c2-{{rand}}' } }),
  q('grant refund', 'POST', '/v1/grants/machine/{{xg}}/refund', { body: { counter: 'calls', idempotency_key: 'r-{{rand}}', consume_idempotency_key: 'c2-{{rand}}' } }),
  q('m revoke', 'POST', '/v1/machines/{{xm}}/revoke'),
  q('m approve', 'POST', '/v1/machines/{{xm}}/approve'),
  q('m grant delete', 'DELETE', '/v1/machines/{{xm}}/grants/{{xg}}'),
  q('m delete', 'DELETE', '/v1/machines/{{xm}}'),
  // ── sessions, tokens and keys ──
  q('session create', 'POST', '/v1/sessions', { body: { user_id: '{{xu}}' }, capture: { xs: 'id', xjwt: 'jwt', xrt: 'refresh_token' }, tolerate: ['jwt', 'refresh_token'] }),
  q('session list', 'GET', '/v1/sessions?user_id={{xu}}'),
  q('session get', 'GET', '/v1/sessions/{{xs}}'),
  q('session active org clear', 'PUT', '/v1/sessions/{{xs}}/active_organization', { body: { organization_id: null }, tolerate: ['jwt', 'refresh_token'] }),
  q('session events', 'GET', '/v1/sessions/{{xs}}/events', { group: 'round2' }),
  q('token verify', 'POST', '/v1/tokens/verify', { body: { token: '{{xjwt}}' } }),
  q('session refresh', 'POST', '/v1/client/sessions/{{xs}}/tokens', { anonymous: true, body: { refresh_token: '{{xrt}}' }, capture: { xrt2: 'refresh_token' }, tolerate: ['jwt', 'refresh_token'] }),
  q('session refresh replay', 'POST', '/v1/client/sessions/{{xs}}/tokens', { anonymous: true, body: { refresh_token: '{{xrt}}' }, tolerate: ['jwt', 'refresh_token'] }),
  q('session refresh unknown', 'POST', '/v1/client/sessions/{{xs}}/tokens', { anonymous: true, body: { refresh_token: 'rt_unknown' } }),
  q('session template token', 'POST', '/v1/sessions/{{xs}}/tokens/missing_template'),
  q('session revoke', 'POST', '/v1/sessions/{{xs}}/revoke'),
  q('revocations', 'GET', '/v1/sessions/revocations', { group: 'round2' }),
  q('status list', 'GET', '/v1/sessions/revocations/status-list', { group: 'round2', tolerate: ['token'] }),
  q('revoke by filter dry run', 'POST', '/v1/sessions/revoke_by_filter', { body: { user_id: '{{xu}}', dry_run: true }, group: 'round2' }),
  q('revoke by filter', 'POST', '/v1/sessions/revoke_by_filter', { body: { user_id: '{{xu}}' }, capture: { xj: 'id' }, group: 'round2', tolerate: ['status', 'matched', 'revoked', 'completed_at'] }),
  q('revoke jobs', 'GET', '/v1/sessions/revoke_jobs', { group: 'round2' }),
  q('revoke job', 'GET', '/v1/sessions/revoke_jobs/{{xj}}', { group: 'round2', tolerate: ['status', 'matched', 'revoked', 'completed_at'] }),
  q('signing keys', 'GET', '/v1/instance/signing_keys'),
  q('jwks', 'GET', '/.well-known/jwks.json', { anonymous: true, tolerate: ['keys'] }),
  q('discovery', 'GET', '/.well-known/openid-configuration', { anonymous: true, tolerate: ['atlas_emulator', 'atlas_previous_issuers', 'atlas_planned_issuer'] }),
  // ── users bulk and deleted addresses ──
  q('bulk dry run', 'POST', '/v1/users/bulk_actions', { body: { action: 'ban', user_ids: ['{{xu2}}'], dry_run: true }, group: 'round2' }),
  q('bulk ban', 'POST', '/v1/users/bulk_actions', { body: { action: 'unban', user_ids: ['{{xu2}}'] }, capture: { xb: 'id' }, group: 'round2', tolerate: ['status', 'processed', 'succeeded', 'completed_at', 'progress', 'created_by'] }),
  q('bulk list', 'GET', '/v1/users/bulk_actions', { group: 'round2' }),
  q('bulk get', 'GET', '/v1/users/bulk_actions/{{xb}}', { group: 'round2', tolerate: ['status', 'processed', 'succeeded', 'completed_at', 'progress', 'created_by'] }),
  q('bulk cancel', 'POST', '/v1/users/bulk_actions/{{xb}}/cancel', { group: 'round2', tolerate: ['status', 'processed', 'succeeded', 'completed_at', 'progress', 'created_by'] }),
  q('deleted addresses', 'POST', '/v1/users/deleted_addresses', { body: { addresses: ['gone-{{rand}}@example.com'] }, group: 'round2' }),
  q('deleted address check', 'POST', '/v1/users/deleted_addresses/check', { body: { address: 'gone-{{rand}}@example.com' }, group: 'round2' }),
  // ── machine device-key flow ──
  q('enrol token', 'POST', '/v1/machine_enrolment_tokens', { body: { max_uses: 2 }, capture: { xet: 'id', xets: 'secret' }, tolerate: ['secret'], group: 'device' }),
  q('enrol token code', 'POST', '/v1/machine_enrolment_tokens', { body: { format: 'user_code' }, capture: { xetc: 'id' }, tolerate: ['user_code'], group: 'device' }),
  q('enrol tokens list', 'GET', '/v1/machine_enrolment_tokens', { group: 'device' }),
  q('enrol redeem', 'POST', '/v1/machines/redeem', { anonymous: true, body: { enrolment_token: '{{xets}}' }, group: 'device' }),
  q('enrol bad key', 'POST', '/v1/machines/enroll', { anonymous: true, body: { enrolment_token: '{{xets}}', public_key_pem: 'not a key' }, group: 'device' }),
  q('enrol bad token', 'POST', '/v1/machines/enroll', { anonymous: true, body: { enrolment_token: 'met_unknown', public_key_pem: 'x' }, group: 'device' }),
  q('challenge unknown', 'POST', '/v1/machines/challenge', { anonymous: true, body: { machine_id: 'mch_unknown' }, group: 'device' }),
  q('device token unknown', 'POST', '/v1/machines/token', { anonymous: true, body: { machine_id: 'mch_unknown', nonce: 'n', signature: 's' }, group: 'device' }),
  q('enrol token delete', 'DELETE', '/v1/machine_enrolment_tokens/{{xet}}', { group: 'device' }),
  q('enrol token code delete', 'DELETE', '/v1/machine_enrolment_tokens/{{xetc}}', { group: 'device' }),
  // ── agents ──
  q('agent config', 'PUT', '/v1/agent_registration', { body: { enabled: true, allow_anonymous: true, allow_service_auth: true, allow_refresh: true, untrusted_scopes: ['read'], trusted_scopes: ['read', 'write'] }, group: 'agents' }),
  q('agent config get', 'GET', '/v1/agent_registration', { group: 'agents' }),
  q('agent register', 'POST', '/v1/agents/register', { anonymous: true, body: { identity: 'anonymous', name: 'agent {{rand}}' }, capture: { xa: 'id', xas: 'secret' }, tolerate: ['secret'], group: 'agents' }),
  q('agent register refresh', 'POST', '/v1/agents/register', { anonymous: true, body: { identity: 'refresh', agent_id: '{{xa}}', agent_secret: '{{xas}}' }, capture: { xas: 'secret' }, tolerate: ['secret'], group: 'agents' }),
  q('agent token', 'POST', '/v1/agents/token', { anonymous: true, body: { agent_id: '{{xa}}', agent_secret: '{{xas}}' }, tolerate: ['token'], group: 'agents' }),
  q('agent claim code', 'POST', '/v1/agents/claim', { anonymous: true, body: { agent_id: '{{xa}}', agent_secret: '{{xas}}' }, tolerate: ['user_code'], group: 'agents' }),
  q('agent access request', 'POST', '/v1/agents/access_requests', { anonymous: true, body: { agent_id: '{{xa}}', agent_secret: '{{xas}}', kind: 'tool', resource: 'tool:search', scopes: ['read'], constraints: { counters: { calls: { limit: 3, window: 'day' } } } }, capture: { xar: 'id' }, group: 'agents' }),
  q('agent requests', 'GET', '/v1/agent_access_requests?agent_id={{xa}}', { group: 'agents' }),
  q('agent approve', 'POST', '/v1/agent_access_requests/{{xar}}/approve', { body: { expires_in_seconds: 3600 }, group: 'agents' }),
  q('agent grant consume', 'POST', '/v1/grants/agent/{{xar}}/consume', { body: { counter: 'calls', idempotency_key: 'ac-{{rand}}' }, group: 'agents' }),
  q('agent grant usage', 'GET', '/v1/grants/agent/{{xar}}/usage', { group: 'agents' }),
  q('agent deny settled', 'POST', '/v1/agent_access_requests/{{xar}}/deny', { group: 'agents' }),
  q('agents list', 'GET', '/v1/agents', { group: 'agents' }),
  q('agent get', 'GET', '/v1/agents/{{xa}}', { group: 'agents' }),
  q('agent owner', 'PUT', '/v1/agents/{{xa}}/owner', { body: { user_id: '{{xu}}' }, group: 'agents' }),
  q('agent claim backend', 'POST', '/v1/agents/{{xa}}/claim', { body: { user_id: '{{xu}}' }, group: 'agents' }),
  q('agent revoke access', 'POST', '/v1/agents/{{xa}}/revoke_access', { body: { disable: true }, group: 'agents', tolerate: ['revoked_grants'] }),
  // ── OAuth provider ──
  q('oauth client', 'POST', '/v1/oauth_clients', { body: { name: 'Parity app {{rand}}', redirect_uris: [CB], grant_types: ['authorization_code', 'refresh_token', 'client_credentials'], allowed_scopes: ['openid', 'email', 'profile', 'offline_access'] }, capture: { xc: 'client_id', xcs: 'client_secret' }, tolerate: ['client_secret'], group: 'oauth' }),
  q('oauth clients', 'GET', '/v1/oauth_clients', { group: 'oauth' }),
  q('oauth client get', 'GET', '/v1/oauth_clients/{{xc}}', { group: 'oauth' }),
  q('oauth client update', 'PATCH', '/v1/oauth_clients/{{xc}}', { body: { name: 'Parity app renamed {{rand}}' }, group: 'oauth' }),
  q('oauth metadata', 'GET', '/.well-known/oauth-authorization-server', { anonymous: true, group: 'oauth', tolerate: ['atlas_emulator', 'atlas_previous_issuers', 'atlas_planned_issuer'] }),
  q('oauth authorize', 'GET', `/oauth2/authorize?client_id={{xc}}&redirect_uri=${encodeURIComponent(CB)}&response_type=code&scope=openid%20email%20offline_access&state=st1&nonce=n1&code_challenge=${PKCE_CHALLENGE}&code_challenge_method=S256&login_hint={{xu}}`, { anonymous: true, capture: { xcode: 'location#code' }, group: 'oauth' }),
  q('oauth authorize bad client', 'GET', `/oauth2/authorize?client_id=oac_unknown&redirect_uri=${encodeURIComponent(CB)}&response_type=code`, { anonymous: true, group: 'oauth' }),
  q('oauth token', 'POST', '/oauth2/token', { anonymous: true, form: { grant_type: 'authorization_code', code: '{{xcode}}', redirect_uri: CB, client_id: '{{xc}}', client_secret: '{{xcs}}', code_verifier: PKCE_VERIFIER }, capture: { xat: 'access_token', xort: 'refresh_token' }, tolerate: ['access_token', 'refresh_token', 'id_token'], group: 'oauth' }),
  q('oauth token code replay', 'POST', '/oauth2/token', { anonymous: true, form: { grant_type: 'authorization_code', code: '{{xcode}}', redirect_uri: CB, client_id: '{{xc}}', client_secret: '{{xcs}}', code_verifier: PKCE_VERIFIER }, group: 'oauth' }),
  q('oauth token bad grant', 'POST', '/oauth2/token', { anonymous: true, form: { grant_type: 'nonsense', client_id: '{{xc}}', client_secret: '{{xcs}}' }, group: 'oauth' }),
  q('oauth introspect', 'POST', '/oauth2/introspect', { anonymous: true, form: { token: '{{xat}}', client_id: '{{xc}}', client_secret: '{{xcs}}' }, tolerate: ['sub', 'aud', 'iss', 'exp', 'iat', 'jti', 'token_type', 'token_use'], group: 'oauth' }),
  q('oauth userinfo', 'GET', '/oauth2/userinfo', { anonymous: true, headers: { authorization: 'Bearer {{xat}}' }, group: 'oauth' }),
  q('oauth userinfo post', 'POST', '/oauth2/userinfo', { anonymous: true, headers: { authorization: 'Bearer {{xat}}' }, group: 'oauth' }),
  q('oauth refresh', 'POST', '/oauth2/token', { anonymous: true, form: { grant_type: 'refresh_token', refresh_token: '{{xort}}', client_id: '{{xc}}', client_secret: '{{xcs}}' }, capture: { xort2: 'refresh_token' }, tolerate: ['access_token', 'refresh_token', 'id_token'], group: 'oauth' }),
  q('oauth client credentials', 'POST', '/oauth2/token', { anonymous: true, form: { grant_type: 'client_credentials', client_id: '{{xc}}', client_secret: '{{xcs}}' }, capture: { xcc: 'access_token' }, tolerate: ['access_token'], group: 'oauth' }),
  q('oauth token exchange', 'POST', '/oauth2/token', { anonymous: true, form: { grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: '{{xcc}}', subject_token_type: 'urn:ietf:params:oauth:token-type:access_token', client_id: '{{xc}}', client_secret: '{{xcs}}' }, tolerate: ['access_token', 'scope'], group: 'oauth' }),
  q('oauth revoke', 'POST', '/oauth2/revoke', { anonymous: true, form: { token: '{{xort2}}', client_id: '{{xc}}', client_secret: '{{xcs}}' }, group: 'oauth' }),
  q('oauth introspect revoked', 'POST', '/oauth2/introspect', { anonymous: true, form: { token: '{{xort2}}', client_id: '{{xc}}', client_secret: '{{xcs}}' }, group: 'oauth' }),
  q('oauth client rotate', 'POST', '/v1/oauth_clients/{{xc}}/rotate_secret', { tolerate: ['client_secret'], group: 'oauth' }),
  q('oauth client consents', 'GET', '/v1/oauth_clients/{{xc}}/consents', { group: 'oauth' }),
  q('oauth client consents revoke', 'POST', '/v1/oauth_clients/{{xc}}/consents/revoke', { group: 'oauth' }),
  q('oauth client delete', 'DELETE', '/v1/oauth_clients/{{xc}}', { group: 'oauth' }),
  // ── SCIM ──
  q('scim token', 'POST', '/v1/scim_tokens', { body: { organization_id: '{{xo}}', name: 'parity' }, capture: { xst: 'id', xsts: 'token' }, tolerate: ['token', 'prefix'], group: 'scim' }),
  q('scim tokens', 'GET', '/v1/scim_tokens?organization_id={{xo}}', { group: 'scim' }),
  q('scim token update', 'PATCH', '/v1/scim_tokens/{{xst}}', { body: { name: 'parity 2' }, group: 'scim' }),
  q('scim config', 'GET', '/scim/v2/ServiceProviderConfig', { anonymous: true, headers: { authorization: 'Bearer {{xsts}}' }, group: 'scim' }),
  q('scim resource types', 'GET', '/scim/v2/ResourceTypes', { anonymous: true, headers: { authorization: 'Bearer {{xsts}}' }, group: 'scim', tolerate: ['Resources'] }),
  q('scim schemas', 'GET', '/scim/v2/Schemas', { anonymous: true, headers: { authorization: 'Bearer {{xsts}}' }, group: 'scim', tolerate: ['Resources'] }),
  q('scim unauthenticated', 'GET', '/scim/v2/Users', { anonymous: true, group: 'scim' }),
  q('scim user create', 'POST', '/scim/v2/Users', { anonymous: true, headers: { authorization: 'Bearer {{xsts}}' }, body: { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'scim-{{rand}}@example.com', name: { givenName: 'Scim', familyName: 'User' }, active: true }, capture: { xsu: 'id' }, tolerate: ['meta', 'externalId'], group: 'scim' }),
  q('scim user list', 'GET', '/scim/v2/Users?filter=userName%20eq%20%22scim-{{rand}}%40example.com%22', { anonymous: true, headers: { authorization: 'Bearer {{xsts}}' }, tolerate: ['Resources'], group: 'scim' }),
  q('scim user get', 'GET', '/scim/v2/Users/{{xsu}}', { anonymous: true, headers: { authorization: 'Bearer {{xsts}}' }, tolerate: ['meta', 'externalId'], group: 'scim' }),
  q('scim user deactivate', 'PATCH', '/scim/v2/Users/{{xsu}}', { anonymous: true, headers: { authorization: 'Bearer {{xsts}}' }, body: { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }] }, tolerate: ['meta', 'externalId'], group: 'scim' }),
  q('scim user replace', 'PUT', '/scim/v2/Users/{{xsu}}', { anonymous: true, headers: { authorization: 'Bearer {{xsts}}' }, body: { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'scim-{{rand}}@example.com', active: true }, tolerate: ['meta', 'externalId', 'name', 'displayName'], group: 'scim' }),
  q('scim group create', 'POST', '/scim/v2/Groups', { anonymous: true, headers: { authorization: 'Bearer {{xsts}}' }, body: { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'Parity {{rand}}', members: [] }, capture: { xsg: 'id' }, tolerate: ['meta', 'externalId'], group: 'scim' }),
  q('scim groups', 'GET', '/scim/v2/Groups', { anonymous: true, headers: { authorization: 'Bearer {{xsts}}' }, tolerate: ['Resources'], group: 'scim' }),
  q('scim group get', 'GET', '/scim/v2/Groups/{{xsg}}', { anonymous: true, headers: { authorization: 'Bearer {{xsts}}' }, tolerate: ['meta', 'externalId'], group: 'scim' }),
  q('scim group patch', 'PATCH', '/scim/v2/Groups/{{xsg}}', { anonymous: true, headers: { authorization: 'Bearer {{xsts}}' }, body: { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'add', path: 'members', value: [{ value: '{{xsu}}' }] }] }, tolerate: ['meta', 'externalId', 'members'], group: 'scim' }),
  q('scim group delete', 'DELETE', '/scim/v2/Groups/{{xsg}}', { anonymous: true, headers: { authorization: 'Bearer {{xsts}}' }, group: 'scim' }),
  q('scim user delete', 'DELETE', '/scim/v2/Users/{{xsu}}', { anonymous: true, headers: { authorization: 'Bearer {{xsts}}' }, group: 'scim' }),
  q('scim token revoke', 'POST', '/v1/scim_tokens/{{xst}}/revoke', { group: 'scim' }),
  // ── Passkey API (the ceremonies need a real authenticator: parity covers the server-side shapes) ──
  q('passkey register init', 'POST', '/v1/passkey_api/registration/init', { body: { user_id: 'ext-{{rand}}', username: 'ex' }, tolerate: ['options'], group: 'passkeys' }),
  q('passkey register finalize bad', 'POST', '/v1/passkey_api/registration/finalize', { body: { user_id: 'ext-{{rand}}', challenge: 'unknown', attestation_object: 'AA', client_data_json: 'AA' }, group: 'passkeys' }),
  q('passkey login init', 'POST', '/v1/passkey_api/login/init', { body: { user_id: 'ext-{{rand}}' }, tolerate: ['handle', 'options'], group: 'passkeys' }),
  q('passkey login finalize bad', 'POST', '/v1/passkey_api/login/finalize', { body: { handle: 'pkh_unknown', challenge: 'unknown', credential_id: 'AA', authenticator_data: 'AA', client_data_json: 'AA', signature: 'AA' }, group: 'passkeys' }),
  q('passkeys list', 'GET', '/v1/passkey_api/users/ext-{{rand}}/passkeys', { group: 'passkeys' }),
  q('passkey delete unknown', 'DELETE', '/v1/passkey_api/users/ext-{{rand}}/passkeys/pk_unknown', { group: 'passkeys' }),
  q('passkey usage', 'GET', '/v1/passkey_api/usage', { group: 'passkeys' }),
  // ── cleanup ──
  q('x org delete', 'DELETE', '/v1/organizations/{{xo}}'),
  q('x user delete', 'DELETE', '/v1/users/{{xu}}'),
  q('x user 2 delete', 'DELETE', '/v1/users/{{xu2}}'),
];


const P256 = { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' };
const FLOW_CLIENT = { client_id: '{{woc}}', client_secret: '{{wocs}}' };
const asUser = { authorization: 'Bearer {{wjwt}}' };

/** One consent round: push the request (forcing the consent screen), then stop at the consent page the authorize call redirects to. */
const consentRound = (tag: string, state: string): ParityRequest[] => [
  q(`${tag} par`, 'POST', '/oauth2/par', { anonymous: true, group: 'oauth_flows', form: { ...FLOW_CLIENT, redirect_uri: CB, response_type: 'code', scope: 'openid profile', code_challenge: PKCE_CHALLENGE, code_challenge_method: 'S256', login_hint: '{{wu}}', prompt: 'consent', state }, capture: { [`${tag}ru`]: 'request_uri' } }),
  q(`${tag} authorize`, 'GET', `/oauth2/authorize?client_id={{woc}}&request_uri={{${tag}ru}}`, { anonymous: true, group: 'oauth_flows', capture: { [`${tag}ct`]: 'location#consent_token' } }),
];

/**
 * The routes of the machine federation, OAuth flows, approvals, governance, messaging, billing, hooks, platform and
 * connection work. Requests that need a feature or a catalogue the reference instance may not have carry a `group`.
 */
export const waveParityRequests: ParityRequest[] = [
  // ── fixtures ──
  q('w user', 'POST', '/v1/users', { body: { email_address: 'w-{{rand}}@example.com', first_name: 'Wave', password: 'Correct-horse-9-battery' }, capture: { wu: 'id' } }),
  q('w org', 'POST', '/v1/organizations', { body: { name: 'Wave {{rand}}' }, capture: { wo: 'id' } }),
  q('w member', 'POST', '/v1/organizations/{{wo}}/memberships', { body: { user_id: '{{wu}}', role: 'org:admin' } }),
  q('w machine', 'POST', '/v1/machines', { body: { name: 'wave machine' }, capture: { wm: 'id' }, tolerate: ['secret'] }),
  q('w session', 'POST', '/v1/sessions', { body: { user_id: '{{wu}}' }, capture: { wjwt: 'jwt', wsid: 'id' }, tolerate: ['jwt', 'refresh_token'] }),
  // ── machine federation and token binding ──
  q('trust policy create', 'POST', '/v1/machine_trust_policies', { body: { machine_id: '{{wm}}', name: 'gha-{{rand}}', kind: 'github_actions', audience: 'https://atlas.example', subject_pattern: 'repo:parity-org/repo:*', jwks: { keys: [P256] } }, capture: { wtp: 'id' }, group: 'federation' }),
  q('trust policies', 'GET', '/v1/machine_trust_policies', { group: 'federation' }),
  q('trust policy get', 'GET', '/v1/machine_trust_policies/{{wtp}}', { group: 'federation' }),
  q('trust policy patch', 'PATCH', '/v1/machine_trust_policies/{{wtp}}', { body: { max_ttl_seconds: 300 }, group: 'federation' }),
  q('trust policy test', 'POST', '/v1/machine_trust_policies/{{wtp}}/test', { body: { token: 'a.b.c' }, group: 'federation' }),
  q('federate refused', 'POST', '/v1/machines/federate', { anonymous: true, body: { machine_id: '{{wm}}', token: 'a.b.c' }, group: 'federation' }),
  q('trust policy delete', 'DELETE', '/v1/machine_trust_policies/{{wtp}}', { group: 'federation' }),
  q('machine binding', 'PATCH', '/v1/machines/{{wm}}', { body: { token_binding: 'any' }, group: 'federation' }),
  q('machine unbind', 'PATCH', '/v1/machines/{{wm}}', { body: { token_binding: 'none' }, group: 'federation' }),
  // ── OAuth: consent, PAR, device authorization, CIBA ──
  q('w client', 'POST', '/v1/oauth_clients', { body: { name: 'Wave client {{rand}}', redirect_uris: [CB], grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code', 'urn:openid:params:grant-type:ciba'], token_endpoint_auth_method: 'client_secret_post', require_consent: true }, capture: { woc: 'client_id', wocs: 'client_secret' }, tolerate: ['client_secret'], group: 'oauth_flows' }),
  ...consentRound('ca', 'a'),
  q('consent screen', 'GET', '/oauth2/authorize/consent?consent_token={{cact}}', { anonymous: true, group: 'oauth_flows' }),
  q('consent approve', 'POST', '/oauth2/authorize/consent', { anonymous: true, body: { consent_token: '{{cact}}', decision: 'approve' }, group: 'oauth_flows' }),
  ...consentRound('cb', 'b'),
  q('consent request', 'GET', '/v1/oauth_consent_requests?consent_challenge={{cbct}}', { group: 'oauth_flows' }),
  q('consent accept', 'PUT', '/v1/oauth_consent_requests/accept?consent_challenge={{cbct}}', { body: { remember: false }, group: 'oauth_flows' }),
  ...consentRound('cc', 'c'),
  q('consent reject', 'PUT', '/v1/oauth_consent_requests/reject?consent_challenge={{ccct}}', { body: { error: 'access_denied' }, group: 'oauth_flows' }),
  q('device authorization', 'POST', '/oauth2/device_authorization', { anonymous: true, form: { ...FLOW_CLIENT, scope: 'openid' }, capture: { wdc: 'device_code', wuc: 'user_code' }, tolerate: ['device_code', 'user_code', 'verification_uri', 'verification_uri_complete'], group: 'oauth_flows' }),
  q('device page', 'GET', '/oauth2/device?user_code={{wuc}}', { anonymous: true, group: 'oauth_flows' }),
  q('device verify', 'POST', '/oauth2/device/verify', { anonymous: true, body: { user_code: '{{wuc}}', decision: 'approve', user_id: '{{wu}}' }, group: 'oauth_flows' }),
  q('device token', 'POST', '/oauth2/token', { anonymous: true, form: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: '{{wdc}}', ...FLOW_CLIENT }, tolerate: ['access_token', 'refresh_token', 'id_token', 'scope'], group: 'oauth_flows' }),
  q('ciba start', 'POST', '/oauth2/backchannel_authentication', { anonymous: true, form: { ...FLOW_CLIENT, login_hint: '{{wu}}', scope: 'openid', binding_message: 'Approve 42' }, capture: { wcb: 'auth_req_id' }, tolerate: ['auth_req_id'], group: 'oauth_flows' }),
  q('ciba pending', 'GET', '/v1/client/me/backchannel_requests', { anonymous: true, headers: asUser, capture: { wcid: 'data.0.id' }, group: 'oauth_flows' }),
  q('ciba answer', 'POST', '/v1/client/me/backchannel_requests/{{wcid}}', { anonymous: true, headers: asUser, body: { decision: 'approve' }, group: 'oauth_flows' }),
  q('ciba token', 'POST', '/oauth2/token', { anonymous: true, form: { grant_type: 'urn:openid:params:grant-type:ciba', auth_req_id: '{{wcb}}', ...FLOW_CLIENT }, tolerate: ['access_token', 'refresh_token', 'id_token', 'scope'], group: 'oauth_flows' }),
  q('w client delete', 'DELETE', '/v1/oauth_clients/{{woc}}', { group: 'oauth_flows' }),
  // ── approvals v2 ──
  q('approval create', 'POST', '/v1/approval_requests', { body: { user_id: '{{wu}}', description: 'Wire 100 to Acme', reference: 'ref-{{rand}}', binding: 'bind-{{rand}}' }, capture: { wap: 'id', wapn: 'match_number' }, tolerate: ['match_number'], group: 'approvals' }),
  q('approval user create', 'POST', '/v1/users/{{wu}}/approval_requests', { body: { description: 'Second request' }, capture: { wap2: 'id' }, tolerate: ['match_number'], group: 'approvals' }),
  q('approval list', 'GET', '/v1/approval_requests?status=pending&limit=5', { group: 'approvals' }),
  q('approval devices', 'GET', '/v1/users/{{wu}}/approval_devices', { group: 'approvals' }),
  q('approval device trust unknown', 'POST', '/v1/users/{{wu}}/approval_devices/trust', { body: { kind: 'device_key', ref: 'apk_unknown_{{rand}}' }, group: 'approvals' }),
  q('approval device trust invalid', 'POST', '/v1/users/{{wu}}/approval_devices/trust', { body: { kind: 'nope', ref: 'x' }, group: 'approvals' }),
  q('approval device untrust unknown', 'DELETE', '/v1/users/{{wu}}/approval_devices/atd_unknown_{{rand}}', { group: 'approvals' }),
  q('approval get', 'GET', '/v1/approval_requests/{{wap}}', { group: 'approvals' }),
  q('approval user get', 'GET', '/v1/users/{{wu}}/approval_requests/{{wap2}}', { group: 'approvals' }),
  q('approval user cancel', 'POST', '/v1/users/{{wu}}/approval_requests/{{wap2}}/cancel', { group: 'approvals' }),
  q('approver list', 'GET', '/v1/client/me/approvals', { anonymous: true, headers: asUser, group: 'approvals' }),
  q('approver get', 'GET', '/v1/client/me/approvals/{{wap}}', { anonymous: true, headers: asUser, group: 'approvals' }),
  q('approver decide', 'POST', '/v1/client/me/approvals/{{wap}}/decision', { anonymous: true, headers: asUser, body: { decision: 'approve', number: '{{wapn}}' }, group: 'approvals' }),
  q('approval consume', 'POST', '/v1/approval_requests/{{wap}}/consume', { body: { binding: 'bind-{{rand}}' }, tolerate: ['receipt'], group: 'approvals' }),
  q('approval create 3', 'POST', '/v1/approval_requests', { body: { user_id: '{{wu}}', description: 'Third request' }, capture: { wap3: 'id' }, tolerate: ['match_number'], group: 'approvals' }),
  q('approval cancel', 'POST', '/v1/approval_requests/{{wap3}}/cancel', { group: 'approvals' }),
  q('approval keys', 'GET', '/v1/client/me/approval_keys', { anonymous: true, headers: asUser, group: 'approvals' }),
  q('approval key add', 'POST', '/v1/client/me/approval_keys', { anonymous: true, headers: asUser, body: { public_jwk: P256, label: 'parity' }, capture: { wak: 'id' }, group: 'approvals' }),
  q('approval key delete', 'DELETE', '/v1/client/me/approval_keys/{{wak}}', { anonymous: true, headers: asUser, group: 'approvals' }),
  // ── step-up policies and receipts ──
  q('step-up policy create', 'POST', '/v1/step_up/policies', { body: { name: 'wp-{{rand}}', max_age_seconds: 600 }, capture: { wsp: 'id' }, group: 'governance' }),
  q('step-up policies', 'GET', '/v1/step_up/policies', { group: 'governance' }),
  q('step-up policy get', 'GET', '/v1/step_up/policies/{{wsp}}', { group: 'governance' }),
  q('step-up policy patch', 'PATCH', '/v1/step_up/policies/{{wsp}}', { body: { description: 'parity' }, group: 'governance' }),
  q('step-up assert', 'POST', '/v1/step_up/assert', { body: { token: '{{wjwt}}', policy: 'wp-{{rand}}' }, tolerate: ['receipt', 'receipt_id', 'receipt_expires_at', 'step_up', 'reason'], group: 'governance' }),
  q('step-up policy delete', 'DELETE', '/v1/step_up/policies/{{wsp}}', { group: 'governance' }),
  // ── authz explain, what-if, FGA sync, event feed ──
  q('authz explain', 'POST', '/v1/authz/explain', { body: { subject: { id: '{{wu}}' }, permission: 'org:read' }, tolerate: ['layers', 'deciding'], group: 'governance' }),
  q('authz rbac check', 'POST', '/v1/authz/rbac/check', { body: { subject: { id: '{{wu}}' }, permission: 'org:read' }, tolerate: ['grants', 'rules'], group: 'governance' }),
  q('what-if run', 'POST', '/v1/authz/what_if', { body: { candidate: { rbac: { roles: [{ type: 'org_role', key: 'org:member', add_permissions: ['org:read'] }] } } }, capture: { wwi: 'id' }, tolerate: ['samples', 'window', 'not_evaluated'], group: 'governance' }),
  q('what-if list', 'GET', '/v1/authz/what_if', { group: 'governance' }),
  q('what-if get', 'GET', '/v1/authz/what_if/{{wwi}}', { tolerate: ['samples', 'window', 'not_evaluated'], group: 'governance' }),
  q('what-if delete', 'DELETE', '/v1/authz/what_if/{{wwi}}', { group: 'governance' }),
  q('fga sync status', 'GET', '/v1/fga/sync', { tolerate: ['last_run'], group: 'governance' }),
  q('fga sync off', 'PUT', '/v1/fga/sync', { body: { enabled: false }, tolerate: ['last_run'], group: 'governance' }),
  q('fga sync backfill', 'POST', '/v1/fga/sync/backfill', { body: {}, group: 'governance' }),
  q('fga sync runs', 'GET', '/v1/fga/sync/runs', { group: 'governance' }),
  q('fga sync run', 'GET', '/v1/fga/sync/runs/fsr_unknown', { group: 'governance' }),
  q('fga sync purge', 'POST', '/v1/fga/sync/purge', { body: { confirm: true }, group: 'governance' }),
  q('authz events', 'GET', '/v1/authz/events?after=latest', { tolerate: ['next_after'], group: 'governance' }),
  // ── legal hold ──
  q('legal hold status', 'GET', '/v1/users/{{wu}}/legal_hold', { group: 'governance' }),
  q('legal hold place', 'POST', '/v1/users/{{wu}}/legal_hold', { body: { reason: 'parity case', case_ref: 'case-{{rand}}' }, group: 'governance' }),
  q('legal holds', 'GET', '/v1/legal_holds', { group: 'governance' }),
  q('legal hold release', 'POST', '/v1/users/{{wu}}/legal_hold/release', { body: { reason: 'done' }, group: 'governance' }),
  // ── instance export and import, session export ──
  q('export create', 'POST', '/v1/instance/exports', { body: {}, capture: { wex: 'id' }, tolerate: ['bundle_sha256', 'signature', 'counts'], group: 'governance' }),
  q('exports', 'GET', '/v1/instance/exports', { tolerate: ['bundle_sha256', 'signature', 'counts'], group: 'governance' }),
  q('export get', 'GET', '/v1/instance/exports/{{wex}}', { tolerate: ['bundle_sha256', 'signature', 'counts'], group: 'governance' }),
  q('export bundle', 'GET', '/v1/instance/exports/{{wex}}/bundle', { group: 'governance' }),
  q('export link', 'POST', '/v1/instance/exports/{{wex}}/download_url', { tolerate: ['url', 'expires_at'], group: 'governance' }),
  q('export download refused', 'GET', '/v1/instance/exports/{{wex}}/download?i=x&exp=1&sig=x', { anonymous: true, group: 'governance' }),
  q('export revoke links', 'POST', '/v1/instance/exports/{{wex}}/revoke_links', { tolerate: ['bundle_sha256', 'signature', 'counts'], group: 'governance' }),
  q('import dry run', 'POST', '/v1/instance/imports', { body: { bundle: { version: 1, users: [], organizations: [], memberships: [] }, dry_run: true }, capture: { wim: 'id' }, tolerate: ['counts', 'errors'], group: 'governance' }),
  q('imports', 'GET', '/v1/instance/imports', { tolerate: ['counts', 'errors'], group: 'governance' }),
  q('import get', 'GET', '/v1/instance/imports/{{wim}}', { tolerate: ['counts', 'errors'], group: 'governance' }),
  q('sessions export', 'GET', '/v1/sessions/export', { group: 'governance' }),
  // ── messaging ──
  q('messages', 'GET', '/v1/messages?limit=5', { group: 'messaging' }),
  q('messages summary', 'GET', '/v1/messages/summary', { group: 'messaging' }),
  q('message unknown', 'GET', '/v1/messages/msg_unknown', { group: 'messaging' }),
  q('suppress', 'POST', '/v1/suppressions', { body: { address: 'sup-{{rand}}@example.com', reason: 'manual' }, capture: { wsup: 'data.0.id' }, group: 'messaging' }),
  q('suppressions', 'GET', '/v1/suppressions', { group: 'messaging' }),
  q('suppression get', 'GET', '/v1/suppressions/{{wsup}}', { group: 'messaging' }),
  q('unsuppress', 'DELETE', '/v1/suppressions/{{wsup}}', { group: 'messaging' }),
  q('fallbacks', 'GET', '/v1/messaging_providers/email/fallbacks', { group: 'messaging' }),
  q('fallback add', 'POST', '/v1/messaging_providers/email/fallbacks', { body: { transport: 'smtp', from_address: 'fallback@example.com' }, capture: { wfb: 'id' }, group: 'messaging' }),
  q('fallback order', 'PUT', '/v1/messaging_providers/email/fallbacks/order', { body: { ids: ['{{wfb}}'] }, group: 'messaging' }),
  q('fallback update', 'PUT', '/v1/messaging_providers/email/fallbacks/{{wfb}}', { body: { status: 'disabled' }, group: 'messaging' }),
  q('fallback delete', 'DELETE', '/v1/messaging_providers/email/fallbacks/{{wfb}}', { group: 'messaging' }),
  q('country routes', 'GET', '/v1/messaging/country_routes', { group: 'messaging' }),
  q('country route set', 'PUT', '/v1/messaging/country_routes', { body: { country: 'DE', provider_id: 'primary' }, group: 'messaging' }),
  q('country route delete', 'DELETE', '/v1/messaging/country_routes/DE', { group: 'messaging' }),
  q('messaging settings', 'GET', '/v1/messaging/settings', { tolerate: ['updated_at'], group: 'messaging' }),
  q('messaging settings set', 'PUT', '/v1/messaging/settings', { body: { auto_suppress: true }, tolerate: ['updated_at'], group: 'messaging' }),
  q('message receivers', 'GET', '/v1/message_receivers', { tolerate: ['data'], group: 'messaging' }),
  q('receiver secret', 'PUT', '/v1/message_receivers/resend/secret', { body: { secret: 'whsec_parity' }, tolerate: ['url', 'events', 'last_event_at', 'last_error', 'channel', 'verification', 'token_required', 'secret_help'], group: 'messaging' }),
  q('receiver secret delete', 'DELETE', '/v1/message_receivers/resend/secret', { group: 'messaging' }),
  // ── billing ──
  q('subscription import', 'POST', '/v1/billing/subscriptions/import', { body: { subject_type: 'user', subject_id: '{{wu}}', plan_id: 'plan_parity', trial_days: 14 }, capture: { wsub: 'id' }, tolerate: ['trial_end'], group: 'billing' }),
  q('subscriptions', 'GET', '/v1/billing/subscriptions', { tolerate: ['trial_end'], group: 'billing' }),
  q('subscription get', 'GET', '/v1/billing/subscriptions/{{wsub}}', { tolerate: ['trial_end'], group: 'billing' }),
  q('trial extend', 'POST', '/v1/billing/subscriptions/{{wsub}}/extend_trial', { body: { days: 7, idempotency_key: 'ext-{{rand}}' }, tolerate: ['trial_end'], group: 'billing' }),
  q('invoices', 'GET', '/v1/billing/invoices?subject_id={{wu}}', { group: 'billing' }),
  q('invoice unknown', 'GET', '/v1/billing/invoices/in_unknown', { group: 'billing' }),
  q('refund unknown', 'POST', '/v1/billing/invoices/in_unknown/refund', { body: { idempotency_key: 'r-{{rand}}' }, group: 'billing' }),
  q('usage report', 'POST', '/v1/billing/usage', { body: { subject_type: 'user', subject_id: '{{wu}}', feature: 'api_calls', quantity: 2, idempotency_key: 'u-{{rand}}' }, tolerate: ['subscription_id'], group: 'billing' }),
  q('usage batch', 'POST', '/v1/billing/usage/batch', { body: { events: [{ subject_type: 'user', subject_id: '{{wu}}', feature: 'api_calls', quantity: 1, idempotency_key: 'b-{{rand}}' }] }, tolerate: ['results'], group: 'billing' }),
  q('usage read-back', 'GET', '/v1/billing/usage?subject_type=user&subject_id={{wu}}&events=true', { tolerate: ['events', 'by_feature'], group: 'billing' }),
  q('entitlement consume', 'POST', '/v1/entitlements/consume', { body: { subject_type: 'user', subject_id: '{{wu}}', feature: 'api_calls', key: 'c-{{rand}}' }, tolerate: ['limit', 'used', 'remaining', 'reason'], group: 'billing' }),
  q('entitlement refund', 'POST', '/v1/entitlements/consume/refund', { body: { subject_type: 'user', subject_id: '{{wu}}', feature: 'api_calls', key: 'c-{{rand}}' }, group: 'billing' }),
  q('coupon create', 'POST', '/v1/billing/coupons', { body: { code: 'C{{rand}}', percent_off: 10, duration: 'once' }, capture: { wcp: 'id' }, group: 'billing' }),
  q('coupon update', 'PATCH', '/v1/billing/coupons/{{wcp}}', { body: { first_time_only: true }, group: 'billing' }),
  // ── hooks: dead letters, action versions, workflow runs, app events ──
  q('w hook', 'POST', '/v1/webhook_endpoints', { body: { url: 'https://example.com/hooks/w-{{rand}}', enabled_events: ['user.created'] }, capture: { whk: 'id' }, tolerate: ['secret'], group: 'workflows' }),
  q('hook dlq', 'GET', '/v1/webhook_endpoints/{{whk}}/dlq', { group: 'workflows' }),
  q('hook dlq ack', 'POST', '/v1/webhook_endpoints/{{whk}}/dlq/ack', { body: { delivery_ids: ['whdl_unknown'] }, group: 'workflows' }),
  q('hook dlq requeue', 'POST', '/v1/webhook_endpoints/{{whk}}/dlq/requeue', { body: { delivery_ids: ['whdl_unknown'] }, group: 'workflows' }),
  q('w hook delete', 'DELETE', '/v1/webhook_endpoints/{{whk}}', { group: 'workflows' }),
  q('w action', 'POST', '/v1/actions', { body: { name: 'wave-{{rand}}', trigger: 'before_user_create', code: 'return {};' }, capture: { wact: 'id' }, group: 'workflows' }),
  q('action version', 'POST', '/v1/actions/{{wact}}/versions', { body: { note: 'first' }, group: 'workflows' }),
  q('action versions', 'GET', '/v1/actions/{{wact}}/versions', { group: 'workflows' }),
  q('action version get', 'GET', '/v1/actions/{{wact}}/versions/1', { group: 'workflows' }),
  q('action rollout abort', 'PATCH', '/v1/actions/{{wact}}/rollout', { body: { percent: 0 }, group: 'workflows' }),
  q('action rollback', 'POST', '/v1/actions/{{wact}}/rollback', { body: {}, group: 'workflows' }),
  q('action update', 'PATCH', '/v1/actions/{{wact}}', { body: { description: 'parity', egress_allowlist: ['api.example.com'] }, tolerate: ['live_version', 'staged'], group: 'workflows' }),
  q('w workflow', 'POST', '/v1/workflows', { body: { name: 'wave-{{rand}}', trigger: { type: 'manual' }, steps: [{ id: 'a', type: 'set_variable', name: 'x', value: 1 }, { id: 'ok', type: 'approval' }] }, capture: { wwf: 'id' }, group: 'workflows' }),
  q('workflow run', 'POST', '/v1/workflows/{{wwf}}/run', { body: {}, capture: { wrun: 'id' }, tolerate: ['steps', 'vars', 'input'], group: 'workflows' }),
  q('workflow runs', 'GET', '/v1/workflows/{{wwf}}/runs', { tolerate: ['steps', 'vars', 'input'], group: 'workflows' }),
  q('workflow run get', 'GET', '/v1/workflows/{{wwf}}/runs/{{wrun}}', { tolerate: ['steps', 'vars', 'input'], group: 'workflows' }),
  q('workflow run cancel', 'POST', '/v1/workflows/{{wwf}}/runs/{{wrun}}/cancel', { tolerate: ['steps', 'vars', 'input'], group: 'workflows' }),
  q('workflow run retry', 'POST', '/v1/workflows/{{wwf}}/runs/{{wrun}}/retry', { body: { from_step: 'a' }, tolerate: ['steps', 'vars', 'input'], group: 'workflows' }),
  q('workflow run resume', 'POST', '/v1/workflows/{{wwf}}/runs/{{wrun}}/resume', { tolerate: ['steps', 'vars', 'input'], group: 'workflows' }),
  q('app event', 'POST', '/v1/app_events', { body: { type: 'wave.thing', organization_id: '{{wo}}', data: { a: 1 }, idempotency_key: 'ev-{{rand}}' }, capture: { wev: 'id' }, tolerate: ['data'], group: 'workflows' }),
  q('app event broadcast', 'POST', '/v1/app_events', { body: { type: 'wave.thing', organization_id: '*', data: { a: 1 } }, tolerate: ['events'], group: 'workflows' }),
  q('app events', 'GET', '/v1/app_events', { tolerate: ['data'], group: 'workflows' }),
  q('app event get', 'GET', '/v1/app_events/{{wev}}', { tolerate: ['data'], group: 'workflows' }),
  // ── platform: write budget, deprecations, path mount, page templates, journeys ──
  q('write budget', 'GET', '/v1/instance/write_budget', { tolerate: ['budgets', 'exceeded_in_window'], group: 'platform' }),
  q('write budget set', 'PUT', '/v1/instance/write_budget', { body: { mode: 'observe' }, tolerate: ['budgets', 'exceeded_in_window'], group: 'platform' }),
  q('write budget reset', 'DELETE', '/v1/instance/write_budget', { tolerate: ['budgets', 'exceeded_in_window'], group: 'platform' }),
  q('domain create', 'POST', '/v1/domains', { body: { hostname: 'parity-{{rand}}.example.com', method: 'path', base_path: '/atlas' }, capture: { xd: 'id' }, tolerate: ['id', 'host', 'verification'], group: 'platform' }),
  q('domain list', 'GET', '/v1/domains', { tolerate: ['data'], group: 'platform' }),
  q('domain get', 'GET', '/v1/domains/{{xd}}', { tolerate: ['id', 'host', 'verification'], group: 'platform' }),
  q('domain verification rotate', 'POST', '/v1/domains/{{xd}}/verification/rotate', { tolerate: ['id', 'host', 'verification'], group: 'platform' }),
  q('domain delete', 'DELETE', '/v1/domains/{{xd}}', { tolerate: ['id'], group: 'platform' }),
  q('deprecations', 'GET', '/v1/deprecations', { anonymous: true, tolerate: ['data'], group: 'platform' }),
  q('instance deprecations', 'GET', '/v1/instance/deprecations', { tolerate: ['data', 'in_use'], group: 'platform' }),
  q('path mount probe', 'GET', '/v1/path_mount/probe', { anonymous: true, group: 'platform' }),
  q('page templates', 'GET', '/v1/instance/page_templates', { tolerate: ['data'], group: 'platform' }),
  q('page template get', 'GET', '/v1/instance/page_templates/sign-in', { tolerate: ['draft', 'live', 'scope'], group: 'platform' }),
  q('page template put', 'PUT', '/v1/instance/page_templates/sign-in?locale=fr', { body: { definition: { version: 1, regions: { header: [{ type: 'heading', text: 'Bonjour' }] } } }, tolerate: ['draft', 'live', 'scope'], group: 'platform' }),
  q('page template preview', 'POST', '/v1/instance/page_templates/sign-in/preview?locale=fr', { tolerate: ['url', 'expires_at'], group: 'platform' }),
  q('page template promote', 'POST', '/v1/instance/page_templates/sign-in/promote?locale=fr', { tolerate: ['draft', 'live', 'scope'], group: 'platform' }),
  q('page template delete', 'DELETE', '/v1/instance/page_templates/sign-in?locale=fr&status=live', { group: 'platform' }),
  q('w flow', 'POST', '/v1/flows', { body: { name: 'wave-{{rand}}', definition: { steps: [{ id: 'profile', type: 'form', on: ['sign_up'] }] } }, capture: { wfl: 'id' }, tolerate: ['definition'], group: 'platform' }),
  q('flow runs', 'GET', '/v1/flows/{{wfl}}/runs', { group: 'platform' }),
  q('user journeys', 'GET', '/v1/users/{{wu}}/journeys', { group: 'platform' }),
  q('my journeys', 'GET', '/v1/client/me/journeys', { anonymous: true, headers: asUser, group: 'platform' }),
  q('user journeys reset', 'DELETE', '/v1/users/{{wu}}/journeys', { group: 'platform' }),
  // ── connections: activity, provider events, reconnect ──
  q('w connection', 'POST', '/v1/connections', { body: { owner: { type: 'user', id: '{{wu}}' }, kind: 'oauth', provider: 'github', name: 'wave', allowed_hosts: ['api.github.com'] }, capture: { wc: 'id' }, group: 'connections' }),
  q('connection activity', 'GET', '/v1/connections/{{wc}}/activity', { group: 'connections' }),
  q('connection relay', 'POST', '/v1/connections/{{wc}}/relay', { body: { url: 'https://api.github.com/user' }, group: 'connections' }),
  q('provider event', 'POST', '/v1/connection_provider_events/ins_emulator/github', { anonymous: true, body: { connection_id: '{{wc}}', topic: 'push', payload: { n: 1 } }, capture: { wpe: 'id' }, group: 'connections' }),
  q('provider events', 'GET', '/v1/connections/{{wc}}/provider_events', { group: 'connections' }),
  q('provider event get', 'GET', '/v1/connections/{{wc}}/provider_events/{{wpe}}', { tolerate: ['payload'], group: 'connections' }),
  q('provider event replay', 'POST', '/v1/connections/{{wc}}/provider_events/{{wpe}}/replay', { group: 'connections' }),
  q('provider event log', 'GET', '/v1/connection_provider_event_log', { group: 'connections' }),
  q('reconnect settings', 'GET', '/v1/connection_reconnect_settings', { group: 'connections' }),
  q('reconnect settings set', 'PUT', '/v1/connection_reconnect_settings', { body: { enabled: true, link_ttl_hours: 24 }, group: 'connections' }),
  q('reconnect link', 'POST', '/v1/connections/{{wc}}/reconnect_link', { body: {}, tolerate: ['url', 'expires_at'], group: 'connections' }),
  q('reconnect page refused', 'GET', '/v1/connection_reconnect/x', { anonymous: true, group: 'connections' }),
  q('reconnect start refused', 'GET', '/v1/connection_reconnect/x/start', { anonymous: true, group: 'connections' }),
  q('reconnect done', 'GET', '/v1/connection_reconnect_done', { anonymous: true, group: 'connections' }),
  q('token exchange', 'POST', '/v1/connections/{{wc}}/token/exchange', { body: {}, group: 'connections' }),
];

/** Every request: the first-round list, then the rest. */
export const fullParityRequests: ParityRequest[] = [...defaultParityRequests, ...extraParityRequests, ...waveParityRequests, ...emu3AuthzParityRequests, ...emu3BillingParityRequests, ...emu3MessagingParityRequests, ...emu3MiscParityRequests, ...emu3OauthParityRequests, ...emu4AuthzParityRequests, ...emu4OauthParityRequests, ...emu4ActionsParityRequests, ...emu4BillingParityRequests, ...emu4MessagingParityRequests, ...emu4TrustParityRequests, ...emu4ComplianceParityRequests, ...emu4FederationParityRequests, ...ndbParityRequests];

/** Hand-written routes parity deliberately does not send to a real instance, each with the reason. */
export const PARITY_EXEMPT: Record<string, string> = {
  'GET /v1/revocations/stream': 'a real instance holds the connection open until it is closed; the long poll at GET /v1/revocations answers the same frames and is covered',
  'POST /v1/instance/signing_keys/rotate': 'rotating the signing key of the reference instance would invalidate its live tokens; the shape is covered by the key list',
};

/** Routes the emulator answers by hand that no parity request exercises, as `METHOD /pattern` (`/__emulator` routes are the engine's own surface and do not exist on a real instance). */
export function uncoveredRoutes(engine: Engine, requests: ParityRequest[] = fullParityRequests): string[] {
  const concrete = requests.map((r) => ({ method: r.method, path: r.path.split('?')[0]!.replace(/\{\{\w+\}\}/g, 'x') }));
  const out: string[] = [];
  for (const route of engine.handwritten()) {
    if (route.pattern.startsWith('/__emulator') || PARITY_EXEMPT[`${route.method} ${route.pattern}`]) continue;
    // The `/scim/v2/d/:directoryId` alias is the same handler set as `/scim/v2`.
    if (route.pattern.startsWith('/scim/v2/d/')) continue;
    const re = new RegExp(`^${route.pattern.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}/?$`);
    if (!concrete.some((c) => c.method === route.method && re.test(c.path))) out.push(`${route.method} ${route.pattern}`);
  }
  return out;
}

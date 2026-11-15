import type { ParityRequest } from './parity';

/**
 * Parity requests for the round-four Actions and connection-depth routes: the Action dry run, the typed connection action
 * catalog and runs (dry run only: a real run would call the provider), the provider change radar, connection access rules and
 * dynamic client registration (refused: the endpoint is a placeholder, which both sides answer the same way).
 */
const q = (id: string, method: ParityRequest['method'], path: string, rest: Partial<ParityRequest> = {}): ParityRequest => ({ id, method, path, ...rest });

export const emu4ActionsParityRequests: ParityRequest[] = [
  // ── fixtures ──
  q('a4 user', 'POST', '/v1/users', { body: { email_address: 'a4-{{rand}}@example.com' }, capture: { a4u: 'id' } }),
  q('a4 action', 'POST', '/v1/actions', { body: { name: 'a4-{{rand}}', trigger: 'pre_token', code: "api.accessToken.setCustomClaim('tier', 'gold');", enabled: true }, capture: { a4a: 'id' } }),
  q('a4 connection', 'POST', '/v1/connections', { body: { owner: { type: 'user', id: '{{a4u}}' }, kind: 'oauth', provider: 'github', name: 'a4', allowed_hosts: ['api.github.com'] }, capture: { a4c: 'id' }, group: 'connections' }),
  // ── Action dry run ──
  q('a4 action test', 'POST', '/v1/actions/{{a4a}}/test', { body: { event: { context: { tokenType: 'machine' } } }, group: 'actions' }),
  // ── typed catalog ──
  q('a4 catalog', 'GET', '/v1/connection_actions?provider=github', { group: 'connections', tolerate: ['data'] }),
  q('a4 catalog types', 'GET', '/v1/connection_actions/types?provider=github', { group: 'connections' }),
  q('a4 catalog get', 'GET', '/v1/connection_actions/github/list_issues', { group: 'connections' }),
  q('a4 catalog put', 'PUT', '/v1/connection_actions/acme_a4/ping', { body: { description: 'Ping.', request: { method: 'GET', base_url: 'https://api.example.com', path: '/ping' } }, group: 'connections' }),
  q('a4 catalog delete', 'DELETE', '/v1/connection_actions/acme_a4/ping', { group: 'connections' }),
  q('a4 connection actions', 'GET', '/v1/connections/{{a4c}}/actions', { group: 'connections', tolerate: ['data'] }),
  q('a4 connection action run', 'POST', '/v1/connections/{{a4c}}/actions/list_issues', { body: { input: { owner: 'octo', repo: 'hello' }, dry_run: true }, group: 'connections', tolerate: ['dry_run.headers'] }),
  // ── provider change radar ──
  q('a4 changes', 'GET', '/v1/connection_provider_changes?status=all', { group: 'connections', tolerate: ['data'] }),
  q('a4 change get', 'GET', '/v1/connection_provider_changes/cpc_missing', { group: 'connections' }),
  q('a4 change acknowledge', 'POST', '/v1/connection_provider_changes/cpc_missing/acknowledge', { group: 'connections' }),
  q('a4 change resolve', 'POST', '/v1/connection_provider_changes/cpc_missing/resolve', { group: 'connections' }),
  // ── access rules ──
  q('a4 rules get', 'GET', '/v1/connections/{{a4c}}/access_rules', { group: 'connections' }),
  q('a4 rules put', 'PUT', '/v1/connections/{{a4c}}/access_rules', { body: { rules: [{ principal_type: 'user', principal_id: '{{a4u}}', permissions: ['relay', 'run_actions'] }] }, group: 'connections' }),
  q('a4 rules delete', 'DELETE', '/v1/connections/{{a4c}}/access_rules', { group: 'connections' }),
  // ── dynamic client registration and the public key ──
  q('a4 register refused', 'POST', '/v1/connections/oauth_clients/register', { body: { provider: 'acme', registration_endpoint: 'http://registrar.example/register' }, group: 'connections' }),
  q('a4 client jwks', 'GET', '/v1/connection_client_jwks/ins_missing/oac_missing', { anonymous: true, group: 'connections' }),
  // ── per-owner OAuth clients ──
  q('a4 client set', 'PUT', '/v1/connections/oauth_clients', { body: { owner: { type: 'user', id: '{{a4u}}' }, provider: 'github', client_id: 'parity-{{rand}}', client_secret: 'parity-secret' }, capture: { a4oc: 'id' }, group: 'connections' }),
  q('a4 clients list', 'GET', '/v1/connections/oauth_clients?provider=github', { group: 'connections', tolerate: ['data'] }),
  q('a4 client delete', 'DELETE', '/v1/connections/oauth_clients/{{a4oc}}', { group: 'connections' }),
];

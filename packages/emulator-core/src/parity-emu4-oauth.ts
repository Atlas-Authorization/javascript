import type { ParityRequest } from './parity';

/**
 * Parity requests for the round-four OAuth routes: the signing-key set (staging, cancel, policy) and its rotation schedule,
 * the back-channel logout delivery log and test send, and verified publishers. Rotation and schedules change the reference
 * instance's live keys, so they carry the `oauth_keys` group; the delivery routes need a receiver URL and carry
 * `oauth_delivery`; publishers carry `oauth_publishers`. A publisher cannot verify on the reference side (no DNS record), so
 * the attach request is a refusal both sides answer the same way.
 */
const q = (id: string, method: ParityRequest['method'], path: string, rest: Partial<ParityRequest> = {}): ParityRequest => ({ id, method, path, ...rest });
const KEYS = { group: 'oauth_keys' };
const PUB_TOLERATE = ['id', 'verified_at', 'last_checked_at', 'record_value', 'client_ids', 'created_at', 'updated_at'];
const CLIENT_TOLERATE = ['id', 'client_id', 'client_secret', 'created_at', 'updated_at', 'registration_access_token', 'registration_client_uri'];

export const emu4OauthParityRequests: ParityRequest[] = [
  // ── signing keys: staged rotation, policy, schedule ──
  q('o4 keys list', 'GET', '/v1/instance/signing_keys', { ...KEYS, tolerate: ['data'] }),
  q('o4 key stage', 'POST', '/v1/instance/signing_keys/rotate', { ...KEYS, body: { staged: true, alg: 'ES384' }, capture: { o4stage: 'kid' }, tolerate: ['kid', 'previous_kid', 'previous_retires_at', 'activates_at'] }),
  q('o4 key stage twice', 'POST', '/v1/instance/signing_keys/rotate', { ...KEYS, body: { staged: true } }),
  q('o4 key cancel', 'DELETE', '/v1/instance/signing_keys/next', { ...KEYS, tolerate: ['kid'] }),
  q('o4 key cancel none', 'DELETE', '/v1/instance/signing_keys/next', KEYS),
  q('o4 key bad alg', 'POST', '/v1/instance/signing_keys/rotate', { ...KEYS, body: { alg: 'HS256' } }),
  q('o4 policy get', 'GET', '/v1/instance/signing_key_policy', KEYS),
  q('o4 policy set', 'PATCH', '/v1/instance/signing_key_policy', { ...KEYS, body: { prepublish_days: 7 } }),
  q('o4 policy bad', 'PATCH', '/v1/instance/signing_key_policy', { ...KEYS, body: { prepublish_days: 400 } }),
  q('o4 policy off', 'PATCH', '/v1/instance/signing_key_policy', { ...KEYS, body: { prepublish_days: null } }),
  q('o4 schedule none', 'GET', '/v1/instance/signing_key_schedule', { ...KEYS, tolerate: ['next_rotation_at', 'last_rotated_at', 'effective_grace_seconds'] }),
  q('o4 schedule bad', 'PUT', '/v1/instance/signing_key_schedule', { ...KEYS, body: { interval_days: 0 } }),
  q('o4 schedule short', 'PUT', '/v1/instance/signing_key_schedule', { ...KEYS, body: { interval_days: 1, prepublish_hours: 24 } }),
  q('o4 schedule set', 'PUT', '/v1/instance/signing_key_schedule', { ...KEYS, body: { interval_days: 30, alg: 'EdDSA', prepublish_hours: 24 }, tolerate: ['next_rotation_at', 'last_rotated_at', 'effective_grace_seconds'] }),
  q('o4 schedule delete', 'DELETE', '/v1/instance/signing_key_schedule', KEYS),
  q('o4 schedule delete none', 'DELETE', '/v1/instance/signing_key_schedule', KEYS),
  // ── back-channel logout deliveries ──
  q('o4 client', 'POST', '/v1/oauth_clients', { group: 'oauth_delivery', body: { name: 'Delivery {{rand}}', redirect_uris: ['https://app.example/callback'], backchannel_logout_uri: 'https://rp.invalid/logout' }, capture: { o4c: 'id' }, tolerate: CLIENT_TOLERATE }),
  q('o4 deliveries', 'GET', '/v1/oauth_clients/{{o4c}}/backchannel_deliveries', { group: 'oauth_delivery', tolerate: ['data'] }),
  q('o4 deliveries missing', 'GET', '/v1/oauth_clients/oac_unknown/backchannel_deliveries', { group: 'oauth_delivery' }),
  q('o4 logout test', 'POST', '/v1/oauth_clients/{{o4c}}/backchannel_logout/test', { group: 'oauth_delivery', tolerate: ['delivery_id', 'sid', 'status', 'latency_ms', 'error', 'location', 'blocked_reason', 'body_excerpt'] }),
  q('o4 logout test missing', 'POST', '/v1/oauth_clients/oac_unknown/backchannel_logout/test', { group: 'oauth_delivery' }),
  q('o4 client private key', 'POST', '/v1/oauth_clients', { group: 'oauth_delivery', body: { name: 'Keyed {{rand}}', redirect_uris: ['https://app.example/callback'], token_endpoint_auth_method: 'private_key_jwt' }, tolerate: CLIENT_TOLERATE }),
  q('o4 client delete', 'DELETE', '/v1/oauth_clients/{{o4c}}', { group: 'oauth_delivery', tolerate: ['id'] }),
  // ── verified publishers ──
  q('o4 pub create', 'POST', '/v1/oauth_publishers', { group: 'oauth_publishers', body: { name: 'Acme {{rand}}', domain: 'p{{rand}}.example.com' }, capture: { o4p: 'id' }, tolerate: PUB_TOLERATE.concat(['record_name']) }),
  q('o4 pub bad domain', 'POST', '/v1/oauth_publishers', { group: 'oauth_publishers', body: { name: 'Acme', domain: 'not a domain' } }),
  q('o4 pub shared early', 'POST', '/v1/oauth_publishers', { group: 'oauth_publishers', body: { name: 'Acme', domain: 'q{{rand}}.example.com', shared_sector: true } }),
  q('o4 pub list', 'GET', '/v1/oauth_publishers', { group: 'oauth_publishers', tolerate: ['data'] }),
  q('o4 pub get', 'GET', '/v1/oauth_publishers/{{o4p}}', { group: 'oauth_publishers', tolerate: PUB_TOLERATE.concat(['record_name']) }),
  q('o4 pub missing', 'GET', '/v1/oauth_publishers/opub_unknown', { group: 'oauth_publishers' }),
  q('o4 pub patch', 'PATCH', '/v1/oauth_publishers/{{o4p}}', { group: 'oauth_publishers', body: { name: 'Acme Renamed', skip_consent: true }, tolerate: PUB_TOLERATE.concat(['record_name']) }),
  q('o4 pub patch sector', 'PATCH', '/v1/oauth_publishers/{{o4p}}', { group: 'oauth_publishers', body: { shared_sector: true } }),
  q('o4 pub verify', 'POST', '/v1/oauth_publishers/{{o4p}}/verify', { group: 'oauth_publishers', tolerate: PUB_TOLERATE.concat(['record_name', 'record_found']) }),
  q('o4 pub attach', 'PUT', '/v1/oauth_publishers/{{o4p}}/clients/client_unknown', { group: 'oauth_publishers', body: {} }),
  q('o4 pub detach', 'DELETE', '/v1/oauth_publishers/{{o4p}}/clients/client_unknown', { group: 'oauth_publishers' }),
  q('o4 pub delete', 'DELETE', '/v1/oauth_publishers/{{o4p}}', { group: 'oauth_publishers', tolerate: ['id'] }),
];

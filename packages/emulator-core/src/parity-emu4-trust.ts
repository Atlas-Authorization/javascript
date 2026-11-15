import type { ParityRequest } from './parity';

/**
 * Parity requests for the round-four trust routes: the audit chain (status, links, checkpoints, verification), one-time capability
 * tickets, the trusted-device list, and the session binding and device-bound session routes. The ones that need the chain switched on
 * or a device remembered use the `trust` group (they run the emulator's own controls first).
 */
const q = (id: string, method: ParityRequest['method'], path: string, rest: Partial<ParityRequest> = {}): ParityRequest => ({ id, method, path, ...rest });
const asUser = { authorization: 'Bearer {{t4jwt}}' };

export const emu4TrustParityRequests: ParityRequest[] = [
  // ── fixtures ──
  q('t4 user', 'POST', '/v1/users', { body: { email_address: 't4-{{rand}}@example.com' }, capture: { t4u: 'id' } }),
  q('t4 session', 'POST', '/v1/sessions', { body: { user_id: '{{t4u}}' }, capture: { t4jwt: 'jwt', t4sid: 'id' }, tolerate: ['jwt', 'refresh_token'] }),
  // ── audit chain ──
  q('t4 chain status', 'GET', '/v1/audit/chain', { group: 'trust' }),
  q('t4 chain enable', 'PUT', '/v1/audit/chain', { body: { enabled: true, checkpoint_interval_seconds: 60 }, group: 'trust' }),
  q('t4 chain write', 'POST', '/v1/users', { body: { email_address: 't4b-{{rand}}@example.com' }, group: 'trust' }),
  q('t4 chain sweep', 'POST', '/__emulator/audit_chain/sweep', { body: { settle: false }, group: 'trust', tolerate: ['appended', 'head_seq'] }),
  q('t4 chain links', 'GET', '/v1/audit/chain/links?limit=5', { group: 'trust' }),
  q('t4 chain checkpoint', 'POST', '/v1/audit/chain/checkpoints', { group: 'trust' }),
  q('t4 chain checkpoints', 'GET', '/v1/audit/chain/checkpoints', { group: 'trust' }),
  q('t4 chain verify', 'POST', '/v1/audit/chain/verify', { body: {}, group: 'trust' }),
  // ── one-time capability tickets ──
  q('t4 ticket', 'POST', '/v1/tickets', { body: { payload: { goto: '/billing' }, ttl_seconds: 300, bound_user: '{{t4u}}' }, capture: { t4tkt: 'ticket' } }),
  q('t4 ticket redeem', 'POST', '/v1/tickets/redeem', { body: { ticket: '{{t4tkt}}', for_user: '{{t4u}}' } }),
  q('t4 ticket again', 'POST', '/v1/tickets', { body: { payload: { goto: '/settings' }, ttl_seconds: 300, bound_user: '{{t4u}}' }, capture: { t4tkt2: 'ticket' } }),
  q('t4 ticket redeem client', 'POST', '/v1/client/tickets/redeem', { body: { ticket: '{{t4tkt2}}' }, headers: asUser }),
  // ── trusted devices ──
  q('t4 device remember', 'POST', '/__emulator/trusted_devices', { body: { user_id: '{{t4u}}', device: { browser: 'Firefox', os: 'macOS' } }, capture: { t4td: 'id' }, group: 'trust' }),
  q('t4 devices', 'GET', '/v1/client/me/trusted_devices', { headers: asUser }),
  q('t4 device revoke', 'DELETE', '/v1/client/me/trusted_devices/{{t4td}}', { headers: asUser, group: 'trust' }),
  q('t4 devices revoke all', 'DELETE', '/v1/client/me/trusted_devices', { headers: asUser }),
  // ── session binding and device-bound sessions ──
  q('t4 binding get', 'GET', '/v1/sessions/{{t4sid}}/binding'),
  q('t4 binding delete', 'DELETE', '/v1/sessions/{{t4sid}}/binding'),
  q('t4 bind', 'POST', '/v1/client/session_binding', { anonymous: true, group: 'trust' }),
  q('t4 dbsc start', 'POST', '/v1/client/dbsc/start', { anonymous: true, group: 'trust' }),
  q('t4 dbsc refresh', 'POST', '/v1/client/dbsc/refresh', { anonymous: true, group: 'trust' }),
];

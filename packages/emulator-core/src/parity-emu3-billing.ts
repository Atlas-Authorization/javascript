import type { ParityRequest } from './parity';

const q = (id: string, method: ParityRequest['method'], path: string, rest: Partial<ParityRequest> = {}): ParityRequest => ({ id, method, path, ...rest });
const asUser = { authorization: 'Bearer {{b3jwt}}' };

/** Plan change, cancel and restore (server and client side), and the entitlement sync: refusals every instance answers alike, plus one period-end cancel. */
export const emu3BillingParityRequests: ParityRequest[] = [
  q('b3 user', 'POST', '/v1/users', { body: { email_address: 'b3-{{rand}}@example.com' }, capture: { b3u: 'id' }, group: 'billing' }),
  q('b3 session', 'POST', '/v1/sessions', { body: { user_id: '{{b3u}}' }, capture: { b3jwt: 'jwt' }, tolerate: ['jwt', 'id'], group: 'billing' }),
  q('b3 subscription', 'POST', '/v1/billing/subscriptions/import', { body: { subject_type: 'user', subject_id: '{{b3u}}', plan_id: 'plan_parity' }, capture: { b3sub: 'id' }, tolerate: ['trial_end'], group: 'billing' }),
  q('b3 change unknown plan', 'POST', '/v1/billing/subscriptions/{{b3sub}}/change', { body: { plan_id: 'plan_unknown_{{rand}}' }, group: 'billing' }),
  q('b3 change unknown field', 'POST', '/v1/billing/subscriptions/{{b3sub}}/change', { body: { plan_id: 'x', plan: 'x' }, group: 'billing' }),
  q('b3 restore not canceling', 'POST', '/v1/billing/subscriptions/{{b3sub}}/restore', { group: 'billing' }),
  q('b3 cancel', 'POST', '/v1/billing/subscriptions/{{b3sub}}/cancel', { body: {}, tolerate: ['canceled_at', 'updated_at'], group: 'billing' }),
  q('b3 cancel again', 'POST', '/v1/billing/subscriptions/{{b3sub}}/cancel', { body: {}, group: 'billing' }),
  q('b3 cancel unknown', 'POST', '/v1/billing/subscriptions/sub_unknown/cancel', { body: {}, group: 'billing' }),
  q('b3 sync unknown plan', 'POST', '/v1/billing/plans/plan_unknown/sync_entitlements', { group: 'billing' }),
  q('b3 client change unknown plan', 'POST', '/v1/client/billing/subscription/change', { anonymous: true, headers: asUser, body: { plan_id: 'plan_unknown_{{rand}}' }, group: 'billing' }),
  q('b3 sync unknown', 'POST', '/v1/billing/subscriptions/sub_unknown/sync', { body: {}, group: 'billing' }),
  q('b3 client checkout sync invalid', 'POST', '/v1/client/billing/checkout/sync', { anonymous: true, headers: asUser, body: {}, group: 'billing' }),
  q('b3 client cancel by id unknown', 'POST', '/v1/client/billing/subscriptions/sub_unknown/cancel', { anonymous: true, headers: asUser, body: {}, group: 'billing' }),
  q('b3 client restore by id unknown', 'POST', '/v1/client/billing/subscriptions/sub_unknown/restore', { anonymous: true, headers: asUser, body: {}, group: 'billing' }),
  q('b3 client change by id unknown', 'POST', '/v1/client/billing/subscriptions/sub_unknown/change', { anonymous: true, headers: asUser, body: { plan_id: 'plan_unknown_{{rand}}' }, group: 'billing' }),
  q('b3 client cancel', 'POST', '/v1/client/billing/subscription/cancel', { anonymous: true, headers: asUser, body: {}, tolerate: ['canceled_at'], group: 'billing' }),
  q('b3 client restore', 'POST', '/v1/client/billing/subscription/restore', { anonymous: true, headers: asUser, body: {}, tolerate: ['canceled_at'], group: 'billing' }),
];

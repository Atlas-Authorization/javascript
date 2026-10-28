import type { Shape } from './shape';

/**
 * The calls Atlas makes to a Referalli-style connection API, and the answer a
 * conforming server gives to each. The cases come from what went wrong when
 * Atlas first ran its adapter against Referalli: nulls rejected as invalid, a
 * bad signature answered 404 (which Atlas reads as "connection paused"), an
 * unknown customer answered 404 on export/erase, risk field names, and a thin
 * `voided` event.
 *
 * Placeholders in a body: `{run}` becomes the run id, so repeated runs against
 * a real server do not collide.
 */

export type CaseSign =
  /** v1 and v2, current time. */
  | 'valid'
  /** Signed with a different secret. */
  | 'wrong_secret'
  /** Signed ten minutes in the past. */
  | 'stale'
  /** v1 only (a server that has switched the connection to v2 may refuse it). */
  | 'v1_only'
  /** No signature header at all. */
  | 'unsigned';

export type CaseOp = 'ping' | 'signups' | 'erase' | 'export' | 'aliases' | 'users' | 'signals' | 'partners';

/**
 * Which wire protocol a case speaks. `connection` is the connection-API
 * dialect (`/v1/auth/connections/{id}/…`, v1+v2 signatures, as Referalli speaks
 * it). `webhook` is the generic Atlas referral protocol any platform can
 * implement (`POST {base}/signups`, an Atlas-webhook-style signature, `op` in the
 * body). Referalli is one preset of the first; Rewardful-, FirstPromoter- or
 * Tolt-style glue speaks the second.
 */
export type CaseProfile = 'connection' | 'webhook';

export interface ConformanceCase {
  /** Default `connection`. */
  profile?: CaseProfile;
  id: string;
  title: string;
  area: 'auth' | 'ping' | 'signup' | 'erase' | 'export' | 'alias' | 'user' | 'signal' | 'errors';
  op: CaseOp;
  method: 'GET' | 'POST';
  body?: Record<string, unknown>;
  query?: Record<string, string>;
  sign: CaseSign;
  /** `unknown`: a connection id that does not exist. */
  connection: 'known' | 'unknown';
  headers?: Record<string, string>;
  /** Send the request twice with the same `x-referalli-id`; the second answer is checked. */
  replay?: boolean;
  expect: {
    /** Any of these statuses passes. */
    status: number[];
    /** The shape of the JSON body (extra keys allowed). */
    json?: Shape;
    /** The structured error `error.code` must be one of these. */
    errorCodes?: string[];
  };
  /** Why the answer matters to Atlas. */
  why: string;
  /** A recommendation rather than a requirement: a miss is reported as a warning. */
  recommended?: boolean;
}

const ERROR_BODY: Shape = { error: { code: 'string', message: 'string', 'request_id?': 'string' } };
const OK = [200, 201];
const SIGNUP_ANSWER: Shape = {
  'referral?': 'object|null',
  'partner?': 'object|null',
  'notes?': 'array',
};

const baseSignup = {
  customerRef: 'conformance_{run}',
  email: 'conformance+{run}@example.com',
  emailHash: 'a'.repeat(64),
  ip: '203.0.113.7',
  ua: 'Mozilla/5.0 (conformance)',
  signedUpAt: '2026-10-21T14:03:11.000Z',
};

export const CONFORMANCE_CASES: readonly ConformanceCase[] = [
  // ── authentication ─────────────────────────────────────────────────────
  {
    id: 'auth.bad_signature_is_401',
    title: 'A signature made with the wrong secret is refused with 401',
    area: 'auth',
    op: 'ping',
    method: 'POST',
    body: {},
    sign: 'wrong_secret',
    connection: 'known',
    expect: { status: [401], json: ERROR_BODY },
    why: 'Atlas reads 401 as "signature rejected" (a rotated secret or clock skew). A 404 here would be read as "connection paused".',
  },
  {
    id: 'auth.unsigned_is_401',
    title: 'A call with no signature is refused with 401',
    area: 'auth',
    op: 'ping',
    method: 'POST',
    body: {},
    sign: 'unsigned',
    connection: 'known',
    expect: { status: [401], json: ERROR_BODY },
    why: 'Same as above: an unsigned call is an authentication failure, not a missing connection.',
  },
  {
    id: 'auth.stale_timestamp_is_401',
    title: 'A signature ten minutes old is refused with 401',
    area: 'auth',
    op: 'ping',
    method: 'POST',
    body: {},
    sign: 'stale',
    connection: 'known',
    expect: { status: [401], json: ERROR_BODY },
    why: 'The timestamp window is 5 minutes either way; a stale call must not be accepted.',
  },
  {
    id: 'auth.unknown_connection_is_404_or_423',
    title: 'An unknown (or paused) connection answers 404 or 423',
    area: 'auth',
    op: 'ping',
    method: 'POST',
    body: {},
    sign: 'valid',
    connection: 'unknown',
    expect: { status: [404, 423], json: ERROR_BODY },
    why: 'Atlas treats 404 and 423 as "connection unknown or paused by the merchant" and stops retrying.',
  },
  {
    id: 'auth.replayed_id_is_409',
    title: 'Reusing a request id is refused with 409 and error.code "replay"',
    area: 'auth',
    op: 'ping',
    method: 'POST',
    body: {},
    sign: 'valid',
    connection: 'known',
    replay: true,
    expect: { status: [409], json: ERROR_BODY, errorCodes: ['replay'] },
    why: 'Every Atlas attempt carries a fresh x-referalli-id; Atlas retries a 409 replay with a new one.',
  },
  {
    id: 'auth.v1_only_is_accepted_or_401',
    title: 'A v1-only signature is accepted, or refused with 401 once the connection requires v2',
    area: 'auth',
    op: 'ping',
    method: 'POST',
    body: {},
    sign: 'v1_only',
    connection: 'known',
    expect: { status: [200, 401] },
    why: 'Atlas always sends v2 as well; this checks an older sender does not get a 5xx or a 404.',
  },
  // ── ping ───────────────────────────────────────────────────────────────
  {
    id: 'ping.ok',
    title: 'A signed ping answers ok with the connection and program',
    area: 'ping',
    op: 'ping',
    method: 'POST',
    body: {},
    sign: 'valid',
    connection: 'known',
    expect: {
      status: [200],
      json: {
        ok: 'boolean',
        'connectionId?': 'string|null',
        'programId?': 'string|null',
        'programName?': 'string|null',
        'orgName?': 'string|null',
        'autoEnrollUsers?': 'boolean|null',
        'serverTime?': 'string|null',
        'capabilities?': 'object|array|null',
      },
    },
    why: 'Powers "Test connection": org, program, clock skew, and the capabilities the platform advertises (for example partners).',
  },
  // ── sign-up ────────────────────────────────────────────────────────────
  {
    id: 'signup.minimal',
    title: 'A sign-up with no referral is accepted',
    area: 'signup',
    op: 'signups',
    method: 'POST',
    body: { ...baseSignup },
    sign: 'valid',
    connection: 'known',
    expect: { status: OK, json: SIGNUP_ANSWER },
    why: 'Most sign-ups carry no referral. They must still be accepted.',
  },
  {
    id: 'signup.with_code',
    title: 'A sign-up with a referral code is accepted (the code need not exist)',
    area: 'signup',
    op: 'signups',
    method: 'POST',
    body: {
      ...baseSignup,
      customerRef: 'conformance_code_{run}',
      referral: { code: 'CONFORMANCE1', consent: 'not_required', capturedAt: '2026-10-21T14:00:00.000Z' },
    },
    sign: 'valid',
    connection: 'known',
    expect: { status: OK, json: SIGNUP_ANSWER },
    why: 'An unknown code is "not referred", not an error.',
  },
  {
    id: 'signup.nulls_are_accepted',
    title: 'Null ip, user agent and name are accepted',
    area: 'signup',
    op: 'signups',
    method: 'POST',
    body: { ...baseSignup, customerRef: 'conformance_nulls_{run}', ip: null, ua: null, name: null },
    sign: 'valid',
    connection: 'known',
    expect: { status: OK, json: SIGNUP_ANSWER },
    why: 'Atlas sends null where it does not know a value (an API sign-up has no browser). A 400 here drops the sign-up.',
  },
  {
    id: 'signup.risk_names',
    title: "Atlas's risk object is accepted as sent",
    area: 'signup',
    op: 'signups',
    method: 'POST',
    body: {
      ...baseSignup,
      customerRef: 'conformance_risk_{run}',
      referral: { code: 'CONFORMANCE1', consent: 'not_required', capturedAt: '2026-10-21T14:00:00.000Z' },
      risk: {
        score: 0.82,
        level: 'high',
        dropped: true,
        disposableEmail: true,
        emailVerified: false,
        selfReferral: false,
        reasons: ['disposable_email', 'velocity'],
      },
    },
    sign: 'valid',
    connection: 'known',
    expect: { status: OK, json: SIGNUP_ANSWER },
    why: 'The risk fields are score (0-1), level, dropped, disposableEmail, emailVerified, selfReferral and reasons.',
  },
  {
    id: 'signup.test_marker',
    title: 'A simulated sign-up (atlas-test: 1) is accepted',
    area: 'signup',
    op: 'signups',
    method: 'POST',
    body: { ...baseSignup, customerRef: 'atlas_test_{run}' },
    headers: { 'atlas-test': '1' },
    sign: 'valid',
    connection: 'known',
    expect: { status: OK, json: SIGNUP_ANSWER },
    why: 'The marker lets the platform skip storing it; the body stays strict, so the marker is a header only.',
  },
  {
    id: 'signup.missing_customer_ref',
    title: 'A sign-up without customerRef is a structured 400 or 422',
    area: 'signup',
    op: 'signups',
    method: 'POST',
    body: { email: 'conformance@example.com', signedUpAt: '2026-10-21T14:03:11.000Z' },
    sign: 'valid',
    connection: 'known',
    expect: { status: [400, 422], json: ERROR_BODY },
    why: 'Atlas records error.code and error.request_id from a structured error body.',
  },
  // ── erase and export ───────────────────────────────────────────────────
  {
    id: 'erase.unknown_customer_is_ok',
    title: 'Erasing a customer the platform does not hold succeeds',
    area: 'erase',
    op: 'erase',
    method: 'POST',
    body: { customerRef: 'conformance_nobody_{run}' },
    sign: 'valid',
    connection: 'known',
    expect: { status: [200, 202, 204] },
    why: 'Erasure is idempotent. A 404 would be read as "connection paused" and retried forever.',
  },
  {
    id: 'export.unknown_customer_is_empty',
    title: 'Exporting a customer the platform does not hold answers 200 with nothing',
    area: 'export',
    op: 'export',
    method: 'GET',
    query: { customerRef: 'conformance_nobody_{run}' },
    sign: 'valid',
    connection: 'known',
    expect: { status: [200], json: 'object|array|null' },
    why: 'An empty export is a valid answer to a data-subject request. A 404 reads as a paused connection.',
  },
  // ── aliases, users, signals ────────────────────────────────────────────
  {
    id: 'alias.unknown_source_is_ok_or_conflict',
    title: 'Re-keying a customer the platform does not hold is accepted, or a structured 409',
    area: 'alias',
    op: 'aliases',
    method: 'POST',
    body: { fromCustomerRef: 'conformance_old_{run}', toCustomerRef: 'conformance_new_{run}' },
    sign: 'valid',
    connection: 'known',
    expect: { status: [200, 201, 204, 409] },
    why: 'A 409 is a permanent conflict (Atlas records alias_conflict and stops); anything else must be a success.',
  },
  {
    id: 'user.update',
    title: 'A user lifecycle update is accepted',
    area: 'user',
    op: 'users',
    method: 'POST',
    body: { customerRef: 'conformance_user_{run}', email: 'conformance+user@example.com', name: null, status: 'active' },
    sign: 'valid',
    connection: 'known',
    expect: { status: [200, 201, 204] },
    why: 'Atlas forwards email, name and suspension changes; name may be null.',
  },
  {
    id: 'signal.email_verified',
    title: 'An email_verified signal answers with the referrals it changed',
    area: 'signal',
    op: 'signals',
    method: 'POST',
    body: {
      customerRef: 'conformance_nobody_{run}',
      signal: 'email_verified',
      at: '2026-10-21T14:05:00.000Z',
      details: {},
    },
    sign: 'valid',
    connection: 'known',
    expect: { status: [200, 202, 204] },
    why: 'The answer may list the referrals the signal changed: {referrals: [{id, status}]}.',
  },
  {
    id: 'signal.unknown_signal_is_400',
    title: 'An unknown signal name is a structured 400 or 422',
    area: 'signal',
    op: 'signals',
    method: 'POST',
    body: { customerRef: 'conformance_nobody_{run}', signal: 'not_a_signal', at: '2026-10-21T14:05:00.000Z', details: {} },
    sign: 'valid',
    connection: 'known',
    expect: { status: [400, 422], json: ERROR_BODY },
    why: 'Atlas only sends signals the platform names (email_verified, banned, unbanned, fraud_confirmed).',
    recommended: true,
  },
];

const W = (c: Omit<ConformanceCase, 'profile' | 'connection' | 'method'> & { method?: 'POST' }): ConformanceCase => ({
  profile: 'webhook',
  connection: 'known',
  method: 'POST',
  ...c,
});

/**
 * The generic webhook-protocol cases: what any platform must answer on its
 * `endpoint_url`, whatever product it is. Every call is a POST whose body names
 * its `op`; the signature covers the id, timestamp and raw body.
 */
export const WEBHOOK_CONFORMANCE_CASES: readonly ConformanceCase[] = [
  W({
    id: 'webhook.bad_signature_is_401',
    title: 'A signature made with the wrong secret is refused with 401',
    area: 'auth',
    op: 'ping',
    body: { op: 'ping', customerRef: 'atlas_connection_test' },
    sign: 'wrong_secret',
    expect: { status: [401, 403] },
    why: 'Atlas stops and alerts on 401/403 (signature rejected); it must not look like an unsupported operation.',
  }),
  W({
    id: 'webhook.unsigned_is_401',
    title: 'A call with no signature is refused',
    area: 'auth',
    op: 'ping',
    body: { op: 'ping', customerRef: 'atlas_connection_test' },
    sign: 'unsigned',
    expect: { status: [401, 403] },
    why: 'An unsigned call is an authentication failure.',
  }),
  W({
    id: 'webhook.stale_timestamp_is_401',
    title: 'A signature ten minutes old is refused',
    area: 'auth',
    op: 'ping',
    body: { op: 'ping', customerRef: 'atlas_connection_test' },
    sign: 'stale',
    expect: { status: [401, 403] },
    why: 'The timestamp window is 5 minutes either way.',
  }),
  W({
    id: 'webhook.ping',
    title: 'ping answers ok, or 404/405/501 when the platform has no ping',
    area: 'ping',
    op: 'ping',
    body: { op: 'ping', customerRef: 'atlas_connection_test' },
    sign: 'valid',
    expect: { status: [200, 404, 405, 501] },
    why: 'No ping means Atlas falls back to the export probe.',
  }),
  W({
    id: 'webhook.signup_minimal',
    title: 'A sign-up with no referral is accepted',
    area: 'signup',
    op: 'signups',
    body: { op: 'signup', customerRef: 'conformance_{run}', emailHash: null, ip: null, ua: null, signedUpAt: '2026-10-21T14:03:11.000Z', programId: null, autoEnroll: false, referral: null },
    sign: 'valid',
    expect: { status: OK, json: SIGNUP_ANSWER },
    why: 'Most sign-ups carry no referral; nulls are normal.',
  }),
  W({
    id: 'webhook.signup_with_code',
    title: 'A sign-up with a referral code is accepted (the code need not exist)',
    area: 'signup',
    op: 'signups',
    body: {
      op: 'signup',
      customerRef: 'conformance_code_{run}',
      emailHash: 'a'.repeat(64),
      ip: '203.0.113.7',
      ua: 'conformance',
      signedUpAt: '2026-10-21T14:03:11.000Z',
      programId: null,
      autoEnroll: false,
      referral: { code: 'CONFORMANCE1', consent: 'not_required', capturedAt: '2026-10-21T14:00:00.000Z' },
    },
    sign: 'valid',
    expect: { status: OK, json: SIGNUP_ANSWER },
    why: 'An unknown code is "not referred", not an error.',
  }),
  W({
    id: 'webhook.signup_op_mismatch_is_400',
    title: 'A body whose op does not match the endpoint is refused',
    area: 'errors',
    op: 'signups',
    body: { op: 'erase', customerRef: 'conformance_{run}' },
    sign: 'valid',
    expect: { status: [400, 422] },
    why: 'The op in the signed body is what stops a captured call being replayed against another endpoint.',
  }),
  W({
    id: 'webhook.erase_unknown_is_ok',
    title: 'Erasing a customer the platform does not hold succeeds (200/202/204/404)',
    area: 'erase',
    op: 'erase',
    body: { op: 'erase', customerRef: 'conformance_nobody_{run}' },
    sign: 'valid',
    expect: { status: [200, 202, 204, 404] },
    why: '404 means already gone, which is success for an erasure.',
  }),
  W({
    id: 'webhook.export_unknown_is_ok',
    title: 'Exporting a customer the platform does not hold answers 200 or 404',
    area: 'export',
    op: 'export',
    body: { op: 'export', customerRef: 'conformance_nobody_{run}', test: false },
    sign: 'valid',
    expect: { status: [200, 404] },
    why: '404 is "nothing held", a valid answer to a data-subject request.',
  }),
  W({
    id: 'webhook.partner_unsupported_or_ok',
    title: 'Registering a user-chosen code is accepted, 409 when taken, or 404/405/501 when unsupported',
    area: 'signup',
    op: 'partners',
    body: { op: 'partner', customerRef: 'conformance_partner_{run}', code: 'CONF{run}', emailHash: null },
    sign: 'valid',
    expect: { status: [200, 201, 204, 404, 405, 409, 501] },
    why: 'This is what the `partner` capability means: Atlas can register a user-chosen code. 409 = code taken.',
  }),
  W({
    id: 'webhook.signal_unsupported_or_ok',
    title: 'A signal is accepted, or 404/405/501 when unsupported',
    area: 'signal',
    op: 'signals',
    body: { op: 'signal', customerRef: 'conformance_nobody_{run}', type: 'email_verified', occurredAt: '2026-10-21T14:05:00.000Z', data: {} },
    sign: 'valid',
    expect: { status: [200, 202, 204, 404, 405, 501] },
    why: 'Signals are optional.',
  }),
  W({
    id: 'webhook.user_unsupported_or_ok',
    title: 'A user update is accepted, or 404/405/501 when unsupported',
    area: 'user',
    op: 'users',
    body: { op: 'user', customerRef: 'conformance_user_{run}', email: null, name: null, status: 'active' },
    sign: 'valid',
    expect: { status: [200, 201, 204, 404, 405, 501] },
    why: 'User lifecycle forwarding is optional.',
  }),
];

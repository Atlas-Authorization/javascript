import { verifyWebhook, type WebhookVerifyFailure } from './webhooks';
import type { ReferralRisk } from './client/referrals';

/**
 * The Atlas referral protocol (v1), for a REFERRAL PLATFORM receiving calls
 * from Atlas. An Atlas instance with referral attribution on (provider
 * `webhook`) calls the platform's base URL. Every call is a signed POST whose
 * JSON body says which operation it is (`op`) and which customer it is about:
 *
 *   POST {base}/signups   { op: 'signup', customerRef, … }            → 200 ReferralSignupResponse
 *   POST {base}/erase     { op: 'erase', customerRef }                → 2xx (404 = already gone)
 *   POST {base}/export    { op: 'export', customerRef, test }         → 200 JSON (any shape) | 404
 *   POST {base}/partners  { op: 'partner', customerRef, code, emailHash } → 2xx | 409 code taken | 404/405/501 unsupported
 *   POST {base}/signals   { op: 'signal', customerRef, type, occurredAt, data } → 2xx | 404/405/501 unsupported
 *
 * The connection test is `POST {base}/export` with
 * `{ op: 'export', customerRef: 'atlas_connection_test', test: true }` (answer
 * 2xx or 404). Calls are signed exactly like Atlas webhooks (`atlas-id`,
 * `atlas-timestamp`, `atlas-signature` over `<id>.<timestamp>.<raw body>`),
 * with `Idempotency-Key` and `User-Agent: Atlas-Referrals/1`. `atlas-id` is the
 * call id, the same on every retry of one call.
 *
 * The signature covers the body, not the URL, so everything that matters is in
 * the body. Pass the path the request arrived on (or the operation you
 * expect): a signed body whose `op` does not match it is refused, so a
 * captured call cannot be replayed against another endpoint.
 */

/** `customerRef` of the connection test (`POST {base}/export` with `test: true`). */
export const REFERRAL_CONNECTION_TEST_REF = 'atlas_connection_test';

/** The `User-Agent` Atlas sends on every referral call. */
export const REFERRAL_PROTOCOL_USER_AGENT = 'Atlas-Referrals/1';

/** The referral captured at sign-up (from the page URL, or a tracking cookie under consent). Never trusted. */
export interface ReferralContext {
  /** The referral code from the URL (or cookie), 3-64 of `A-Z a-z 0-9 _ -`. */
  code: string | null;
  /** The platform's click id, read from its cookie only under consent. */
  clickId: string | null;
  /** The platform's anonymous visitor id, read from its cookie only under consent. */
  anonId: string | null;
  /** ISO 8601. */
  capturedAt: string;
  /** `granted`: the cookie was read under consent. `not_required`: a URL code only. */
  consent: 'granted' | 'not_required';
}

/** The risk verdict Atlas sends with a sign-up (the same shape as `ReferralCall.risk`). */
export type ReferralRiskVerdict = ReferralRisk;

/** `POST {base}/signups`. Idempotent on `customerRef` (`Idempotency-Key: signup:<customerRef>`). */
export interface ReferralSignupPayload {
  op: 'signup';
  /** The app's id for the user: its external_id when set, else the Atlas user id. */
  customerRef: string;
  /** sha256 hex of the lower-cased, trimmed primary email; null when the user has none. */
  emailHash: string | null;
  ip: string | null;
  ua: string | null;
  /** ISO 8601: the original sign-up time, the same on every retry. */
  signedUpAt: string;
  programId: string | null;
  /** Make the user a referrer: answer with `partner { id, code, link }`. */
  autoEnroll: boolean;
  /** Null when the user arrived with no referral (reported because of `autoEnroll`), or when stripped. */
  referral: ReferralContext | null;
  risk?: ReferralRiskVerdict | null;
  /** Set when Atlas stripped the referral because of its risk policy. */
  rejected?: { reason: string } | null;
}

/** The answer a platform gives to `POST {base}/signups`. */
export interface ReferralSignupResponse {
  /** The matched referral, or null when not referred. */
  referral: {
    partnerId: string | null;
    /** The referrer as the app knows them (their customerRef); Atlas maps it to a local user. */
    referrerExternalRef: string | null;
    /** e.g. `code`, `click`, `coupon`. */
    matchedVia: string | null;
    status: string | null;
  } | null;
  /** The user's own partner record when `autoEnroll` was true. `link` may be omitted: Atlas builds it from its link template. */
  partner?: { id: string | null; code: string | null; link?: string | null } | null;
}

/** `POST {base}/erase`. */
export interface ReferralErasePayload {
  op: 'erase';
  customerRef: string;
}

/** `POST {base}/export`: what you hold about a customer (answer any JSON, or 404). */
export interface ReferralExportPayload {
  op: 'export';
  customerRef: string;
  /** True for the connection test (`customerRef` `atlas_connection_test`). */
  test: boolean;
}

/** `POST {base}/partners`: the user's own referral code was set in Atlas. */
export interface ReferralPartnerPayload {
  op: 'partner';
  customerRef: string;
  code: string;
  emailHash: string | null;
}

/** The lifecycle signal types. */
export type ReferralSignalType =
  | 'email_verified'
  | 'user_banned'
  | 'user_unbanned'
  | 'user_locked'
  | 'risk_elevated'
  | 'fraud_confirmed';

/** `POST {base}/signals`: a lifecycle update, so the platform can qualify, hold or void a commission. */
export interface ReferralSignalPayload {
  op: 'signal';
  customerRef: string;
  type: ReferralSignalType | (string & {});
  /** ISO 8601. */
  occurredAt: string;
  data: Record<string, unknown>;
}

/** The operations of the referral protocol (the `op` of every call). */
export type ReferralOp = 'signup' | 'erase' | 'export' | 'partner' | 'signal';

/** The endpoint (last path segment) each operation is sent to. */
export const REFERRAL_OP_ENDPOINTS: Record<ReferralOp, string> = {
  signup: 'signups',
  erase: 'erase',
  export: 'export',
  partner: 'partners',
  signal: 'signals',
};

/** A verified call, by operation. */
export type ReferralProtocolCall =
  | { op: 'signup'; payload: ReferralSignupPayload }
  | { op: 'erase'; payload: ReferralErasePayload }
  | {
      op: 'export';
      payload: ReferralExportPayload;
      /** The connection test (`customerRef` `atlas_connection_test`): answer 2xx or 404. */
      test: boolean;
    }
  | { op: 'partner'; payload: ReferralPartnerPayload }
  | { op: 'signal'; payload: ReferralSignalPayload };

/**
 * Why a call was refused: a webhook signature failure, or
 * `malformed_body` (not a JSON object), `missing_op`, `unknown_op`,
 * `unknown_endpoint` (the path's last segment is not a protocol endpoint) or
 * `op_mismatch` (the signed `op` is not the operation of the endpoint or the
 * expected operation).
 */
export type ReferralVerifyFailure =
  | WebhookVerifyFailure
  | 'malformed_body'
  | 'missing_op'
  | 'unknown_op'
  | 'unknown_endpoint'
  | 'op_mismatch';

type HeadersLike = Headers | Record<string, string | string[] | undefined>;

export interface VerifyReferralRequestInput {
  /** The RAW request body (string or Buffer), before any JSON parse. */
  body: string | Buffer;
  headers: HeadersLike;
  /** The signing secret configured on the Atlas instance's referral settings. */
  secret: string;
  /**
   * The path (or full URL) the request arrived on, e.g. `req.path`. Its last
   * segment (`signups`, `erase`, `export`, `partners`, `signals`) must match
   * the signed `op`.
   */
  path?: string;
  /** The operation this handler serves; the signed `op` must equal it. */
  expectedOp?: ReferralOp;
  now?: Date;
  /** Defaults to 5 minutes, as for webhooks. */
  toleranceMs?: number;
}

export interface ReferralVerifyResult {
  verified: boolean;
  reason?: ReferralVerifyFailure;
  /** The signed `atlas-id` (the call id): the same on every retry of one call. */
  deliveryId?: string;
  /** The signed `atlas-timestamp` (epoch ms). */
  timestamp?: number;
  /** The `Idempotency-Key` header (`signup:<customerRef>` on sign-ups). Not signed. */
  idempotencyKey?: string;
  /** The operation and its payload, present only when `verified`. */
  call?: ReferralProtocolCall;
}

function header(headers: HeadersLike, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const bag = headers as Record<string, string | string[] | undefined>;
  const hit = Object.keys(bag).find((k) => k.toLowerCase() === name);
  const v = hit ? bag[hit] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

const OPS = Object.keys(REFERRAL_OP_ENDPOINTS) as ReferralOp[];

/** The operation of a path's last segment, or null when it is not a protocol endpoint. */
export function referralOpForPath(path: string): ReferralOp | null {
  let pathname = path;
  try {
    pathname = new URL(path, 'http://referrals.invalid').pathname;
  } catch {
    /* use it as given */
  }
  const segments = pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  return OPS.find((op) => REFERRAL_OP_ENDPOINTS[op] === last) ?? null;
}

/**
 * Verify a call from Atlas to your referral platform and tell which operation
 * it is. Never throws: check `verified`. Verify over the RAW body, before any
 * JSON parse, and pass the path it arrived on (or `expectedOp`) so a signed
 * body cannot be replayed against another endpoint.
 *
 * ```ts
 * app.post('/atlas/:endpoint', express.raw({ type: '*\/*' }), async (req, res) => {
 *   const { verified, call } = verifyReferralRequest({
 *     body: req.body, headers: req.headers, secret, path: req.path,
 *   });
 *   if (!verified || !call) return res.sendStatus(401);
 *   if (call.op === 'export' && call.test) return res.sendStatus(404);
 *   if (call.op === 'signup') return res.json(await attribute(call.payload)); // ReferralSignupResponse
 *   // erase, export, partner, signal ...
 * });
 * ```
 */
export function verifyReferralRequest(input: VerifyReferralRequestInput): ReferralVerifyResult {
  const result = verifyWebhook<unknown>({
    body: input.body,
    headers: input.headers,
    secret: input.secret,
    now: input.now,
    toleranceMs: input.toleranceMs,
  });
  if (!result.verified) return { verified: false, reason: result.reason };
  const body = result.event;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { verified: false, reason: 'malformed_body' };
  const op = (body as { op?: unknown }).op;
  if (op === undefined || op === null || op === '') return { verified: false, reason: 'missing_op' };
  if (typeof op !== 'string' || !(OPS as string[]).includes(op)) return { verified: false, reason: 'unknown_op' };
  if (input.path !== undefined) {
    const endpointOp = referralOpForPath(input.path);
    if (!endpointOp) return { verified: false, reason: 'unknown_endpoint' };
    if (endpointOp !== op) return { verified: false, reason: 'op_mismatch' };
  }
  if (input.expectedOp !== undefined && input.expectedOp !== op) return { verified: false, reason: 'op_mismatch' };
  const call =
    op === 'export'
      ? ({ op, payload: body as ReferralExportPayload, test: (body as ReferralExportPayload).test === true } as const)
      : ({ op, payload: body } as ReferralProtocolCall);
  return {
    verified: true,
    deliveryId: result.deliveryId,
    timestamp: result.timestamp,
    idempotencyKey: header(input.headers, 'idempotency-key'),
    call,
  };
}

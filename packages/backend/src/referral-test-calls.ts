import { createHash, createHmac, randomBytes } from './edge-crypto';
import {
  REFERRAL_OP_ENDPOINTS,
  REFERRAL_PROTOCOL_USER_AGENT,
  REFERRAL_PROTOCOL_VERSION,
  REFERRAL_PROTOCOL_VERSION_HEADER,
  type ReferralOp,
} from './referrals';

/**
 * Signed referral calls for an app's own test suite: send exactly what an
 * Atlas instance would send to a referral platform, against a platform you run
 * locally, with no Atlas instance involved. Two wire formats:
 *
 *  - the Atlas referral protocol (provider `webhook`): every call is a signed
 *    `POST {base}/<endpoint>` with `op` and `customerRef` in the body, signed
 *    like Atlas webhooks (`atlas-id`, `atlas-timestamp`, `atlas-signature`);
 *  - Referalli (provider `referalli`): `{base}/v1/auth/connections/{id}/…`,
 *    signed with `x-referalli-signature: t=<unix s>,v1=<hex HMAC-SHA256>` over
 *    `"{t}.{payload}"`, where payload is the raw body for POST and the raw
 *    query string for GET.
 *
 * Both are also on {@link TestIssuer} (`referralCall`, `referalliCall`) with
 * the issuer's clock.
 */

/** A ready-to-send signed call. `request()` builds a Fetch `Request`. */
export interface SignedReferralCall {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  /** The exact signed body (absent on GET). */
  body?: string;
  request(): Request;
}

function signed(url: string, method: 'POST' | 'GET', headers: Record<string, string>, body?: string): SignedReferralCall {
  return {
    url,
    method,
    headers,
    body,
    request: () => new Request(url, { method, headers, body }),
  };
}

const trimBase = (base: string) => base.replace(/\/+$/, '');

/** sha256 hex of the lower-cased, trimmed email, as Atlas sends `emailHash`. */
export function referralEmailHash(email: string | null | undefined): string | null {
  if (!email) return null;
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export interface AtlasReferralCallOptions {
  /** The platform's base URL, as configured on the instance (`endpoint_url`). */
  baseUrl: string;
  /** The instance's signing secret for the connection. */
  secret: string;
  op: ReferralOp;
  /** The rest of the body (`customerRef` and the op's fields); `op` is added. */
  payload: { customerRef: string } & Record<string, unknown>;
  /** The call id (`atlas-id`), the same on every retry of one call. Default: random. */
  callId?: string;
  /** Epoch ms. Default: now. */
  now?: number;
}

/** A call in the Atlas referral protocol, signed exactly as an Atlas instance signs it. */
export function signAtlasReferralCall(options: AtlasReferralCallOptions): SignedReferralCall {
  const id = options.callId ?? `rfc_test_${randomBytes(8).toString('hex')}`;
  const timestamp = options.now ?? Date.now();
  const body = JSON.stringify({ op: options.op, ...options.payload });
  const signature = createHmac('sha256', options.secret).update(`${id}.${timestamp}.${body}`).digest('base64');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'atlas-id': id,
    'atlas-timestamp': String(timestamp),
    'atlas-signature': `v1,${signature}`,
    'idempotency-key': `${options.op}:${options.payload.customerRef}`,
    'user-agent': REFERRAL_PROTOCOL_USER_AGENT,
    [REFERRAL_PROTOCOL_VERSION_HEADER]: REFERRAL_PROTOCOL_VERSION,
  };
  return signed(`${trimBase(options.baseUrl)}/${REFERRAL_OP_ENDPOINTS[options.op]}`, 'POST', headers, body);
}

/** The Referalli API version Atlas pins on every call (`referalli-version`). */
export const REFERALLI_API_VERSION = '2026-10-21';

/** The Referalli connection calls Atlas makes. */
export type ReferalliCallOp = 'signups' | 'erase' | 'export' | 'aliases' | 'users' | 'signals' | 'ping';

export interface ReferalliCallOptions {
  /** Your Referalli base URL (never hard-code it; read it from config). */
  baseUrl: string;
  /** The Atlas connection id on Referalli. */
  connectionId: string;
  /** The connection secret Referalli returned when the connection was created. */
  secret: string;
  op: ReferalliCallOp;
  /** The JSON body for POST calls. */
  body?: Record<string, unknown>;
  /** `export` only: the customer to export (sent as `?customerRef=`). */
  customerRef?: string;
  /** Epoch ms. Default: now. */
  now?: number;
  /** The per-attempt request id (`x-referalli-id`). Default: derived from the time and op. */
  requestId?: string;
}

/**
 * The v1-only `x-referalli-signature` value for a payload: `t=<unix s>,v1=<hex
 * HMAC-SHA256(secret, "{t}.{payload}")>`. {@link signReferalliCall} sends v1 and
 * v2 together.
 */
export function referalliSignature(secret: string, payload: string, unixSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${unixSeconds}.${payload}`).digest('hex');
  return `t=${unixSeconds},v1=${mac}`;
}

/**
 * The full signature header Atlas sends: v1 over "{t}.{payload}" plus v2 over
 * "{t}.{METHOD}.{path?query}.{body}" (body empty for a GET), which binds the
 * request to its endpoint.
 */
export function referalliSignatureV2(
  secret: string,
  parts: { method: 'GET' | 'POST'; pathAndQuery: string; payload: string },
  unixSeconds: number,
): string {
  const body = parts.method === 'GET' ? '' : parts.payload;
  const v2 = createHmac('sha256', secret)
    .update(`${unixSeconds}.${parts.method}.${parts.pathAndQuery}.${body}`)
    .digest('hex');
  return `${referalliSignature(secret, parts.payload, unixSeconds)},v2=${v2}`;
}

/** A Referalli connection call, signed exactly as the Atlas `referalli` adapter signs it (v1 + v2, both header spellings). */
export function signReferalliCall(options: ReferalliCallOptions): SignedReferralCall {
  const t = Math.floor((options.now ?? Date.now()) / 1000);
  const base = `${trimBase(options.baseUrl)}/v1/auth/connections/${encodeURIComponent(options.connectionId)}/${options.op}`;
  const requestId = options.requestId ?? `req_${t}_${options.op}`;
  const headers: Record<string, string> = {
    'referalli-version': REFERALLI_API_VERSION,
    'referally-version': REFERALLI_API_VERSION,
    'x-referalli-id': requestId,
    'x-referally-id': requestId,
  };
  const sign = (method: 'GET' | 'POST', url: string, payload: string) => {
    const u = new URL(url);
    const signature = referalliSignatureV2(options.secret, { method, pathAndQuery: `${u.pathname}${u.search}`, payload }, t);
    headers['x-referalli-signature'] = signature;
    headers['x-referally-signature'] = signature;
  };
  if (options.op === 'export') {
    if (!options.customerRef) throw new Error('signReferalliCall: export needs customerRef.');
    const query = new URLSearchParams({ customerRef: options.customerRef }).toString();
    sign('GET', `${base}?${query}`, query);
    return signed(`${base}?${query}`, 'GET', headers);
  }
  const body = JSON.stringify(options.body ?? {});
  headers['content-type'] = 'application/json';
  sign('POST', base, body);
  return signed(base, 'POST', headers, body);
}

/** The fields of a `referral.updated` event; absent fields stay unchanged on the Atlas side. */
export interface ReferralUpdatedEvent {
  /** The user's `customerRef` (as Atlas sent it on sign-up). This or `referralId` names the referral. */
  customerRef?: string;
  /** The platform's referral id. */
  referralId?: string;
  programId?: string;
  /** The referral's status on the platform (e.g. `qualified`). */
  status?: string;
  partnerId?: string;
  /** The referrer's `customerRef`, when the referrer is an Atlas user. */
  referrerExternalRef?: string;
  matchedVia?: string;
}

export interface ReferralUpdatedEventOptions {
  /** The instance's inbound URL (`inbound.url` on the referral settings). */
  inboundUrl: string;
  /** The inbound secret, or the connection's signing secret when no inbound secret is set. */
  secret: string;
  event: ReferralUpdatedEvent;
  /** When the change happened (ISO 8601 or epoch ms). Default: `now`. Atlas ignores events older than the last one applied. */
  occurredAt?: string | number;
  /** The event id (`atlas-id`), the same on every retry. Default: random. */
  eventId?: string;
  /** Epoch ms. Default: now. */
  now?: number;
}

/**
 * Two-way sync: a `referral.updated` event from the platform to an Atlas
 * instance's inbound URL, signed like Atlas webhooks (`atlas-id`,
 * `atlas-timestamp` in ms, `atlas-signature: v1,<base64 HMAC-SHA256 of
 * "{id}.{ts}.{body}">`). Use it in a platform built on the Atlas referral
 * protocol to send referral changes made after sign-up, or in its tests.
 */
export function signReferralUpdatedEvent(options: ReferralUpdatedEventOptions): SignedReferralCall {
  const { event } = options;
  if (!event.customerRef && !event.referralId) {
    throw new Error('signReferralUpdatedEvent: the event needs customerRef or referralId.');
  }
  const id = options.eventId ?? `rfe_${randomBytes(8).toString('hex')}`;
  const timestamp = options.now ?? Date.now();
  const occurred = options.occurredAt ?? timestamp;
  const body = JSON.stringify({
    type: 'referral.updated',
    occurredAt: typeof occurred === 'number' ? new Date(occurred).toISOString() : occurred,
    ...event,
  });
  const signature = createHmac('sha256', options.secret).update(`${id}.${timestamp}.${body}`).digest('base64');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'atlas-id': id,
    'atlas-timestamp': String(timestamp),
    'atlas-signature': `v1,${signature}`,
    'user-agent': REFERRAL_PROTOCOL_USER_AGENT,
    [REFERRAL_PROTOCOL_VERSION_HEADER]: REFERRAL_PROTOCOL_VERSION,
  };
  return signed(options.inboundUrl, 'POST', headers, body);
}

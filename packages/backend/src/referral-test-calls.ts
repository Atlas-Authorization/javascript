import { createHash, createHmac, randomBytes } from 'node:crypto';
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
 *  - Referally (provider `referally`): `{base}/v1/auth/connections/{id}/…`,
 *    signed with `x-referally-signature: t=<unix s>,v1=<hex HMAC-SHA256>` over
 *    `"{t}.{payload}"`, where payload is the raw body for POST and the raw
 *    query string for GET.
 *
 * Both are also on {@link TestIssuer} (`referralCall`, `referallyCall`) with
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

/** The Referally API version Atlas pins on every call (`referally-version`). */
export const REFERALLY_API_VERSION = '2026-10-21';

/** The Referally connection calls Atlas makes. */
export type ReferallyCallOp = 'signups' | 'erase' | 'export' | 'aliases' | 'users' | 'ping';

export interface ReferallyCallOptions {
  /** Your Referally base URL (never hard-code it; read it from config). */
  baseUrl: string;
  /** The Atlas connection id on Referally. */
  connectionId: string;
  /** The connection secret Referally returned when the connection was created. */
  secret: string;
  op: ReferallyCallOp;
  /** The JSON body for POST calls. */
  body?: Record<string, unknown>;
  /** `export` only: the customer to export (sent as `?customerRef=`). */
  customerRef?: string;
  /** Epoch ms. Default: now. */
  now?: number;
}

/**
 * The `x-referally-signature` value for a payload: `t=<unix s>,v1=<hex
 * HMAC-SHA256(secret, "{t}.{payload}")>`.
 */
export function referallySignature(secret: string, payload: string, unixSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${unixSeconds}.${payload}`).digest('hex');
  return `t=${unixSeconds},v1=${mac}`;
}

/** A Referally connection call, signed exactly as the Atlas `referally` adapter signs it. */
export function signReferallyCall(options: ReferallyCallOptions): SignedReferralCall {
  const t = Math.floor((options.now ?? Date.now()) / 1000);
  const base = `${trimBase(options.baseUrl)}/v1/auth/connections/${encodeURIComponent(options.connectionId)}/${options.op}`;
  const headers: Record<string, string> = { 'referally-version': REFERALLY_API_VERSION };
  if (options.op === 'export') {
    if (!options.customerRef) throw new Error('signReferallyCall: export needs customerRef.');
    const query = new URLSearchParams({ customerRef: options.customerRef }).toString();
    headers['x-referally-signature'] = referallySignature(options.secret, query, t);
    return signed(`${base}?${query}`, 'GET', headers);
  }
  const body = JSON.stringify(options.body ?? {});
  headers['content-type'] = 'application/json';
  headers['x-referally-signature'] = referallySignature(options.secret, body, t);
  return signed(base, 'POST', headers, body);
}

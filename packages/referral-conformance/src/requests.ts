import { createHmac } from 'node:crypto';
import { REFERALLI_VERSION, signatureHeader, signatureV1 } from './sign';
import type { CaseSign, ConformanceCase } from './cases';

/** One signed request, ready to send. */
export interface RecordedCall {
  /** The case id. */
  id: string;
  method: 'GET' | 'POST';
  /** Absolute URL. */
  url: string;
  /** Path and query, as signed. */
  pathAndQuery: string;
  headers: Record<string, string>;
  /** The raw body (absent on GET). */
  body?: string;
  /** Send twice with the same headers; the second answer is the one that counts. */
  replay: boolean;
}

export interface MaterializeOptions {
  baseUrl: string;
  connectionId: string;
  secret: string;
  /** Epoch ms; default now. */
  now?: number;
  /** Replaces `{run}` in bodies and queries. */
  runId: string;
  /** The `x-referalli-id`; default derived from the case id and run. */
  requestId?: string;
}

const fill = (v: unknown, runId: string): unknown => {
  if (typeof v === 'string') return v.replaceAll('{run}', runId);
  if (Array.isArray(v)) return v.map((x) => fill(x, runId));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, runId)]));
  return v;
};

const STALE_SECONDS = 600;

function signHeaders(
  sign: CaseSign,
  secret: string,
  t: number,
  parts: { method: 'GET' | 'POST'; pathAndQuery: string; payload: string },
): string | null {
  switch (sign) {
    case 'unsigned':
      return null;
    case 'wrong_secret':
      return signatureHeader({ secret: `${secret}_wrong`, timestampSeconds: t, ...parts });
    case 'stale':
      return signatureHeader({ secret, timestampSeconds: t - STALE_SECONDS, ...parts });
    case 'v1_only':
      return signatureV1(secret, t, parts.payload);
    default:
      return signatureHeader({ secret, timestampSeconds: t, ...parts });
  }
}

/** The endpoint each op of the generic webhook protocol is sent to. */
const WEBHOOK_ENDPOINT: Record<string, string> = {
  signups: 'signups',
  erase: 'erase',
  export: 'export',
  partners: 'partners',
  signals: 'signals',
  aliases: 'aliases',
  users: 'users',
  ping: 'ping',
};

/** A generic webhook-protocol call, signed like an Atlas webhook: `atlas-signature: v1,<base64 HMAC(id.timestamp.body)>`. */
function materializeWebhook(c: ConformanceCase, o: MaterializeOptions): RecordedCall {
  const tMs = o.now ?? Date.now();
  const id = o.requestId ?? `rfc_${c.id}_${o.runId}`;
  const body = JSON.stringify(fill(c.body ?? {}, o.runId));
  const base = o.baseUrl.replace(/\/+$/, '');
  const stampMs = c.sign === 'stale' ? tMs - STALE_SECONDS * 1000 : tMs;
  const key = c.sign === 'wrong_secret' ? `${o.secret}_wrong` : o.secret;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'atlas-referrals-version': '2026-10-21',
    ...(c.headers ?? {}),
  };
  if (c.sign !== 'unsigned') {
    headers['atlas-id'] = id;
    headers['atlas-timestamp'] = String(stampMs);
    headers['atlas-signature'] = `v1,${createHmac('sha256', key).update(`${id}.${stampMs}.${body}`).digest('base64')}`;
  }
  const path = `/${WEBHOOK_ENDPOINT[c.op]}`;
  return { id: c.id, method: 'POST', url: `${base}${path}`, pathAndQuery: path, headers, body, replay: c.replay === true };
}

/** Turn a case into the exact signed request Atlas would send. */
export function materialize(c: ConformanceCase, o: MaterializeOptions): RecordedCall {
  if (c.profile === 'webhook') return materializeWebhook(c, o);
  const t = Math.floor((o.now ?? Date.now()) / 1000);
  const base = o.baseUrl.replace(/\/+$/, '');
  const connection = c.connection === 'unknown' ? `${o.connectionId}_unknown` : o.connectionId;
  const path = `/v1/auth/connections/${encodeURIComponent(connection)}/${c.op}`;
  const query = c.query ? new URLSearchParams(fill(c.query, o.runId) as Record<string, string>).toString() : '';
  const pathAndQuery = query ? `${path}?${query}` : path;
  const body = c.method === 'POST' ? JSON.stringify(fill(c.body ?? {}, o.runId)) : undefined;
  const requestId = o.requestId ?? `conf_${c.id}_${o.runId}`;
  const signature = signHeaders(c.sign, o.secret, t, {
    method: c.method,
    pathAndQuery,
    payload: c.method === 'GET' ? query : (body ?? ''),
  });
  const headers: Record<string, string> = {
    'referalli-version': REFERALLI_VERSION,
    'referally-version': REFERALLI_VERSION,
    'x-referalli-id': requestId,
    'x-referally-id': requestId,
    ...(c.headers ?? {}),
  };
  if (signature) {
    headers['x-referalli-signature'] = signature;
    headers['x-referally-signature'] = signature;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  return {
    id: c.id,
    method: c.method,
    url: `${base}${pathAndQuery}`,
    pathAndQuery,
    headers,
    ...(body !== undefined ? { body } : {}),
    replay: c.replay === true,
  };
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFORMANCE_CASES,
  INBOUND_EVENT_CASES,
  RECORDED_CALLS,
  RECORDING,
  formatReport,
  matchShape,
  materialize,
  runConformance,
  signInboundEvent,
  validateInboundEvent,
  verifyRequest,
} from './index';
import { createHmac } from 'node:crypto';
import { standardWebhookSignature } from './sign';

const SECRET = 'conformance_secret_0123456789abcdef';
const CONNECTION = 'conn_ok';

interface Opts {
  /** Answer 404 instead of 401 for a bad signature (the bug the suite exists to catch). */
  badSignatureIs404?: boolean;
  /** Answer 400 to a null ip. */
  rejectNulls?: boolean;
  /** Answer 404 to an export for an unknown customer. */
  export404?: boolean;
}

/** A small server that implements the protocol the way the suite expects. */
function referalliLike(opts: Opts = {}): Promise<{ server: Server; baseUrl: string }> {
  const seenIds = new Set<string>();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body?: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const error = (status: number, code: string) => send(status, { error: { code, message: code, request_id: 'req_1' } });
    const m = /^\/v1\/auth\/connections\/([^/]+)\/(\w+)$/.exec(url.pathname);
    if (!m) return error(404, 'not_found');
    if (m[1] !== CONNECTION) return error(404, 'connection_not_found');
    const op = m[2]!;
    const verified = verifyRequest({
      secret: SECRET,
      method: req.method ?? 'GET',
      pathAndQuery: `${url.pathname}${url.search}`,
      payload: req.method === 'GET' ? url.search.slice(1) : raw,
      header: req.headers['x-referalli-signature'] as string | undefined,
    });
    if (!verified.ok) return error(opts.badSignatureIs404 ? 404 : 401, 'signature_rejected');
    const id = String(req.headers['x-referalli-id'] ?? '');
    if (seenIds.has(id)) return error(409, 'replay');
    seenIds.add(id);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    switch (op) {
      case 'ping':
        return send(200, { ok: true, connectionId: CONNECTION, programId: 'prg_1', serverTime: new Date().toISOString() });
      case 'signups':
        if (!body.customerRef) return error(400, 'invalid_request');
        if (opts.rejectNulls && body.ip === null) return error(400, 'invalid_request');
        return send(200, { referral: null, partner: null, notes: [] });
      case 'export':
        return opts.export404 ? error(404, 'customer_not_found') : send(200, { data: [] });
      case 'signals':
        return body.signal === 'not_a_signal' ? error(400, 'invalid_signal') : send(200, { referrals: [] });
      case 'partners':
        // Like Referalli: the partner is found or created by email, so it is required.
        return typeof body.email === 'string' ? send(201, { ok: true }) : error(400, 'validation_error');
      default:
        return send(200, {});
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

let running: Server | null = null;
afterEach(() => {
  running?.close();
  running = null;
});

describe('runConformance', () => {
  it('passes a server that implements the protocol', async () => {
    const { server, baseUrl } = await referalliLike();
    running = server;
    const report = await runConformance({ baseUrl, connectionId: CONNECTION, secret: SECRET });
    expect(report.results.filter((r) => r.outcome !== 'pass').map((r) => [r.id, r.problems])).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.passed).toBe(CONFORMANCE_CASES.length);
  });

  it('catches a bad signature answered 404 (read by Atlas as a paused connection)', async () => {
    const { server, baseUrl } = await referalliLike({ badSignatureIs404: true });
    running = server;
    const report = await runConformance({ baseUrl, connectionId: CONNECTION, secret: SECRET, only: ['auth.'] });
    const failing = report.results.filter((r) => r.outcome === 'fail').map((r) => r.id);
    expect(failing).toContain('auth.bad_signature_is_401');
    expect(failing).toContain('auth.unsigned_is_401');
    expect(report.ok).toBe(false);
    expect(formatReport(report).join('\n')).toMatch(/FAIL {2}auth\.bad_signature_is_401/);
  });

  it('catches nulls rejected as invalid', async () => {
    const { server, baseUrl } = await referalliLike({ rejectNulls: true });
    running = server;
    const report = await runConformance({ baseUrl, connectionId: CONNECTION, secret: SECRET, only: ['signup.nulls_are_accepted'] });
    expect(report.results[0]).toMatchObject({ id: 'signup.nulls_are_accepted', outcome: 'fail', status: 400 });
  });

  it('catches a 404 for an export of an unknown customer', async () => {
    const { server, baseUrl } = await referalliLike({ export404: true });
    running = server;
    const report = await runConformance({ baseUrl, connectionId: CONNECTION, secret: SECRET, only: ['export.'] });
    expect(report.ok).toBe(false);
  });

  it('reports an unreachable server as failures, not a crash', async () => {
    const report = await runConformance({ baseUrl: 'http://127.0.0.1:1', connectionId: CONNECTION, secret: SECRET, only: ['ping.'], timeoutMs: 500 });
    expect(report.ok).toBe(false);
    expect(report.results[0]!.problems[0]).toMatch(/no answer/);
  });

  it('selects by case id or area prefix', async () => {
    const { server, baseUrl } = await referalliLike();
    running = server;
    const report = await runConformance({ baseUrl, connectionId: CONNECTION, secret: SECRET, only: ['ping.ok', 'erase'] });
    expect(report.results.map((r) => r.id)).toEqual(['ping.ok', 'erase.unknown_customer_is_ok']);
  });
});

describe('the recording', () => {
  it('is deterministic: the same bytes every time', () => {
    const again = CONFORMANCE_CASES.map((c) =>
      materialize(c, { baseUrl: RECORDING.baseUrl, connectionId: RECORDING.connectionId, secret: RECORDING.secret, now: RECORDING.nowMs, runId: RECORDING.runId }),
    );
    expect(again.map((c) => ({ ...c }))).toEqual(RECORDED_CALLS.map(({ expect: _e, ...c }) => c));
  });

  it('pins the signature of the first call (a golden value: changing it breaks every receiver)', () => {
    const ping = RECORDED_CALLS.find((c) => c.id === 'auth.v1_only_is_accepted_or_401')!;
    expect(ping.headers['x-referalli-signature']).toBe(
      't=1792591391,v1=36be8f304c051a0dbace82f94cbdbd677cf087651560e3be9eec04ae2cfa9a66',
    );
  });

  it('verifies as a valid v2 call at the recorded time, and a stale one does not', () => {
    const call = RECORDED_CALLS.find((c) => c.id === 'signup.minimal')!;
    const verify = (now: number) =>
      verifyRequest({
        secret: RECORDING.secret,
        method: call.method,
        pathAndQuery: call.pathAndQuery,
        payload: call.body ?? '',
        header: call.headers['x-referalli-signature'],
        now,
      });
    expect(verify(RECORDING.nowMs)).toMatchObject({ ok: true, version: 'v2' });
    expect(verify(RECORDING.nowMs + 11 * 60_000)).toEqual({ ok: false, reason: 'stale' });
    const legacy = verifyRequest({
      secret: RECORDING.secret,
      method: call.method,
      pathAndQuery: call.pathAndQuery,
      payload: call.body ?? '',
      header: call.headers['x-referally-signature'],
      now: RECORDING.nowMs,
    });
    expect(legacy.ok).toBe(true);
  });

  it('carries every case once with the legacy headers alongside', () => {
    expect(new Set(RECORDED_CALLS.map((c) => c.id)).size).toBe(CONFORMANCE_CASES.length);
    const signed = RECORDED_CALLS.filter((c) => c.headers['x-referalli-signature']);
    for (const c of signed) expect(c.headers['x-referally-signature']).toBe(c.headers['x-referalli-signature']);
  });
});

describe('verifyRequest', () => {
  const base = { secret: 's3cret', method: 'POST', pathAndQuery: '/v1/x', payload: '{}', now: 1_000_000_000_000 };
  it('rejects a v2 signature replayed on another endpoint', async () => {
    const { signatureHeader } = await import('./sign');
    const header = signatureHeader({ secret: 's3cret', timestampSeconds: 1_000_000_000, method: 'POST', pathAndQuery: '/v1/x', payload: '{}' });
    expect(verifyRequest({ ...base, header })).toMatchObject({ ok: true, version: 'v2' });
    expect(verifyRequest({ ...base, pathAndQuery: '/v1/other', header })).toEqual({ ok: false, reason: 'mismatch' });
  });
  it('reports missing and malformed headers', () => {
    expect(verifyRequest({ ...base, header: undefined })).toEqual({ ok: false, reason: 'missing' });
    expect(verifyRequest({ ...base, header: 'garbage' })).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('inbound events', () => {
  it('every recorded event has the fields Atlas reads', () => {
    for (const c of INBOUND_EVENT_CASES) expect(validateInboundEvent(c.event)).toEqual([]);
  });
  it('flags an event without a topic or data', () => {
    expect(validateInboundEvent({ data: {} })).toContain('$.topic: missing');
    expect(validateInboundEvent({ topic: 'referral.voided' })).toContain('$.data: missing');
  });
  it('signs like Standard Webhooks', () => {
    const c = INBOUND_EVENT_CASES[0]!;
    const signed = signInboundEvent(c, { secret: 'whsec_c2VjcmV0', nowSeconds: 1_760_000_000, deliveryId: 'msg_1' });
    expect(signed.headers['webhook-signature']).toBe(standardWebhookSignature('whsec_c2VjcmV0', 'msg_1', 1_760_000_000, signed.body));
  });
});

describe('matchShape', () => {
  it('handles unions, optional keys and arrays', () => {
    expect(matchShape({ a: null, b: [1] }, { a: 'string|null', 'c?': 'string', b: ['number'] })).toEqual([]);
    expect(matchShape({ b: ['x'] }, { b: ['number'] })).toEqual(['$.b[0]: expected number, got string']);
    expect(matchShape('x', { a: 'string' })).toEqual(['$: expected object, got string']);
  });
});

/** A receiver for the generic webhook protocol: any platform, no Referalli specifics. */
function webhookLike(opts: { badSignatureIs404?: boolean } = {}): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const send = (status: number, body: unknown = {}) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    const id = String(req.headers['atlas-id'] ?? '');
    const ts = Number(req.headers['atlas-timestamp']);
    const expected = `v1,${createHmac('sha256', SECRET).update(`${id}.${ts}.${raw}`).digest('base64')}`;
    if (!id || req.headers['atlas-signature'] !== expected || Math.abs(Date.now() - ts) > 300_000) {
      return send(opts.badSignatureIs404 ? 404 : 401, { error: 'bad signature' });
    }
    const op = (req.url ?? '').slice(1);
    const body = JSON.parse(raw) as { op?: string; customerRef?: string };
    const expectedOp = { signups: 'signup', erase: 'erase', export: 'export', partners: 'partner', signals: 'signal', users: 'user', aliases: 'alias', ping: 'ping' }[op];
    if (body.op !== expectedOp) return send(400, { error: 'op mismatch' });
    if (op === 'signups') return send(200, { referral: null, partner: null });
    if (op === 'partners' || op === 'signals' || op === 'users') return send(501);
    if (op === 'ping') return send(404);
    return send(200);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

describe('the generic webhook profile (any platform)', () => {
  it('passes a platform that implements the generic protocol', async () => {
    const { server, baseUrl } = await webhookLike();
    running = server;
    const report = await runConformance({ profile: 'webhook', baseUrl, connectionId: '', secret: SECRET });
    expect(report.results.filter((r) => r.outcome !== 'pass').map((r) => [r.id, r.problems])).toEqual([]);
    expect(report.results.length).toBeGreaterThan(8);
  });
  it('fails a platform that answers 404 to a bad signature', async () => {
    const { server, baseUrl } = await webhookLike({ badSignatureIs404: true });
    running = server;
    const report = await runConformance({ profile: 'webhook', baseUrl, connectionId: '', secret: SECRET, only: ['webhook.bad_signature_is_401'] });
    expect(report.ok).toBe(false);
  });
});

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose';
import { EventEmitter } from 'node:events';
import {
  expressBackchannelLogout,
  fastifyBackchannelLogout,
  fastifyBackchannelLogoutPlugin,
  handleBackchannelLogout,
  nextBackchannelLogout,
  readLogoutToken,
  type BackchannelLogoutOptions,
} from './backchannel-handlers';
import { BACKCHANNEL_LOGOUT_EVENT, memoryLogoutReplayStore } from './logout-token';
import type { Jwks } from './jwks-cache';

const ISSUER = 'https://auth.example.test';
const CLIENT_ID = 'client_abc';
const NOW_MS = 1_800_000_000_000;
const now = () => NOW_MS;
const nowSec = Math.floor(NOW_MS / 1000);
let key: KeyLike;
let jwks: Jwks;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  key = privateKey;
  jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] };
});

const mint = (claims: Record<string, unknown> = {}) =>
  new SignJWT({ iss: ISSUER, aud: CLIENT_ID, iat: nowSec, exp: nowSec + 120, jti: `j_${Math.random()}`, sub: 'user_1', sid: 'sess_1', events: { [BACKCHANNEL_LOGOUT_EVENT]: {} }, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: 'logout+jwt' })
    .sign(key);

const opts = (onLogout = vi.fn()): BackchannelLogoutOptions => ({ issuer: ISSUER, clientId: CLIENT_ID, jwks, now, onLogout });

describe('back-channel logout handlers (ATL-D14)', () => {
  it('reads logout_token from a form string, URLSearchParams, a parsed object or a Buffer', () => {
    expect(readLogoutToken('logout_token=abc&x=1')).toBe('abc');
    expect(readLogoutToken(new URLSearchParams({ logout_token: 'p' }))).toBe('p');
    expect(readLogoutToken({ logout_token: 'o' })).toBe('o');
    expect(readLogoutToken(Buffer.from('logout_token=b'))).toBe('b');
    expect(readLogoutToken({})).toBeUndefined();
  });

  it('verifies, calls onLogout with sub and sid, and answers 200 no-store', async () => {
    const onLogout = vi.fn();
    const out = await handleBackchannelLogout(`logout_token=${await mint()}`, opts(onLogout));
    expect(out.status).toBe(200);
    expect(out.headers['cache-control']).toBe('no-store');
    expect(onLogout).toHaveBeenCalledWith(expect.objectContaining({ sub: 'user_1', sid: 'sess_1' }));
  });

  it('answers 400 for a missing or bad token (not retried) and never calls onLogout', async () => {
    const onLogout = vi.fn();
    expect((await handleBackchannelLogout('', opts(onLogout))).status).toBe(400);
    expect((await handleBackchannelLogout(`logout_token=${await mint({ aud: 'someone_else' })}`, opts(onLogout))).status).toBe(400);
    expect(onLogout).not.toHaveBeenCalled();
  });

  it('answers 503 with Retry-After when onLogout fails, and 200 for a replay', async () => {
    const failing = { ...opts(vi.fn().mockRejectedValue(new Error('db down'))), retryAfterSeconds: 7 };
    const out = await handleBackchannelLogout(`logout_token=${await mint()}`, failing);
    expect(out).toMatchObject({ status: 503, headers: { 'retry-after': '7' } });
    const replay = { ...opts(), replayStore: memoryLogoutReplayStore(now) };
    const token = await mint({ jti: 'same' });
    expect((await handleBackchannelLogout({ logout_token: token }, replay)).status).toBe(200);
    expect(JSON.parse((await handleBackchannelLogout({ logout_token: token }, replay)).body)).toMatchObject({ replayed: true });
  });

  it('answers 503 when the keys cannot be loaded', async () => {
    const o = { issuer: ISSUER, clientId: CLIENT_ID, jwksUrl: 'https://keys.example.test/jwks', now, onLogout: vi.fn(), fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch };
    expect((await handleBackchannelLogout(`logout_token=${await mint()}`, o)).status).toBe(503);
  });

  it('Next.js / Fetch handler', async () => {
    const onLogout = vi.fn();
    const POST = nextBackchannelLogout(opts(onLogout));
    const res = await POST(new Request('https://app.example.test/api/bcl', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `logout_token=${await mint()}` }));
    expect(res.status).toBe(200);
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it('Express handler, with a parsed body or a raw stream', async () => {
    const onLogout = vi.fn();
    const handler = expressBackchannelLogout(opts(onLogout));
    const res = () => {
      const r = { code: 0, headers: {} as Record<string, string>, body: '', status(c: number) { r.code = c; return r; }, setHeader(k: string, v: string) { r.headers[k] = v; }, send(b: string) { r.body = b; } };
      return r;
    };
    const parsed = res();
    await handler({ body: { logout_token: await mint() } }, parsed);
    expect(parsed.code).toBe(200);
    const stream = Object.assign(new EventEmitter(), { body: undefined });
    const raw = res();
    const token = await mint();
    const done = handler(stream as never, raw);
    stream.emit('data', `logout_token=${token}`);
    stream.emit('end');
    await done;
    expect(raw.code).toBe(200);
    expect(raw.headers['cache-control']).toBe('no-store');
    expect(onLogout).toHaveBeenCalledTimes(2);
  });

  it('Fastify handler and plugin', async () => {
    const onLogout = vi.fn();
    type Reply = { status: number; sent: string; hdrs: Record<string, string>; code(s: number): Reply; headers(h: Record<string, string>): Reply; send(b: string): Reply };
    const reply = (): Reply => {
      const r: Reply = { status: 0, sent: '', hdrs: {} as Record<string, string>, code(s: number) { r.status = s; return r; }, headers(h: Record<string, string>) { Object.assign(r.hdrs, h); return r; }, send(b: string) { r.sent = b; return r; } };
      return r;
    };
    const r1 = reply();
    await fastifyBackchannelLogout(opts(onLogout))({ body: `logout_token=${await mint()}` }, r1);
    expect(r1.status).toBe(200);

    const routes: Record<string, (req: { body?: unknown }, reply: Reply) => unknown> = {};
    const parsers: string[] = [];
    fastifyBackchannelLogoutPlugin(
      {
        addContentTypeParser: (t) => parsers.push(t),
        hasContentTypeParser: () => false,
        post: (path, h) => { routes[path] = h as never; },
      },
      { ...opts(onLogout), path: '/bcl' },
    );
    expect(parsers).toEqual(['application/x-www-form-urlencoded']);
    const r2 = reply();
    await routes['/bcl']!({ body: `logout_token=${await mint()}` }, r2);
    expect(r2.status).toBe(200);
  });
});

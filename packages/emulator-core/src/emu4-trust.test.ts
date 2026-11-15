/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import { auditChainGenesis, verifyAuditChain } from '@atlasauth/backend';
import { describe, expect, it } from 'vitest';
import type { Engine } from './engine';
import { emu4TrustHandlers } from './handlers/emu4-trust';
import { client, makeEngine } from './test-support';

const b64 = (v: string | Buffer): string => Buffer.from(v).toString('base64url');
const ec = () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { ...pair, jwk: pair.publicKey.export({ format: 'jwk' }) as Record<string, string> };
};
const es256 = (key: KeyObject, header: Record<string, unknown>, payload: Record<string, unknown>): string => {
  const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  return `${input}.${b64(nodeSign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }))}`;
};
const nowS = () => Math.floor(Date.now() / 1000);
const BASE = 'http://emulator.test';
let n = 0;
const dpop = (k: ReturnType<typeof ec>, method: string, path: string): string =>
  es256(k.privateKey, { typ: 'dpop+jwt', alg: 'ES256', jwk: k.jwk }, { jti: `j${++n}-${Math.random()}`, htm: method, htu: `${BASE}${path}`, iat: nowS() });
const reason = (r: { json: any }): string | undefined => r.json?.errors?.[0]?.meta?.reason;

/** An engine with the trust routes served even before the lead wires them into the default handler list. */
const make = (o: Parameters<typeof makeEngine>[0] = {}): Engine => {
  const e = makeEngine(o);
  if (!e.handwritten().some((r) => r.pattern === '/v1/audit/chain')) e.register(emu4TrustHandlers());
  return e;
};
const settle = (call: ReturnType<typeof client>, ms = 61_000) => call('POST', '/__emulator/time/advance', { ms });
const sweep = async (call: ReturnType<typeof client>, settleRows = false) => (await call('POST', '/__emulator/audit_chain/sweep', { settle: settleRows })).json;

// ── audit log and chain ──
describe('audit chain', () => {
  const on = async (interval = 60) => {
    const e = make();
    const call = client(e);
    expect((await call('PUT', '/v1/audit/chain', { enabled: true, checkpoint_interval_seconds: interval })).status).toBe(200);
    return { e, call };
  };
  const writes = async (call: ReturnType<typeof client>, count = 3) => {
    for (let i = 0; i < count; i++) await call('POST', '/v1/users', { email_address: `chain-${i}-${Math.random().toString(36).slice(2)}@example.com` });
  };

  it('is off by default and reports the algorithm and the genesis hash', async () => {
    const e = make();
    const call = client(e);
    const s = (await call('GET', '/v1/audit/chain')).json;
    expect(s).toMatchObject({ object: 'audit_chain', enabled: false, enabled_at: null, head_seq: null, head_hash: null, unchained_rows: 0, genesis_hash: auditChainGenesis(e.instanceId) });
    expect(s.algorithm).toEqual({ row: 'atlas.audit.row.v1', link: 'atlas.audit.link.v1', genesis: 'atlas.audit.genesis.v1', checkpoint_typ: 'audit-checkpoint+jwt' });
    expect((await call('POST', '/v1/audit/chain/verify', {})).status).toBe(404);
    expect((await call('POST', '/v1/audit/chain/checkpoints')).status).toBe(404);
  });

  it('writes leave audit rows named like the real ones, without request bodies', async () => {
    const { e, call } = await on();
    const u = (await call('POST', '/v1/users', { email_address: 'secret-address@example.com', first_name: 'Ada' })).json;
    await call('POST', `/v1/users/${u.id}/ban`);
    await call('GET', '/v1/users');
    const rows = (await call('GET', '/__emulator/audit_chain/rows')).json.data;
    const created = rows.find((r: any) => r.action === 'user.created');
    expect(created).toMatchObject({ actor_type: 'api_key', target_type: 'user', target_id: u.id, metadata: { method: 'POST', path: '/v1/users' } });
    expect(rows.some((r: any) => r.action === 'user.banned' && r.target_id === u.id)).toBe(true);
    expect(rows.some((r: any) => r.action === 'audit_chain.enabled')).toBe(true);
    // reads and the emulator's own controls are not audited, and no row carries the request body
    expect(rows.filter((r: any) => r.metadata.method === 'GET')).toHaveLength(0);
    expect(JSON.stringify(rows)).not.toContain('secret-address');
    expect(e.webhooks.events.length).toBeGreaterThan(0);
  });

  it('links a row only after the settling delay, and the helper links everything now', async () => {
    const { call } = await on();
    await writes(call, 2);
    expect((await call('GET', '/v1/audit/chain/links')).json.data).toHaveLength(0);
    expect((await call('GET', '/v1/audit/chain')).json.head_seq).toBe(0);
    await settle(call);
    const links = (await call('GET', '/v1/audit/chain/links')).json;
    expect(links.data.length).toBeGreaterThanOrEqual(3); // the enable row and two users
    expect(links.data[0]).toMatchObject({ object: 'audit_chain_link', seq: 1 });
    expect(links.data[0].row).toMatchObject({ action: 'audit_chain.enabled' });
    expect(links.next_after_seq).toBe(links.data.length);
    await writes(call, 1);
    expect((await sweep(call, false)).appended).toBe(1);
    expect((await call('GET', '/v1/audit/chain/links?after_seq=2&limit=1')).json).toMatchObject({ has_more: true });
  });

  it('only chains rows written after the chain was turned on', async () => {
    const e = make();
    const call = client(e);
    await writes(call, 2);
    await settle(call, 10);
    await call('PUT', '/v1/audit/chain', { enabled: true });
    await sweep(call, false);
    const links = (await call('GET', '/v1/audit/chain/links')).json.data;
    expect(links.map((l: any) => l.row.action)).toEqual(['audit_chain.enabled']);
  });

  it('verifies, signs checkpoints, and an offline verifier accepts every hash and signature', async () => {
    const { e, call } = await on();
    await writes(call, 4);
    // the first pass over new links signs the first checkpoint on its own
    expect(await sweep(call, false)).toMatchObject({ appended: 5, checkpoint: true, tampered: false });
    await writes(call, 2);
    // the interval has not passed, so the next one is asked for
    expect(await sweep(call, false)).toMatchObject({ appended: 2, checkpoint: false });
    const cp = await call('POST', '/v1/audit/chain/checkpoints');
    expect(cp.status).toBe(201);
    expect(cp.json).toMatchObject({ object: 'audit_chain_checkpoint', alg: 'RS256', seq: 7 });
    // asking again with nothing new returns the same checkpoint
    const again = await call('POST', '/v1/audit/chain/checkpoints');
    expect(again.status).toBe(201);
    expect(again.json.id).toBe(cp.json.id);
    const status = (await call('GET', '/v1/audit/chain')).json;
    expect(status).toMatchObject({ head_seq: 7, last_checkpoint_seq: 7, head_hash: cp.json.link_hash, unchained_rows: 0 });

    const v = (await call('POST', '/v1/audit/chain/verify', {})).json;
    expect(v).toMatchObject({ object: 'audit_chain_verification', ok: true, pruned: 0, first_break: null, done: true, checkpoints: { checked: 2, valid: 2, unverifiable: 0, mismatched: 0 } });
    expect(v.checked).toBe(7);

    const links = (await call('GET', '/v1/audit/chain/links?limit=1000')).json.data;
    const checkpoints = (await call('GET', '/v1/audit/chain/checkpoints')).json;
    expect(checkpoints.jwks_uri).toBe(`${e.issuer}/.well-known/jwks.json`);
    expect(checkpoints.data).toHaveLength(2);
    const offline = await verifyAuditChain({ links, prevLinkHash: auditChainGenesis(e.instanceId), checkpoints: checkpoints.data, jwks: (await e.tokens.jwks()) as any, instanceId: e.instanceId });
    expect(offline).toMatchObject({ ok: true, checkpointsVerified: 2, problems: [] });
    expect(offline.checked).toBe(links.length);
    // the offline check also catches a link edited in transit
    const edited = links.map((l: any) => (l.seq === 3 ? { ...l, row: { ...l.row, action: 'user.deleted' } } : l));
    expect((await verifyAuditChain({ links: edited, prevLinkHash: auditChainGenesis(e.instanceId) })).problems[0]).toEqual({ kind: 'row_modified', seq: 3 });
  });

  it('signs a checkpoint on its own when the interval has passed, and raises an event for it', async () => {
    const { e, call } = await on(60);
    await writes(call, 2);
    await settle(call, 61_000);
    await call('GET', '/v1/audit/chain');
    expect((await call('GET', '/v1/audit/chain/checkpoints')).json.data).toHaveLength(1);
    expect(e.webhooks.events.filter((x) => x.type === 'audit_chain.checkpoint_signed')).toHaveLength(1);
    // nothing new: no second checkpoint
    await settle(call, 120_000);
    await call('GET', '/v1/audit/chain');
    expect((await call('GET', '/v1/audit/chain/checkpoints')).json.data).toHaveLength(1);
  });

  it('detects a modified audit row, a changed link and a removed link, and never checkpoints over them', async () => {
    for (const [kind, expected] of [['row', 'row_modified'], ['link', 'link_mismatch'], ['drop_link', 'gap']] as const) {
      const { call } = await on();
      await writes(call, 4);
      await sweep(call, false); // links 1-5 and the first checkpoint
      await writes(call, 3);
      await sweep(call, false); // links 6-8, not checkpointed yet
      const t = await call('POST', '/__emulator/audit_chain/tamper', { kind, seq: 7 });
      expect(t.status).toBe(200);
      const v = (await call('POST', '/v1/audit/chain/verify', {})).json;
      expect(v.ok).toBe(false);
      expect(v.first_break).toMatchObject({ seq: 7, reason: expected });
      // a checkpoint over the broken part is refused
      const refused = await call('POST', '/v1/audit/chain/checkpoints');
      expect(refused.status).toBe(409);
      expect(refused.json.errors[0].code).toBe('CONFLICT');
    }
  });

  it('raises audit_chain.tamper_detected from the worker instead of signing', async () => {
    const { e, call } = await on(60);
    await writes(call, 2);
    await sweep(call, false); // links 1-3 and the first checkpoint
    await writes(call, 2);
    await sweep(call, false); // links 4-5
    await call('POST', '/__emulator/audit_chain/tamper', { kind: 'row', seq: 4 });
    await settle(call, 61_000);
    const r = await sweep(call, false);
    expect(r).toMatchObject({ tampered: true, checkpoint: false });
    const ev = e.webhooks.events.find((x) => x.type === 'audit_chain.tamper_detected');
    expect(ev?.payload.data).toMatchObject({ object: 'audit_chain', reason: 'row_modified', seq: 4 });
    expect((await call('GET', '/v1/audit/chain/checkpoints')).json.data).toHaveLength(1);
    const rows = (await call('GET', '/__emulator/audit_chain/rows')).json.data;
    expect(rows.some((x: any) => x.action === 'audit_chain.tamper_detected' && x.actor_type === 'system')).toBe(true);
  });

  it('notices a checkpointed link that changed later', async () => {
    const { call } = await on();
    await writes(call, 3);
    await sweep(call, false);
    const cp = (await call('POST', '/v1/audit/chain/checkpoints')).json;
    await call('POST', '/__emulator/audit_chain/tamper', { kind: 'link', seq: cp.seq });
    const v = (await call('POST', '/v1/audit/chain/verify', {})).json;
    expect(v.ok).toBe(false);
    expect(v.checkpoints.mismatched).toBeGreaterThanOrEqual(1);
  });

  it('keeps chaining rows that retention removed', async () => {
    const { call } = await on();
    await writes(call, 3);
    await sweep(call, false);
    await call('POST', '/__emulator/audit_chain/tamper', { kind: 'prune_row', seq: 2 });
    const v = (await call('POST', '/v1/audit/chain/verify', {})).json;
    expect(v).toMatchObject({ ok: true, pruned: 1 });
    const links = (await call('GET', '/v1/audit/chain/links')).json.data;
    expect(links.find((l: any) => l.seq === 2).row).toBeNull();
  });

  it('pages verification with max_links and from_seq', async () => {
    const { call } = await on();
    await writes(call, 5);
    await sweep(call, false);
    const first = (await call('POST', '/v1/audit/chain/verify', { max_links: 2 })).json;
    expect(first).toMatchObject({ ok: true, checked: 2, next_seq: 2, done: false });
    const next = (await call('POST', '/v1/audit/chain/verify', { from_seq: first.next_seq + 1 })).json;
    expect(next).toMatchObject({ ok: true, done: true });
    expect(first.checked + next.checked).toBe((await call('GET', '/v1/audit/chain')).json.head_seq);
    expect((await call('POST', '/v1/audit/chain/verify', { from_seq: 0 })).status).toBe(400);
  });

  it('cannot be turned off, validates its input and needs the audit scopes', async () => {
    const { call } = await on(300);
    const off = await call('PUT', '/v1/audit/chain', { enabled: false });
    expect(off.status).toBe(400);
    expect(off.json.errors[0]).toMatchObject({ param: 'enabled' });
    expect((await call('PUT', '/v1/audit/chain', {})).status).toBe(400);
    expect((await call('PUT', '/v1/audit/chain', { enabled: true, checkpoint_interval_seconds: 5 })).status).toBe(400);
    expect((await call('PUT', '/v1/audit/chain', { enabled: true, checkpoint_interval_seconds: 600 })).json.checkpoint_interval_seconds).toBe(600);
    expect((await call('PUT', '/v1/audit/chain', { enabled: true, nope: 1 }, { 'atlas-strict': 'true' })).json.errors[0].code).toBe('UNKNOWN_FIELD');
    expect((await call('GET', '/v1/audit/chain/links?limit=0')).status).toBe(400);
    expect((await call('GET', '/v1/audit/chain/checkpoints?limit=501')).status).toBe(400);
    const e = make({ secretKeys: [{ key: 'sk_ro', scopes: ['audit:read'] }] });
    const ro = client(e, 'sk_ro');
    expect((await ro('GET', '/v1/audit/chain')).status).toBe(200);
    const denied = await ro('PUT', '/v1/audit/chain', { enabled: true });
    expect(denied.status).toBe(403);
    expect(denied.json.errors[0]).toMatchObject({ code: 'SCOPE_MISSING', meta: { required_scope: 'audit:write' } });
  });

  it('is cleared by an engine reset', async () => {
    const { call } = await on();
    await call('POST', '/__emulator/reset');
    expect((await call('GET', '/v1/audit/chain')).json.enabled).toBe(false);
    expect((await call('GET', '/__emulator/audit_chain/rows')).json.data).toHaveLength(0);
  });
});

// ── one-time capability tickets ──
describe('capability tickets', () => {
  const setup = async () => {
    const e = make();
    const call = client(e);
    const anon = client(e, null);
    const u = (await call('POST', '/v1/users', { email_address: `t-${Math.random().toString(36).slice(2)}@example.com` })).json;
    const s = (await call('POST', '/v1/sessions', { user_id: u.id })).json;
    const asUser = (method: string, path: string, body?: unknown) => anon(method, path, body, { authorization: `Bearer ${s.jwt}` });
    return { e, call, anon, u, s, asUser };
  };

  it('mints once, returns the secret once, and redeems exactly once', async () => {
    const { call } = await setup();
    const t = await call('POST', '/v1/tickets', { payload: { goto: '/billing' }, ttl_seconds: 60 });
    expect(t.status).toBe(201);
    expect(t.json).toMatchObject({ object: 'ticket', single_use: true, bound_user: null, bound_org: null });
    expect(t.json.ticket).toMatch(/^tkt_/);
    const ok = await call('POST', '/v1/tickets/redeem', { ticket: t.json.ticket });
    expect(ok.json).toEqual({ object: 'ticket_redemption', id: t.json.id, payload: { goto: '/billing' }, single_use: true });
    const spent = await call('POST', '/v1/tickets/redeem', { ticket: t.json.ticket });
    expect(spent.status).toBe(404);
    expect((await call('POST', '/v1/tickets/redeem', { ticket: 'tkt_unknown' })).json.errors[0].message).toBe(spent.json.errors[0].message);
  });

  it('requires and clamps the lifetime, validates the body, and expires', async () => {
    const { call } = await setup();
    expect((await call('POST', '/v1/tickets', { payload: {} })).json.errors[0]).toMatchObject({ code: 'VALIDATION_FAILED', param: 'ttl_seconds' });
    expect((await call('POST', '/v1/tickets', { ttl_seconds: -1 })).status).toBe(400);
    expect((await call('POST', '/v1/tickets', { ttl_seconds: 5, single_use: 'yes' })).json.errors[0].param).toBe('single_use');
    expect((await call('POST', '/v1/tickets', { ttl_seconds: 5, bound_user: 7 })).json.errors[0].param).toBe('bound_user');
    expect((await call('POST', '/v1/tickets', { ttl_seconds: 5, bound_org: 7 })).json.errors[0].param).toBe('bound_org');
    expect((await call('POST', '/v1/tickets/redeem', {})).json.errors[0].param).toBe('ticket');
    const long = (await call('POST', '/v1/tickets', { ttl_seconds: 10 * 86_400 })).json;
    expect(long.expires_at - long.created_at).toBe(86_400_000);
    const short = (await call('POST', '/v1/tickets', { ttl_seconds: 30 })).json;
    await settle(call, 31_000);
    expect((await call('POST', '/v1/tickets/redeem', { ticket: short.ticket })).status).toBe(404);
  });

  it('keeps a multi-use ticket alive and refuses a binding mismatch without spending the ticket', async () => {
    const { call, u } = await setup();
    const multi = (await call('POST', '/v1/tickets', { ttl_seconds: 60, single_use: false, payload: { a: 1 } })).json;
    expect((await call('POST', '/v1/tickets/redeem', { ticket: multi.ticket })).status).toBe(200);
    expect((await call('POST', '/v1/tickets/redeem', { ticket: multi.ticket })).status).toBe(200);
    const bound = (await call('POST', '/v1/tickets', { ttl_seconds: 60, bound_user: u.id, bound_org: 'org_x' })).json;
    expect(bound).toMatchObject({ bound_user: u.id, bound_org: 'org_x' });
    const wrong = await call('POST', '/v1/tickets/redeem', { ticket: bound.ticket, for_user: 'user_other', for_org: 'org_x' });
    expect(wrong.status).toBe(403);
    expect(wrong.json.errors[0].code).toBe('FORBIDDEN');
    expect((await call('POST', '/v1/tickets/redeem', { ticket: bound.ticket, for_user: u.id })).status).toBe(403);
    expect((await call('POST', '/v1/tickets/redeem', { ticket: bound.ticket, for_user: u.id, for_org: 'org_x' })).status).toBe(200);
  });

  it('lets a signed-in holder redeem from the browser, as themselves, and proves organization membership', async () => {
    const { call, anon, u, asUser } = await setup();
    const org = (await call('POST', '/v1/organizations', { name: 'Tix' })).json;
    const mine = (await call('POST', '/v1/tickets', { ttl_seconds: 60, bound_user: u.id, payload: { ok: 1 } })).json;
    expect((await anon('POST', '/v1/client/tickets/redeem', { ticket: mine.ticket })).status).toBe(401);
    expect((await asUser('POST', '/v1/client/tickets/redeem', { ticket: mine.ticket })).json).toMatchObject({ object: 'ticket_redemption', payload: { ok: 1 } });
    const other = (await call('POST', '/v1/users', { email_address: `o-${Math.random().toString(36).slice(2)}@example.com` })).json;
    const forOther = (await call('POST', '/v1/tickets', { ttl_seconds: 60, bound_user: other.id })).json;
    expect((await asUser('POST', '/v1/client/tickets/redeem', { ticket: forOther.ticket })).status).toBe(403);
    // the failed attempt did not spend it
    expect((await call('POST', '/v1/tickets/redeem', { ticket: forOther.ticket, for_user: other.id })).status).toBe(200);
    const orgTicket = (await call('POST', '/v1/tickets', { ttl_seconds: 60, bound_org: org.id })).json;
    expect((await asUser('POST', '/v1/client/tickets/redeem', { ticket: orgTicket.ticket, organization_id: org.id })).json.errors[0].message).toBe('You are not a member of that organization.');
    await call('POST', `/v1/organizations/${org.id}/memberships`, { user_id: u.id, role: 'org:member' });
    expect((await asUser('POST', '/v1/client/tickets/redeem', { ticket: orgTicket.ticket, organization_id: org.id })).status).toBe(200);
    expect((await asUser('POST', '/v1/client/tickets/redeem', { ticket: orgTicket.ticket, organization_id: 5 })).status).toBe(400);
  });

  it('audits creation and redemption with the actor, and never the secret', async () => {
    const { call, u, asUser } = await setup();
    const t = (await call('POST', '/v1/tickets', { ttl_seconds: 60, bound_user: u.id })).json;
    await asUser('POST', '/v1/client/tickets/redeem', { ticket: t.ticket });
    const rows = (await call('GET', '/__emulator/audit_chain/rows')).json.data;
    expect(rows.find((r: any) => r.action === 'ticket.created')).toMatchObject({ actor_type: 'api_key', target_type: 'capability_ticket', target_id: t.id });
    expect(rows.find((r: any) => r.action === 'ticket.redeemed')).toMatchObject({ actor_type: 'user', actor_id: u.id });
    expect(JSON.stringify(rows)).not.toContain(t.ticket);
  });
});

// ── trusted devices ──
describe('trusted devices', () => {
  const setup = async () => {
    const e = make();
    const call = client(e);
    const anon = client(e, null);
    const mk = async () => {
      const u = (await call('POST', '/v1/users', { email_address: `d-${Math.random().toString(36).slice(2)}@example.com` })).json;
      // a fresh session per call: session tokens live a minute and some tests move the clock by days
      const as = async (method: string, path: string) => anon(method, path, undefined, { authorization: `Bearer ${(await call('POST', '/v1/sessions', { user_id: u.id })).json.jwt}` });
      return { u, as };
    };
    return { e, call, anon, a: await mk(), b: await mk() };
  };

  it('lists the live devices of the signed-in user, newest first, without the secret', async () => {
    const { call, anon, a, b } = await setup();
    expect((await anon('GET', '/v1/client/me/trusted_devices')).status).toBe(401);
    const d1 = (await call('POST', '/__emulator/trusted_devices', { user_id: a.u.id, device: { browser: 'Firefox', os: 'macOS', ip: '203.0.113.7' } })).json;
    expect(d1.secret).toBeTruthy();
    await settle(call, 1000);
    const d2 = (await call('POST', '/__emulator/trusted_devices', { user_id: a.u.id, ttl_days: 1 })).json;
    await call('POST', '/__emulator/trusted_devices', { user_id: b.u.id });
    const list = (await a.as('GET', '/v1/client/me/trusted_devices')).json;
    expect(list.data.map((x: any) => x.id)).toEqual([d2.id, d1.id]);
    expect(list.data[1]).toMatchObject({ object: 'trusted_device', device: { browser: 'Firefox', os: 'macOS', ip: '203.0.113.7' }, last_used_at: null });
    expect(JSON.stringify(list)).not.toContain(d1.secret);
    // an expired device drops out of the list
    await settle(call, 2 * 86_400_000);
    expect((await a.as('GET', '/v1/client/me/trusted_devices')).json.data.map((x: any) => x.id)).toEqual([d1.id]);
  });

  it('revokes one device or all of them, only the caller\'s own', async () => {
    const { call, a, b } = await setup();
    const da = (await call('POST', '/__emulator/trusted_devices', { user_id: a.u.id })).json;
    await call('POST', '/__emulator/trusted_devices', { user_id: a.u.id });
    const db = (await call('POST', '/__emulator/trusted_devices', { user_id: b.u.id })).json;
    expect((await a.as('DELETE', `/v1/client/me/trusted_devices/${db.id}`)).status).toBe(404);
    expect((await a.as('DELETE', '/v1/client/me/trusted_devices/nope')).json.errors[0].message).toBe('Unknown trusted device.');
    expect((await a.as('DELETE', `/v1/client/me/trusted_devices/${da.id}`)).json).toEqual({ object: 'trusted_device', id: da.id, deleted: true });
    expect((await a.as('DELETE', '/v1/client/me/trusted_devices')).json).toEqual({ object: 'trusted_device', deleted: true, count: 1 });
    expect((await a.as('GET', '/v1/client/me/trusted_devices')).json.data).toHaveLength(0);
    expect((await b.as('GET', '/v1/client/me/trusted_devices')).json.data).toHaveLength(1);
  });

  it('checks a secret like the MFA gate: right user, not expired, not revoked', async () => {
    const { call, a, b } = await setup();
    const d = (await call('POST', '/__emulator/trusted_devices', { user_id: a.u.id, ttl_days: 2 })).json;
    const check = async (user: string, secret: string) => (await call('POST', '/__emulator/trusted_devices/verify', { user_id: user, secret })).json;
    expect(await check(a.u.id, d.secret)).toMatchObject({ trusted: true, id: d.id });
    expect((await a.as('GET', '/v1/client/me/trusted_devices')).json.data[0].last_used_at).not.toBeNull();
    expect((await check(b.u.id, d.secret)).trusted).toBe(false);
    expect((await check(a.u.id, 'wrong')).trusted).toBe(false);
    await settle(call, 3 * 86_400_000);
    expect((await check(a.u.id, d.secret)).trusted).toBe(false);
    expect((await call('POST', '/__emulator/trusted_devices', { user_id: 'user_none' })).status).toBe(404);
    expect((await call('POST', '/__emulator/trusted_devices', { user_id: a.u.id, ttl_days: 0 })).status).toBe(400);
  });
});

// ── sender-constrained sessions ──
describe('session binding', () => {
  const setup = async (mode: 'optional' | 'required' | 'off' = 'optional') => {
    const e = make();
    const call = client(e);
    const anon = client(e, null);
    await call('PUT', '/__emulator/trust/config', { session_binding: { mode } });
    const u = (await call('POST', '/v1/users', { email_address: `b-${Math.random().toString(36).slice(2)}@example.com` })).json;
    const s = (await call('POST', '/v1/sessions', { user_id: u.id })).json;
    const key = ec();
    const bind = (k = key, rt = s.refresh_token, extra: Record<string, string> = {}) =>
      anon('POST', '/v1/client/session_binding', undefined, { 'x-refresh-token': rt, dpop: dpop(k, 'POST', '/v1/client/session_binding'), ...extra });
    const refresh = (rt: string, k?: ReturnType<typeof ec>) =>
      anon('POST', `/v1/client/sessions/${s.id}/tokens`, undefined, { 'x-refresh-token': rt, ...(k ? { dpop: dpop(k, 'POST', `/v1/client/sessions/${s.id}/tokens`) } : {}) });
    return { e, call, anon, u, s, key, bind, refresh };
  };

  it('is off by default: a session refreshes without a proof and the bind route is not there', async () => {
    const e = make();
    const call = client(e);
    const anon = client(e, null);
    expect((await call('GET', '/__emulator/trust/config')).json).toMatchObject({ session_binding: { mode: 'off', require_attestation: false }, device_bound_sessions: false });
    const u = (await call('POST', '/v1/users', { email_address: 'off@example.com' })).json;
    const s = (await call('POST', '/v1/sessions', { user_id: u.id })).json;
    expect((await anon('POST', '/v1/client/session_binding', undefined, { 'x-refresh-token': s.refresh_token })).status).toBe(404);
    expect((await anon('POST', `/v1/client/sessions/${s.id}/tokens`, undefined, { 'x-refresh-token': s.refresh_token })).status).toBe(200);
  });

  it('validates the trust config', async () => {
    const call = client(make());
    expect((await call('PUT', '/__emulator/trust/config', { session_binding: { mode: 'sometimes' } })).status).toBe(400);
    expect((await call('PUT', '/__emulator/trust/config', { session_binding: { require_attestation: 'x' } })).status).toBe(400);
    expect((await call('PUT', '/__emulator/trust/config', { device_bound_sessions: 1 })).status).toBe(400);
    expect((await call('PUT', '/__emulator/trust/config', { session_binding: { mode: 'required' }, app_attestation: true })).json).toMatchObject({ session_binding: { mode: 'required' }, app_attestation: true });
  });

  it('binds a session to a key; refreshing then needs a fresh proof from that key and the token carries cnf.jkt', async () => {
    const { e, call, u, s, key, bind, refresh } = await setup();
    const res = await bind();
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ object: 'session_binding', session_id: s.id, attested: false });
    const jkt = res.json.jkt;
    expect(e.webhooks.events.find((x) => x.type === 'session.bound')?.payload.data).toMatchObject({ session_id: s.id, user_id: u.id, jkt, attested: false });
    expect((await call('GET', '/__emulator/audit_chain/rows')).json.data.find((r: any) => r.action === 'session.bound')).toMatchObject({ actor_type: 'user', actor_id: u.id, target_id: s.id });

    const none = await refresh(s.refresh_token);
    expect(none.status).toBe(401);
    expect(reason(none)).toBe('dpop_binding_required');
    const other = await refresh(s.refresh_token, ec());
    expect(reason(other)).toBe('dpop_binding_required');
    const ok = await refresh(s.refresh_token, key);
    expect(ok.status).toBe(200);
    const claims = ((await e.tokens.verifyAny(ok.json.jwt)) as any).claims;
    expect(claims.cnf).toEqual({ jkt });
    // the BAPI template token of a bound session carries it too
    const tpl = (await call('POST', `/v1/sessions/${s.id}/tokens/session`)).json;
    expect(((await e.tokens.verifyAny(tpl.jwt)) as any).claims.cnf).toEqual({ jkt });
  });

  it('refuses a proof that is replayed, malformed, for another method or url, or stale', async () => {
    const { anon, s, key, bind, refresh } = await setup();
    await bind();
    const path = `/v1/client/sessions/${s.id}/tokens`;
    const proof = dpop(key, 'POST', path);
    const send = (p: string) => anon('POST', path, undefined, { 'x-refresh-token': s.refresh_token, dpop: p });
    const first = await send(proof);
    expect(first.status).toBe(200);
    const replay = await send(proof);
    expect(replay.status).toBe(401);
    expect(reason(replay)).toBe('dpop_proof_invalid');
    expect(replay.json.errors[0].message).toBe('That DPoP proof was already used.');
    expect(reason(await send('not-a-jwt'))).toBe('dpop_proof_invalid');
    expect(reason(await send(dpop(key, 'GET', path)))).toBe('dpop_proof_invalid');
    expect(reason(await send(dpop(key, 'POST', '/v1/client/other')))).toBe('dpop_proof_invalid');
    const stale = es256(key.privateKey, { typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk }, { jti: 'old', htm: 'POST', htu: `${BASE}${path}`, iat: nowS() - 3600 });
    expect(reason(await send(stale))).toBe('dpop_proof_invalid');
  });

  it('is idempotent for the same key, conflicts for another, and needs a live session and a proof', async () => {
    const { anon, s, bind, key } = await setup();
    expect((await bind()).status).toBe(201);
    const again = await bind();
    expect(again.status).toBe(200);
    const conflict = await bind(ec());
    expect(conflict.status).toBe(409);
    expect(reason(conflict)).toBe('already_bound');
    expect((await anon('POST', '/v1/client/session_binding', undefined, { dpop: dpop(key, 'POST', '/v1/client/session_binding') })).status).toBe(401);
    expect((await anon('POST', '/v1/client/session_binding', undefined, { 'x-refresh-token': 'rt_nope', dpop: dpop(key, 'POST', '/v1/client/session_binding') })).status).toBe(401);
    const noProof = await anon('POST', '/v1/client/session_binding', undefined, { 'x-refresh-token': s.refresh_token });
    expect(noProof.status).toBe(400);
    expect(noProof.json.errors[0].param).toBe('dpop');
  });

  it('reads and removes a binding from the backend; the key itself is never returned', async () => {
    const { call, s, key, bind, refresh } = await setup();
    const unbound = (await call('GET', `/v1/sessions/${s.id}/binding`)).json;
    expect(unbound).toMatchObject({ object: 'session_binding', bound: false, jkt: null, bound_at: null });
    const jkt = (await bind()).json.jkt;
    const got = (await call('GET', `/v1/sessions/${s.id}/binding`)).json;
    expect(got).toMatchObject({ bound: true, jkt, alg: 'ES256', attested: false, attestation_provider: null });
    expect(JSON.stringify(got)).not.toContain(key.jwk.x as string);
    expect((await call('GET', '/v1/sessions/sess_none/binding')).status).toBe(404);
    const del = await call('DELETE', `/v1/sessions/${s.id}/binding`);
    expect(del.json).toEqual({ object: 'session_binding', session_id: s.id, bound: false, deleted: true });
    expect((await call('DELETE', `/v1/sessions/${s.id}/binding`)).json.errors[0].message).toBe('This session is not bound.');
    // the session can refresh without a proof again, and bind a new key
    expect((await refresh(s.refresh_token)).status).toBe(200);
    expect((await call('GET', '/__emulator/audit_chain/rows')).json.data.some((r: any) => r.action === 'session.binding_removed' && r.target_id === s.id)).toBe(true);
  });

  it('with mode required, an unbound session cannot refresh until it binds', async () => {
    const { s, bind, refresh, key } = await setup('required');
    const refused = await refresh(s.refresh_token);
    expect(refused.status).toBe(401);
    expect(reason(refused)).toBe('session_binding_required');
    expect((await bind()).status).toBe(201);
    const ok = await refresh(s.refresh_token, key);
    expect(ok.status).toBe(200);
    expect((await refresh(ok.json.refresh_token, key)).status).toBe(200);
  });

  it('can require native app attestation for the binding', async () => {
    const { call, bind } = await setup();
    await call('PUT', '/__emulator/trust/config', { session_binding: { require_attestation: true } });
    const disabled = await bind();
    expect(disabled.status).toBe(422);
    expect(disabled.json.errors[0].code).toBe('STRATEGY_DISABLED');
    await call('PUT', '/__emulator/trust/config', { app_attestation: true });
    const missing = await bind();
    expect(missing.status).toBe(403);
    expect(missing.json.errors[0].code).toBe('APP_ATTESTATION_REQUIRED');
    expect((await bind(ec(), undefined, { 'atlas-attestation': b64('{"p":"windows"}') })).status).toBe(403);
    const good = await bind(ec(), undefined, { 'atlas-attestation': b64('{"p":"ios_dc"}') });
    expect(good.status).toBe(201);
    expect(good.json.attested).toBe(true);
    const sid = good.json.session_id;
    expect((await call('GET', `/v1/sessions/${sid}/binding`)).json).toMatchObject({ attested: true, attestation_provider: 'ios_dc' });
  });
});

// ── device-bound sessions ──
describe('device-bound sessions', () => {
  const setup = async () => {
    const e = make();
    const call = client(e);
    const anon = client(e, null);
    await call('PUT', '/__emulator/trust/config', { device_bound_sessions: true });
    const u = (await call('POST', '/v1/users', { email_address: `dv-${Math.random().toString(36).slice(2)}@example.com` })).json;
    const s = (await call('POST', '/v1/sessions', { user_id: u.id })).json;
    const key = ec();
    const cookieOf = (res: { headers: Headers }, name: string) => new RegExp(`${name}=([^;,\\s]+)`).exec(res.headers.get('set-cookie') ?? '')?.[1];
    const cookies = (rt: string, bound?: string) => `__atlas_rt=${encodeURIComponent(rt)}${bound ? `; __atlas_dbsc=${bound}` : ''}`;
    const refresh = (rt: string, bound?: string) => anon('POST', `/v1/client/sessions/${s.id}/tokens`, undefined, { cookie: cookies(rt, bound) });
    const challenge = async () => (await call('POST', '/__emulator/dbsc/registration', { session_id: s.id })).json.challenge;
    const start = async (jti: string, k = key, rt = s.refresh_token) =>
      anon('POST', '/v1/client/dbsc/start', undefined, { cookie: cookies(rt), 'secure-session-response': es256(k.privateKey, { typ: 'dbsc+jwt', alg: 'ES256' }, { jti, aud: `${BASE}/v1/client/dbsc/start`, iat: nowS(), key: k.jwk }) });
    return { e, call, anon, s, key, cookieOf, refresh, challenge, start, cookies };
  };

  it('offers registration on a cookie refresh, binds the device, then refreshes only next to the bound cookie', async () => {
    const { s, key, anon, call, cookieOf, refresh, challenge, start, cookies } = await setup();
    const first = await refresh(s.refresh_token);
    expect(first.status).toBe(200);
    expect(first.headers.get('secure-session-registration')).toMatch(/^\(ES256 RS256\);path="\/v1\/client\/dbsc\/start";challenge="[^"]+"$/);
    const rt1 = cookieOf(first, '__atlas_rt')!;

    const started = await start(await challenge(), key, decodeURIComponent(rt1));
    expect(started.status).toBe(200);
    expect(started.json).toMatchObject({ session_identifier: s.id, refresh_url: '/v1/client/dbsc/refresh', credentials: [{ type: 'cookie', name: '__atlas_dbsc' }] });
    const bound = cookieOf(started, '__atlas_dbsc')!;
    expect(bound).toBeTruthy();
    // binding it again is refused; so is a start with a wrong challenge or a proof for the wrong audience
    expect((await start(await challenge(), key, decodeURIComponent(rt1))).status).toBe(401);

    const noCookie = await anon('POST', `/v1/client/sessions/${s.id}/tokens`, undefined, { cookie: `__atlas_rt=${rt1}` });
    expect(noCookie.status).toBe(401);
    expect(reason(noCookie)).toBe('device_binding_required');
    const forged = await anon('POST', `/v1/client/sessions/${s.id}/tokens`, undefined, { cookie: cookies(decodeURIComponent(rt1), `${s.id}.9999999999.forged`) });
    expect(reason(forged)).toBe('device_binding_required');
    const withCookie = await refresh(decodeURIComponent(rt1), bound);
    expect(withCookie.status).toBe(200);
    // no longer offered once bound
    expect(withCookie.headers.get('secure-session-registration')).toBeNull();
    expect((await call('GET', '/__emulator/trust/config')).json.device_bound_sessions).toBe(true);
  });

  it('refuses registration with a bad proof, a bad challenge, another session or when the feature is off', async () => {
    const { s, anon, call, challenge, start, key, cookies } = await setup();
    expect((await start('forged-challenge')).status).toBe(401);
    const other = (await call('POST', '/v1/sessions', { user_id: (await call('POST', '/v1/users', { email_address: 'dv2@example.com' })).json.id })).json;
    const otherChallenge = (await call('POST', '/__emulator/dbsc/registration', { session_id: other.id })).json.challenge;
    expect((await start(otherChallenge)).status).toBe(401);
    const wrongTyp = es256(key.privateKey, { typ: 'JWT', alg: 'ES256' }, { jti: await challenge(), aud: `${BASE}/v1/client/dbsc/start`, iat: nowS(), key: key.jwk });
    expect((await anon('POST', '/v1/client/dbsc/start', undefined, { cookie: cookies(s.refresh_token), 'secure-session-response': wrongTyp })).status).toBe(401);
    const wrongAud = es256(key.privateKey, { typ: 'dbsc+jwt', alg: 'ES256' }, { jti: await challenge(), aud: `${BASE}/v1/client/dbsc/refresh`, iat: nowS(), key: key.jwk });
    expect((await anon('POST', '/v1/client/dbsc/start', undefined, { cookie: cookies(s.refresh_token), 'secure-session-response': wrongAud })).status).toBe(401);
    expect((await anon('POST', '/v1/client/dbsc/start', undefined, { 'secure-session-response': wrongAud })).status).toBe(401);
    await call('PUT', '/__emulator/trust/config', { device_bound_sessions: false });
    expect((await anon('POST', '/v1/client/dbsc/start')).status).toBe(404);
    expect((await anon('POST', '/v1/client/dbsc/refresh')).status).toBe(404);
  });

  it('renews the bound cookie with a challenge answered by the registered key, once per challenge', async () => {
    const { s, anon, key, challenge, start, cookieOf } = await setup();
    await start(await challenge());
    const ask = await anon('POST', '/v1/client/dbsc/refresh', undefined, { 'sec-secure-session-id': s.id });
    expect(ask.status).toBe(403);
    const header = ask.headers.get('secure-session-challenge')!;
    const ch = /^"([^"]+)";id="([^"]+)"$/.exec(header)!;
    expect(ch[2]).toBe(s.id);
    const answer = (k = key, jti = ch[1]!) => es256(k.privateKey, { typ: 'dbsc+jwt', alg: 'ES256' }, { jti, aud: `${BASE}/v1/client/dbsc/refresh`, iat: nowS() });
    // a proof signed by another key, or for another challenge, is refused
    expect((await anon('POST', '/v1/client/dbsc/refresh', undefined, { 'sec-secure-session-id': s.id, 'secure-session-response': answer(ec()) })).status).toBe(401);
    expect((await anon('POST', '/v1/client/dbsc/refresh', undefined, { 'sec-secure-session-id': s.id, 'secure-session-response': answer(key, 'other') })).status).toBe(401);
    const ok = await anon('POST', '/v1/client/dbsc/refresh', undefined, { 'sec-secure-session-id': s.id, 'secure-session-response': answer() });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ session_identifier: s.id });
    expect(cookieOf(ok, '__atlas_dbsc')).toBeTruthy();
    // the same challenge cannot be used twice
    expect((await anon('POST', '/v1/client/dbsc/refresh', undefined, { 'sec-secure-session-id': s.id, 'secure-session-response': answer() })).status).toBe(401);
    expect((await anon('POST', '/v1/client/dbsc/refresh', undefined, { 'sec-secure-session-id': 'sess_none' })).status).toBe(401);
  });
});

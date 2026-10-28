import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MigrationEntry } from './schema';
import { generateImportKeyPair, openBundleText } from './transport';
import { MigrationBundleWriter, sessionTokenHash } from './writer';

const keys = generateImportKeyPair();

function writer(options: { strict?: boolean; chunkBytes?: number; warnings?: string[] } = {}) {
  const lines: string[] = [];
  const w = new MigrationBundleWriter({
    source: 'clerk',
    exporter: { name: 'atlas-test', version: '1.2.3' },
    recipient: { kid: 'imk_w', publicKey: keys.publicKey },
    write: (l) => void lines.push(l),
    manifest: { origin: 'acme.clerk.accounts.dev', ...(options.warnings ? { warnings: options.warnings } : {}) },
    strict: options.strict,
    chunkBytes: options.chunkBytes,
    now: () => new Date('2026-10-25T12:00:00Z'),
  });
  const open = () => openBundleText<MigrationEntry>(`${lines.join('\n')}\n`, keys.privateKeyJwk);
  return { w, lines, open };
}

describe('MigrationBundleWriter', () => {
  it('writes manifest, records in order and the end entry with counts', async () => {
    const { w, open } = writer();
    expect(await w.add('organization', { id: 'org_1', name: 'Acme' })).toEqual([]);
    expect(await w.add('user', { id: 'user_1', emails: [{ email: 'a@example.com', verified: true }] })).toEqual([]);
    expect(await w.add('user', { id: 'user_2', username: 'bo' })).toEqual([]);
    expect(await w.add('membership', { organization_id: 'org_1', user_id: 'user_1', role: 'admin' })).toEqual([]);
    w.omit('session', 'expired', 3);
    const summary = await w.finish();
    expect(summary).toEqual({ counts: { organization: 1, user: 2, membership: 1 }, omitted: { session: { count: 3, reason: 'expired' } }, chunks: 1, warnings: [] });

    const entries = open();
    expect(entries[0]).toEqual({
      origin: 'acme.clerk.accounts.dev',
      type: 'manifest',
      format: 'atlas-migration-bundle',
      formatVersion: 1,
      source: 'clerk',
      exportedAt: '2026-10-25T12:00:00.000Z',
      exporter: { name: 'atlas-test', version: '1.2.3' },
      warnings: [],
    });
    expect(entries.slice(1, -1).map((e) => (e.type === 'record' ? `${e.model}:${(e.data as { id?: string }).id ?? ''}` : e.type))).toEqual([
      'organization:org_1',
      'user:user_1',
      'user:user_2',
      'membership:',
    ]);
    expect(entries.at(-1)).toEqual({ type: 'end', counts: { organization: 1, user: 2, membership: 1 }, omitted: { session: { count: 3, reason: 'expired' } } });
  });

  it('refuses a model out of canonical order', async () => {
    const { w } = writer();
    await w.add('membership', { organization_id: 'o', user_id: 'u', role: 'member' });
    await expect(w.add('user', { id: 'u', username: 'x' })).rejects.toThrow(/must be written before "membership"/);
    await expect(w.add('widget' as never, {} as never)).rejects.toThrow(/Unknown model/);
  });

  it('omits an invalid record with its first problem, and does not let it move the order cursor', async () => {
    const { w, open } = writer();
    const issues = await w.add('membership', { organization_id: 'o' } as never);
    expect(issues.map((i) => i.field)).toEqual(['user_id', 'role']);
    // The refused membership did not advance the order: a user may still follow.
    expect(await w.add('user', { id: 'u1', username: 'x' })).toEqual([]);
    await w.add('user', { id: 'u2' } as never);
    const summary = await w.finish();
    expect(summary.counts).toEqual({ user: 1 });
    expect(summary.omitted).toEqual({
      membership: { count: 1, reason: 'invalid record: membership.user_id is required.' },
      user: { count: 1, reason: 'invalid record: A user needs an email, a phone number, a username, or anonymous: true.' },
    });
    expect(open().filter((e) => e.type === 'record')).toHaveLength(1);
  });

  it('strict mode throws on an invalid record', async () => {
    const { w } = writer({ strict: true });
    await expect(w.add('session', { id: 's', user_id: 'u', token_hash: 'nothex', expires_at: 1 })).rejects.toThrow(/Invalid session record/);
  });

  it('keeps the first omit reason per model and sums counts', () => {
    const { w } = writer();
    w.omit('user', 'deleted');
    w.omit('user', 'banned', 2);
    return w.finish().then((s) => expect(s.omitted.user).toEqual({ count: 3, reason: 'deleted' }));
  });

  it('collects warnings before the first record, once each, and refuses them after', async () => {
    const { w, open } = writer({ warnings: ['TOTP secrets are not exportable.'] });
    w.warn('Sessions were skipped.');
    w.warn('Sessions were skipped.');
    w.warn('TOTP secrets are not exportable.');
    await w.add('user', { id: 'u1', username: 'x' });
    expect(() => w.warn('late')).toThrow(/before the first record/);
    const summary = await w.finish();
    expect(summary.warnings).toEqual(['TOTP secrets are not exportable.', 'Sessions were skipped.']);
    expect((open()[0] as { warnings: string[] }).warnings).toEqual(summary.warnings);
  });

  it('splits into several sealed chunks that still open', async () => {
    const { w, open } = writer({ chunkBytes: 64 });
    for (let i = 0; i < 20; i++) await w.add('user', { id: `u${i}`, username: `user-${i}` });
    const summary = await w.finish();
    expect(summary.chunks).toBeGreaterThan(1);
    expect(open().filter((e) => e.type === 'record')).toHaveLength(20);
  });

  it('an empty bundle has a manifest and an end', async () => {
    const { w, open } = writer();
    const summary = await w.finish();
    expect(summary.counts).toEqual({});
    expect(open().map((e) => e.type)).toEqual(['manifest', 'end']);
  });

  it('cannot be finished twice or written after finishing', async () => {
    const { w } = writer();
    await w.finish();
    await expect(w.finish()).rejects.toThrow(/already finished/);
    await expect(w.add('user', { id: 'u', username: 'x' })).rejects.toThrow(/already finished/);
  });
});

describe('sessionTokenHash', () => {
  it('is lowercase hex sha256 of the exact token, as session.token_hash requires', () => {
    expect(sessionTokenHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sessionTokenHash('tok.ü')).toBe(createHash('sha256').update('tok.ü', 'utf8').digest('hex'));
  });
});

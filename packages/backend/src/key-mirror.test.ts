import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { AtlasApiError } from './client/error';
import { createKeyMirror, hashApiKeySecret, memoryKeyMirrorStore } from './key-mirror';

const KEY = {
  object: 'api_key' as const,
  subject_type: 'organization' as const,
  subject_id: 'org_1',
  name: 'CI',
  prefix: 'ak_0123',
  claims: {},
  scopes: ['calls:write'],
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
  created_at: 1,
};

function fakeAtlas() {
  const revoked: { id: string; revoked_at: number }[] = [];
  const api = {
    create: vi.fn(async (body: Record<string, unknown>) =>
      body.import
        ? { ...KEY, id: 'eak_imp', prefix: (body.import as { prefix: string }).prefix }
        : { ...KEY, id: 'eak_new', secret: 'ak_0123_secret', note: '' },
    ),
    delete: vi.fn(async (id: string) => ({ object: 'api_key' as const, id, revoked: true as const })),
    // A two-row-per-page feed whose cursor is the index of the last row served.
    listRevoked: vi.fn(async (q: { since?: string }) => {
      const from = q.since ? Number(q.since) + 1 : 0;
      const page = revoked.slice(from, from + 2);
      return {
        data: page.map((r) => ({ object: 'api_key' as const, ...r })),
        has_more: from + 2 < revoked.length,
        next_cursor: page.length > 0 ? String(from + page.length - 1) : null,
      };
    }),
  };
  return { api, revoked };
}

describe('createKeyMirror', () => {
  it('hashes like sha256 hex', () => {
    expect(hashApiKeySecret('pm')).toBe(createHash('sha256').update('pm').digest('hex'));
  });

  it('mints at Atlas, mirrors the hash, and verifies locally with implications', async () => {
    const { api } = fakeAtlas();
    const store = memoryKeyMirrorStore();
    const mirror = createKeyMirror({
      store,
      apiKeys: api as never,
      scopeImplications: { 'calls:write': ['calls:read'] },
    });
    const made = await mirror.mint({ subject_type: 'organization', subject_id: 'org_1', scopes: ['calls:write'] });
    expect(store.keys.get('eak_new')!.hash).toBe(hashApiKeySecret(made.secret));
    expect(JSON.stringify([...store.keys.values()])).not.toContain('ak_0123_secret');

    const ok = await mirror.verify('ak_0123_secret', { requiredScopes: ['calls:read'] });
    expect(ok).toMatchObject({ valid: true, effective_scopes: ['calls:read', 'calls:write'] });
    expect(await mirror.verify('ak_0123_secret', { requiredScopes: ['leads:read'] })).toEqual({
      valid: false,
      code: 'insufficient_scope',
      missing_scopes: ['leads:read'],
    });
    expect(await mirror.verify('nope')).toEqual({ valid: false });
    expect(await mirror.verify('')).toEqual({ valid: false });
  });

  it('imports by sha256 hex without sending the secret', async () => {
    const { api } = fakeAtlas();
    const store = memoryKeyMirrorStore();
    const mirror = createKeyMirror({ store, apiKeys: api as never });
    await mirror.import({ subject_type: 'organization', subject_id: 'org_1', secret: 'legacy_live_abc', prefix: 'legacy_live_abc'.slice(0, 8) });
    const sent = api.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.import).toEqual({ secret_hash: hashApiKeySecret('legacy_live_abc'), hash_algorithm: 'sha256_hex', prefix: 'legacy_l' });
    expect(JSON.stringify(sent)).not.toContain('legacy_live_abc');
    expect((await mirror.verify('legacy_live_abc')).valid).toBe(true);
    await expect(mirror.import({ subject_type: 'user', subject_id: 'u', secretHash: 'xyz', prefix: 'p' })).rejects.toThrow(TypeError);
  });

  it('revokes locally first, even when the Atlas call fails', async () => {
    const { api } = fakeAtlas();
    const store = memoryKeyMirrorStore();
    const mirror = createKeyMirror({ store, apiKeys: api as never });
    await mirror.mint({ subject_type: 'user', subject_id: 'u' });
    api.delete.mockRejectedValueOnce(new AtlasApiError(503, [{ code: 'UNAVAILABLE', message: 'down' }]));
    await expect(mirror.revoke('eak_new')).rejects.toThrow('down');
    expect((await mirror.verify('ak_0123_secret')).valid).toBe(false);

    // Already revoked / unknown at Atlas counts as done.
    api.delete.mockRejectedValueOnce(new AtlasApiError(404, [{ code: 'NOT_FOUND', message: 'gone' }]));
    await expect(mirror.revoke('eak_new')).resolves.toBeUndefined();
  });

  it('sync() applies an Atlas-side revoke within one tick and resumes from its cursor', async () => {
    const { api, revoked } = fakeAtlas();
    const store = memoryKeyMirrorStore();
    const mirror = createKeyMirror({ store, apiKeys: api as never });
    await mirror.mint({ subject_type: 'user', subject_id: 'u' });
    revoked.push({ id: 'eak_other1', revoked_at: 1 }, { id: 'eak_other2', revoked_at: 2 }, { id: 'eak_new', revoked_at: 3 });
    expect(await mirror.sync()).toEqual({ revoked: 3 });
    expect((await mirror.verify('ak_0123_secret')).valid).toBe(false);
    expect(store.keys.get('eak_new')!.revoked_at).toBe(3);
    // Caught up: the next tick reads from the stored cursor and finds nothing new.
    expect(await mirror.sync()).toEqual({ revoked: 0 });
    expect(await store.getCursor()).toBe('2');
  });

  it('applyWebhook revokes and refreshes keys it holds, ignores the rest', async () => {
    const { api } = fakeAtlas();
    const store = memoryKeyMirrorStore();
    const mirror = createKeyMirror({ store, apiKeys: api as never, now: () => 42 });
    await mirror.mint({ subject_type: 'user', subject_id: 'u' });
    expect(await mirror.applyWebhook({ type: 'api_key.updated', data: { id: 'eak_new', scopes: ['leads:read'], name: 'Renamed' } })).toBe(true);
    expect(store.keys.get('eak_new')).toMatchObject({ scopes: ['leads:read'], name: 'Renamed' });
    expect(await mirror.applyWebhook({ type: 'api_key.updated', data: { id: 'eak_unknown' } })).toBe(false);
    expect(await mirror.applyWebhook({ type: 'user.updated', data: { id: 'eak_new' } })).toBe(false);
    expect(await mirror.applyWebhook({ type: 'api_key.revoked', data: { id: 'eak_new' } })).toBe(true);
    expect(store.keys.get('eak_new')!.revoked_at).toBe(42);
    expect((await mirror.verify('ak_0123_secret')).valid).toBe(false);
  });

  it('refuses an expired key', async () => {
    const { api } = fakeAtlas();
    api.create.mockResolvedValueOnce({ ...KEY, id: 'eak_exp', expires_at: 100, secret: 'ak_exp', note: '' } as never);
    const mirror = createKeyMirror({ store: memoryKeyMirrorStore(), apiKeys: api as never, now: () => 100 });
    await mirror.mint({ subject_type: 'user', subject_id: 'u' });
    expect((await mirror.verify('ak_exp')).valid).toBe(false);
  });
});

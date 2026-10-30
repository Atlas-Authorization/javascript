/**
 * A local, authoritative mirror of end-user API keys (`ak_`), with Atlas as the
 * minting and revocation backstop.
 *
 * Your request path verifies a presented key against the LOCAL row (sha256 hash,
 * scopes, expiry, revocation) with no network call. Atlas mints and imports keys,
 * and is told about every revoke; a revoke made anywhere else (the dashboard, the
 * user's own `<ApiKeys/>`, another service) reaches the mirror through `sync()`,
 * which consumes the `/v1/api_keys/revoked` feed, or `applyWebhook()` for the
 * `api_key.*` webhooks. Revoking locally happens FIRST, so a failed Atlas call
 * never leaves a key usable here.
 *
 * The store interface is the smallest that works: put / get / getByHash /
 * markRevoked and a feed cursor. `memoryKeyMirrorStore()` is an in-memory store
 * for tests and single-process apps; back it with a table in production.
 */
import { createHash } from './edge-crypto';
import type { ApiKey, ApiKeyWithSecret, CreateApiKeyBody, apiKeysResource } from './client/api-keys';

/** What the mirror keeps per key. Never the secret: only its sha256 (hex). */
export interface MirroredApiKey {
  /** The Atlas key id (`eak_…`). */
  id: string;
  /** sha256 of the full secret, lowercase hex. */
  hash: string;
  /** The public head, for listings. */
  prefix: string;
  subject_type: string;
  subject_id: string;
  name: string | null;
  scopes: string[] | null;
  /** Epoch ms; null = never. */
  expires_at: number | null;
  /** Epoch ms; null = live. */
  revoked_at: number | null;
}

export interface KeyMirrorStore {
  put(key: MirroredApiKey): Promise<void>;
  get(id: string): Promise<MirroredApiKey | null>;
  getByHash(hash: string): Promise<MirroredApiKey | null>;
  /** Stamp a key revoked. A no-op for an id the mirror does not hold. */
  markRevoked(id: string, revokedAt: number): Promise<void>;
  /** The revocation-feed cursor last consumed (null = from the start). */
  getCursor(): Promise<string | null>;
  setCursor(cursor: string): Promise<void>;
}

/** An in-memory store, for tests and single-process apps. */
export function memoryKeyMirrorStore(): KeyMirrorStore & { keys: Map<string, MirroredApiKey> } {
  const keys = new Map<string, MirroredApiKey>();
  let cursor: string | null = null;
  return {
    keys,
    async put(key) {
      keys.set(key.id, { ...key });
    },
    async get(id) {
      return keys.get(id) ?? null;
    },
    async getByHash(hash) {
      for (const k of keys.values()) if (k.hash === hash) return k;
      return null;
    },
    async markRevoked(id, revokedAt) {
      const k = keys.get(id);
      if (k && k.revoked_at === null) k.revoked_at = revokedAt;
    },
    async getCursor() {
      return cursor;
    },
    async setCursor(c) {
      cursor = c;
    },
  };
}

type ApiKeysApi = Pick<ReturnType<typeof apiKeysResource>, 'create' | 'delete' | 'listRevoked'>;

export interface KeyMirrorOptions {
  store: KeyMirrorStore;
  /** `createAtlasClient(...).apiKeys` (or anything with the same create / delete / listRevoked). */
  apiKeys: ApiKeysApi;
  /**
   * The instance scope implications (`auth_config.endUserApiKeys.scopeImplications`),
   * so a local `requiredScopes` check matches Atlas verify. `*` = every scope in
   * `allowedScopes` plus both sides of the map.
   */
  scopeImplications?: Record<string, string[]>;
  allowedScopes?: string[];
  /** Clock, for tests. */
  now?: () => number;
}

export type MirrorVerification =
  | { valid: true; key: MirroredApiKey; effective_scopes: string[] }
  | { valid: false; code?: 'insufficient_scope'; missing_scopes?: string[] };

export type MirrorImportInput = Omit<CreateApiKeyBody, 'import' | 'prefix'> & {
  /** The full existing secret (hashed here, never sent) — or its `secretHash`. */
  secret?: string;
  /** sha256 hex of the full secret. */
  secretHash?: string;
  /** The public head shown in listings, e.g. the first 16 characters. */
  prefix: string;
};

/** sha256 hex — the hash the mirror stores and Atlas imports as `sha256_hex`. */
export function hashApiKeySecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function expand(held: string[], implications: Record<string, string[]>, allowed: string[]): string[] {
  const vocab = new Set(allowed);
  for (const [from, tos] of Object.entries(implications)) {
    vocab.add(from);
    for (const t of tos) if (t !== '*') vocab.add(t);
  }
  const out = new Set(held);
  const queue = [...held];
  while (queue.length > 0) {
    for (const to of implications[queue.pop()!] ?? []) {
      for (const t of to === '*' ? vocab : [to]) {
        if (!out.has(t)) {
          out.add(t);
          queue.push(t);
        }
      }
    }
  }
  return [...out].sort();
}

const HEX64 = /^[0-9a-f]{64}$/;

function toMirrored(key: ApiKey, hash: string): MirroredApiKey {
  return {
    id: key.id,
    hash,
    prefix: key.prefix,
    subject_type: key.subject_type,
    subject_id: key.subject_id,
    name: key.name ?? null,
    scopes: key.scopes ?? null,
    expires_at: key.expires_at ?? null,
    revoked_at: key.revoked_at ?? null,
  };
}

export function createKeyMirror(options: KeyMirrorOptions) {
  const { store, apiKeys } = options;
  const now = options.now ?? Date.now;
  const implications = options.scopeImplications ?? {};
  const allowed = options.allowedScopes ?? [];

  return {
    /** Mint at Atlas, then mirror it. Resolves with the one-time `secret`. */
    async mint(body: Omit<CreateApiKeyBody, 'import'>, idempotencyKey?: string): Promise<ApiKeyWithSecret> {
      const created = await apiKeys.create(body, idempotencyKey);
      await store.put(toMirrored(created, hashApiKeySecret(created.secret)));
      return created;
    },

    /**
     * Import an existing key by its sha256 (hex) so customers keep their secret:
     * Atlas stores the hash, the mirror stores the same hash.
     */
    async import(input: MirrorImportInput, idempotencyKey?: string): Promise<ApiKey> {
      const { secret, secretHash, prefix, ...rest } = input;
      const hash = secretHash?.toLowerCase() ?? (secret !== undefined ? hashApiKeySecret(secret) : undefined);
      if (!hash || !HEX64.test(hash)) {
        throw new TypeError('import needs the full `secret` or its `secretHash` (64 lowercase hex characters of sha256).');
      }
      const imported = await apiKeys.create(
        { ...rest, import: { secret_hash: hash, hash_algorithm: 'sha256_hex', prefix } },
        idempotencyKey,
      );
      await store.put(toMirrored(imported, hash));
      return imported;
    },

    /**
     * Revoke LOCALLY first (the key stops working here at once), then at Atlas.
     * A key Atlas already revoked or no longer knows (404/409) counts as revoked;
     * any other Atlas error is thrown after the local revoke, so retry it.
     */
    async revoke(id: string): Promise<void> {
      await store.markRevoked(id, now());
      try {
        await apiKeys.delete(id);
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status !== 404 && status !== 409) throw err;
      }
    },

    /**
     * Verify a presented secret against the mirror — no network call. Unknown,
     * revoked and expired keys all answer `{ valid: false }`.
     */
    async verify(secret: string, opts: { requiredScopes?: string[] } = {}): Promise<MirrorVerification> {
      if (typeof secret !== 'string' || !secret) return { valid: false };
      const key = await store.getByHash(hashApiKeySecret(secret));
      if (!key || key.revoked_at !== null) return { valid: false };
      if (key.expires_at !== null && key.expires_at <= now()) return { valid: false };
      const effective = expand(key.scopes ?? [], implications, allowed);
      const missing = (opts.requiredScopes ?? []).filter((s) => !effective.includes(s));
      if (missing.length > 0) return { valid: false, code: 'insufficient_scope', missing_scopes: missing };
      return { valid: true, key, effective_scopes: effective };
    },

    /**
     * Consume the revocation feed from the stored cursor, revoking each listed key
     * locally. Call it on a timer (every few seconds to a minute): a key revoked at
     * Atlas is rejected here within one tick. Returns how many ids it applied.
     */
    async sync(): Promise<{ revoked: number }> {
      let since = (await store.getCursor()) ?? undefined;
      let revoked = 0;
      for (;;) {
        const page = await apiKeys.listRevoked({ ...(since ? { since } : {}), limit: 100 });
        for (const ref of page.data) {
          await store.markRevoked(ref.id, ref.revoked_at ?? now());
          revoked++;
        }
        if (page.next_cursor) {
          since = page.next_cursor;
          await store.setCursor(since);
        }
        if (!page.has_more || !page.next_cursor) return { revoked };
      }
    },

    /**
     * Apply a VERIFIED `api_key.*` webhook (check the signature first, e.g. with
     * `verifyWebhook`). `api_key.revoked` revokes locally; `api_key.updated`
     * refreshes name, scopes and expiry of a key the mirror holds. The hash never
     * changes, so a key the mirror does not hold is ignored (mint/import adds it).
     * Returns whether the event changed the mirror.
     */
    async applyWebhook(event: { type: string; data: unknown }): Promise<boolean> {
      if (!event || typeof event.type !== 'string' || !event.type.startsWith('api_key.')) return false;
      const data = event.data as Partial<ApiKey> | null;
      if (!data || typeof data.id !== 'string') return false;
      const held = await store.get(data.id);
      if (!held) return false;
      if (event.type === 'api_key.revoked' || (typeof data.revoked_at === 'number' && held.revoked_at === null)) {
        await store.markRevoked(held.id, typeof data.revoked_at === 'number' ? data.revoked_at : now());
        return true;
      }
      if (event.type === 'api_key.updated' || event.type === 'api_key.created') {
        await store.put({
          ...held,
          name: data.name !== undefined ? data.name ?? null : held.name,
          scopes: data.scopes !== undefined ? data.scopes ?? null : held.scopes,
          expires_at: data.expires_at !== undefined ? data.expires_at ?? null : held.expires_at,
        });
        return true;
      }
      return false;
    },
  };
}

export type KeyMirror = ReturnType<typeof createKeyMirror>;

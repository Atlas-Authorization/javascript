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
import { parseAssertion, verifyAssertionSignature } from './api-key-assertion';
import type { ApiKey, ApiKeyAssertionRefusal, ApiKeyImportOutcome, ApiKeyOrganization, ApiKeyRotation, ApiKeyWithSecret, CreateApiKeyBody, RotateApiKeyBody, apiKeysResource } from './client/api-keys';

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
  /** CIDR allowlist; null/absent = any caller. */
  allowed_ips?: string[] | null;
  /** Epoch ms; null = never. */
  expires_at: number | null;
  /** Epoch ms; null = live. */
  revoked_at: number | null;
  /** The organization a user key is bound to; null/absent = unbound. */
  organization_id?: string | null;
  /** Why it was revoked, when Atlas said (`membership_ended`, `creator_departed`, `organization_deleted`, `user_banned`, `rotated`, `signed_out_everywhere`, or the stream's `revoked_by_api` / `revoked_by_admin`). */
  revoked_reason?: string | null;
  /** The key's metadata (what you set as `metadata` / `claims`): your own vocabulary, returned by `verify` with no call to Atlas. */
  metadata?: Record<string, unknown>;
  /** The delegated-token constraints on the key. */
  constraints?: Record<string, unknown>;
  /** The member who created an organization key. */
  created_by_user_id?: string | null;
  /** `sign_out_everywhere` when the key ends with its user's sign-out everywhere. */
  dies_with?: string | null;
  /** `key_pair` for a key whose holder signs assertions; absent/`secret` for an `ak_` key. */
  credential?: 'secret' | 'key_pair';
  /** false while the key is disabled (not revoked): it verifies nothing until re-enabled. Absent = enabled. */
  enabled?: boolean;
  /** Key pair: the public key (SPKI PEM) assertions are verified against. */
  publicKeyPem?: string | null;
  /** Key pair: the `aud` an assertion must carry. */
  audience?: string | null;
  /** Key pair: longest assertion lifetime in seconds; null/absent = 3600. */
  max_token_lifetime_seconds?: number | null;
}

export interface KeyMirrorStore {
  put(key: MirroredApiKey): Promise<void>;
  get(id: string): Promise<MirroredApiKey | null>;
  getByHash(hash: string): Promise<MirroredApiKey | null>;
  /** Stamp a key revoked. A no-op for an id the mirror does not hold. */
  markRevoked(id: string, revokedAt: number, reason?: string | null): Promise<void>;
  /**
   * Stamp every live key of `userId` bound to `organizationId` revoked (reason
   * `membership_ended`). Optional: a store without it still drops those keys through
   * the revocation feed and the `api_key.revoked` webhook Atlas sends for each.
   */
  markMembershipEnded?(userId: string, organizationId: string, revokedAt: number): Promise<void>;
  /**
   * Record an assertion `jti` as used until `expiresAtMs`; resolve false when it was already used (a replay).
   * Optional: without it the mirror keeps used ids in process memory, which a restart or a second instance does not share.
   */
  claimAssertionJti?(keyId: string, jti: string, expiresAtMs: number): Promise<boolean>;
  /** The revocation-feed cursor last consumed (null = from the start). */
  getCursor(): Promise<string | null>;
  setCursor(cursor: string): Promise<void>;
  /** Epoch ms of the last COMPLETED `sync()` (null = never). Optional: without it the mirror keeps it in memory, so a restart reads as never synced. */
  getLastSyncAt?(): Promise<number | null>;
  setLastSyncAt?(at: number): Promise<void>;
}

/** An in-memory store, for tests and single-process apps. */
export function memoryKeyMirrorStore(): KeyMirrorStore & { keys: Map<string, MirroredApiKey> } {
  const keys = new Map<string, MirroredApiKey>();
  let cursor: string | null = null;
  let lastSyncAt: number | null = null;
  const jtis = new Map<string, number>();
  return {
    keys,
    async claimAssertionJti(keyId, jti, expiresAtMs) {
      const t = Date.now();
      for (const [k, exp] of jtis) if (exp <= t) jtis.delete(k);
      const id = `${keyId}\n${jti}`;
      if (jtis.has(id)) return false;
      jtis.set(id, expiresAtMs);
      return true;
    },
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
    async markRevoked(id, revokedAt, reason) {
      const k = keys.get(id);
      if (k && k.revoked_at === null) {
        k.revoked_at = revokedAt;
        if (reason) k.revoked_reason = reason;
      }
    },
    async markMembershipEnded(userId, organizationId, revokedAt) {
      for (const k of keys.values()) {
        if (k.revoked_at === null && k.subject_type === 'user' && k.subject_id === userId && k.organization_id === organizationId) {
          k.revoked_at = revokedAt;
          k.revoked_reason = 'membership_ended';
        }
      }
    },
    async getCursor() {
      return cursor;
    },
    async setCursor(c) {
      cursor = c;
    },
    async getLastSyncAt() {
      return lastSyncAt;
    },
    async setLastSyncAt(at) {
      lastSyncAt = at;
    },
  };
}

type ApiKeysResource = ReturnType<typeof apiKeysResource>;
type ApiKeysApi = Pick<ApiKeysResource, 'create' | 'delete' | 'listRevoked'> & Partial<Pick<ApiKeysResource, 'verify' | 'get' | 'rotate'>>;

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
  /**
   * On a local miss, ask Atlas to verify the secret (needs `apiKeys.verify` and
   * `apiKeys.get`). Required for keys imported with `bcryptHash` / `argon2idHash`,
   * which cannot be checked locally; once Atlas accepts one, the mirror stores its
   * sha256 and verifies it locally from then on. Default false.
   */
  verifyAtAtlas?: boolean;
  /**
   * Freshness bound for the revocation feed. When set, `verify` answers
   * `{ valid: false, code: 'stale' }` (never a plain unknown-key miss) if the mirror
   * has never completed a `sync()` or the last one finished more than this many
   * milliseconds ago, because a key revoked at Atlas may not have reached it yet.
   * 300000 (5 minutes) is a good value when `sync()` runs every few seconds to a
   * minute. Unset (the default) turns the check off, for webhook-only mirrors.
   */
  maxStalenessMs?: number;
  /**
   * Keep answering from the last synced data for this many extra milliseconds after `maxStalenessMs` has passed, instead
   * of refusing with `code: 'stale'` at once. A valid answer inside this grace carries `stale: true`, and
   * `onServeStale` fires, so you can alert while traffic keeps flowing through a short Atlas outage. A key revoked at
   * Atlas during the grace is not seen until the next `sync()`. Default 0: refuse as soon as the mirror is stale.
   * Needs `maxStalenessMs`.
   */
  serveStaleForMs?: number;
  /** Called (not awaited) each time an answer is served inside the `serveStaleForMs` grace. */
  onServeStale?: (info: { lastSyncAt: number | null; staleForMs: number }) => void;
  /**
   * For a key bound to an organization: the user's CURRENT membership, from your own
   * data (return null when they are no longer a member). The key's scopes are narrowed
   * to what the membership's permissions cover, exactly as Atlas verify does. Without
   * it, a bound key is verified at Atlas (needs `apiKeys.verify`); with neither it
   * answers `{ valid: false, code: 'membership_unresolved' }`.
   */
  membership?: (userId: string, organizationId: string) => Promise<ApiKeyOrganization | null> | ApiKeyOrganization | null;
  /** Clock, for tests. */
  now?: () => number;
}

export type MirrorVerification =
  | { valid: true; key: MirroredApiKey; /** The key's metadata, from the mirror: no call to Atlas. */ metadata: Record<string, unknown>; effective_scopes: string[]; /** True when the mirror was past `maxStalenessMs` and this answer came from its last synced data (see `serveStaleForMs`). */ stale?: true; /** A bound key: the membership the scopes were narrowed by. */ organization?: ApiKeyOrganization }
  | { valid: false; code?: 'insufficient_scope' | 'ip_not_allowed' | 'client_ip_required' | 'membership_unresolved'; missing_scopes?: string[] }
  | {
      valid: false;
      /** The mirror is not fresh enough to answer: not synced yet, or last sync older than `maxStalenessMs`. Retry after `sync()`. */
      code: 'stale';
      /** Epoch ms of the last completed sync; null = never. */
      lastSyncAt: number | null;
    };

/** The result of `mirror.import`: the key plus whether Atlas created it or already held it. */
export type MirrorImportResult = ApiKey & { outcome: ApiKeyImportOutcome };

export type MirrorImportInput = Omit<CreateApiKeyBody, 'import' | 'prefix'> & {
  /** The full existing secret (hashed here, never sent) — or its `secretHash`. */
  secret?: string;
  /** sha256 hex of the full secret. */
  secretHash?: string;
  /** An existing bcrypt hash of the full secret (kept as-is; verified at Atlas on first use). */
  bcryptHash?: string;
  /** An existing Argon2id hash of the full secret (same). */
  argon2idHash?: string;
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

function parseIpBytes(text: string): number[] | null {
  const t = text.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) {
    const parts = t.split('.').map(Number);
    return parts.every((n) => n <= 255) ? parts : null;
  }
  if (!t.includes(':') || !/^[0-9a-fA-F:.]+$/.test(t)) return null;
  let head = t;
  let tail: number[] = [];
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t);
  if (v4) {
    const b = parseIpBytes(v4[1]!);
    if (!b) return null;
    tail = b;
    head = t.slice(0, t.length - v4[1]!.length) + '0:0';
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === '' ? [] : h.split(':'));
  const left = groups(halves[0]!);
  const right = halves.length === 2 ? groups(halves[1]!) : [];
  const fill = 8 - left.length - right.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = [...left, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...right];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const out = all.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
  if (tail.length) out.splice(12, 4, ...tail);
  return out;
}

/** Whether `ip` is inside one of the addresses / CIDR ranges. Unparseable input is never inside. */
export function ipInAllowlist(ip: string, cidrs: readonly string[]): boolean {
  const addr = parseIpBytes(ip);
  if (!addr) return false;
  return cidrs.some((entry) => {
    const [base, bitsText] = entry.trim().split('/');
    const net = parseIpBytes(base ?? '');
    if (!net || net.length !== addr.length) return false;
    const bits = bitsText === undefined ? net.length * 8 : Number(bitsText);
    if (!Number.isInteger(bits) || bits < 0 || bits > net.length * 8) return false;
    for (let i = 0; i < net.length; i++) {
      const n = Math.min(8, Math.max(0, bits - i * 8));
      const mask = (0xff << (8 - n)) & 0xff;
      if ((addr[i]! & mask) !== (net[i]! & mask)) return false;
    }
    return true;
  });
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
    allowed_ips: key.allowed_ips ?? null,
    expires_at: key.expires_at ?? null,
    revoked_at: key.revoked_at ?? null,
    enabled: key.enabled ?? true,
    organization_id: key.organization_id ?? null,
    revoked_reason: key.revoked_reason ?? null,
    metadata: key.metadata ?? key.claims ?? {},
    constraints: (key as { constraints?: Record<string, unknown> }).constraints ?? {},
    created_by_user_id: key.created_by_user_id ?? null,
    dies_with: key.dies_with ?? null,
    credential: key.credential ?? 'secret',
    publicKeyPem: key.public_key ?? null,
    audience: key.audience ?? null,
    max_token_lifetime_seconds: key.max_token_lifetime_seconds ?? null,
  };
}

/** A key-pair row has no secret to hash; this can never equal a sha256 hex, so it never matches a bearer. */
const keyPairHash = (key: ApiKeyWithSecret) => (key.secret === null ? `kp:${key.id}` : hashApiKeySecret(key.secret));

export type MirrorAssertionVerification =
  | { valid: true; key: MirroredApiKey; metadata: Record<string, unknown>; effective_scopes: string[]; credential: 'key_pair'; jti?: string; /** The assertion's `exp`, epoch seconds. */ exp: number; stale?: true; organization?: ApiKeyOrganization }
  | { valid: false; code?: ApiKeyAssertionRefusal | 'insufficient_scope' | 'ip_not_allowed' | 'client_ip_required' | 'membership_unresolved'; missing_scopes?: string[] }
  | { valid: false; code: 'stale'; lastSyncAt: number | null };

/** Whether a permission covers a key scope: same name, `*`, or `<prefix>:*`. Mirrors Atlas verify. */
export function permissionCoversScope(permission: string, scope: string): boolean {
  if (permission === scope || permission === '*') return true;
  return permission.endsWith(':*') && scope.startsWith(permission.slice(0, -1));
}

/**
 * The key scopes a membership's permissions cover: what Atlas returns as
 * `effective_scopes` for a key bound to an organization. Sorted.
 */
export function intersectScopesWithPermissions(scopes: readonly string[], permissions: readonly string[]): string[] {
  return [...new Set(scopes.filter((s) => permissions.some((p) => permissionCoversScope(p, s))))].sort();
}

export function createKeyMirror(options: KeyMirrorOptions) {
  const { store, apiKeys } = options;
  const now = options.now ?? Date.now;
  const implications = options.scopeImplications ?? {};
  const allowed = options.allowedScopes ?? [];
  let memorySyncAt: number | null = null;
  const readSyncAt = async () => (store.getLastSyncAt ? await store.getLastSyncAt() : memorySyncAt);
  const usedJtis = new Map<string, number>();

  /** The maxStalenessMs / serveStaleForMs gate shared by every verify: a refusal, or whether to mark the answer stale. */
  async function freshness(): Promise<{ refuse: { valid: false; code: 'stale'; lastSyncAt: number | null } } | { servedStale: boolean }> {
    if (options.maxStalenessMs === undefined) return { servedStale: false };
    const lastSyncAt = await readSyncAt();
    const behind = lastSyncAt === null ? Infinity : now() - lastSyncAt - options.maxStalenessMs;
    if (behind <= 0) return { servedStale: false };
    if (lastSyncAt === null || behind > (options.serveStaleForMs ?? 0)) return { refuse: { valid: false, code: 'stale', lastSyncAt } };
    options.onServeStale?.({ lastSyncAt, staleForMs: behind });
    return { servedStale: true };
  }

  return {
    /** Mint at Atlas, then mirror it. Resolves with the one-time `secret`. */
    async mint(body: Omit<CreateApiKeyBody, 'import'>, idempotencyKey?: string): Promise<ApiKeyWithSecret> {
      const created = await apiKeys.create(body, idempotencyKey);
      await store.put(toMirrored(created, keyPairHash(created)));
      return created;
    },

    /**
     * Rotate at Atlas, then mirror both sides: the successor is added, and the old key now ends at the
     * end of the overlap (or is revoked at once when `overlap_seconds` is 0). Resolves with the successor's
     * one-time `secret`. Needs `apiKeys.rotate`.
     */
    async rotate(id: string, body: RotateApiKeyBody = {}, idempotencyKey?: string): Promise<ApiKeyRotation> {
      if (!apiKeys.rotate) throw new TypeError('rotate needs an apiKeys client with rotate().');
      const rotated = await apiKeys.rotate(id, body, idempotencyKey);
      await store.put(toMirrored(rotated, keyPairHash(rotated)));
      const old = await store.get(id);
      if (old) {
        if (rotated.previous_key.revoked) await store.markRevoked(id, now(), 'rotated');
        else await store.put({ ...old, expires_at: rotated.previous_key.expires_at ?? old.expires_at });
      }
      return rotated;
    },

    /**
     * Import an existing key by its sha256 (hex) so customers keep their secret:
     * Atlas stores the hash, the mirror stores the same hash.
     */
    async import(input: MirrorImportInput, idempotencyKey?: string): Promise<MirrorImportResult> {
      const { secret, secretHash, bcryptHash, argon2idHash, prefix, ...rest } = input;
      const legacy = bcryptHash ?? argon2idHash;
      if (legacy !== undefined) {
        const imported = (await apiKeys.create(
          { ...rest, import: { secret_hash: legacy, hash_algorithm: bcryptHash !== undefined ? 'bcrypt' : 'argon2id', prefix } },
          idempotencyKey,
        )) as ApiKey & { outcome?: ApiKeyImportOutcome };
        // No local sha256 yet: `verify` (with verifyAtAtlas) fills it in on first use.
        // A retry that answered already_present keeps a sha256 the mirror already learned.
        if (imported.outcome !== 'already_present' || !(await store.get(imported.id))) {
          await store.put(toMirrored(imported, `legacy:${imported.id}`));
        }
        return { ...imported, outcome: imported.outcome ?? 'created' };
      }
      const hash = secretHash?.toLowerCase() ?? (secret !== undefined ? hashApiKeySecret(secret) : undefined);
      if (!hash || !HEX64.test(hash)) {
        throw new TypeError('import needs the full `secret` or its `secretHash` (64 lowercase hex characters of sha256).');
      }
      const imported = (await apiKeys.create(
        { ...rest, import: { secret_hash: hash, hash_algorithm: 'sha256_hex', prefix } },
        idempotencyKey,
      )) as ApiKey & { outcome?: ApiKeyImportOutcome };
      await store.put(toMirrored(imported, hash));
      return { ...imported, outcome: imported.outcome ?? 'created' };
    },

    /** Epoch ms of the last completed `sync()`; null = never synced. */
    lastSyncAt: readSyncAt,

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
     * revoked and expired keys all answer `{ valid: false }`; a mirror that is not
     * fresh (see `maxStalenessMs`) answers `code: 'stale'` instead.
     */
    async verify(secret: string, opts: { requiredScopes?: string[]; clientIp?: string } = {}): Promise<MirrorVerification> {
      if (typeof secret !== 'string' || !secret) return { valid: false };
      const fresh = await freshness();
      if ('refuse' in fresh) return fresh.refuse;
      const servedStale = fresh.servedStale;
      const hash = hashApiKeySecret(secret);
      let key = await store.getByHash(hash);
      if (!key && options.verifyAtAtlas && apiKeys.verify && apiKeys.get) {
        const remote = await apiKeys.verify(secret, opts.clientIp ? { client_ip: opts.clientIp } : {});
        if (remote.valid) {
          key = toMirrored(await apiKeys.get(remote.id), hash);
          await store.put(key);
        }
      }
      if (!key || key.revoked_at !== null || key.enabled === false) return { valid: false };
      if (key.expires_at !== null && key.expires_at <= now()) return { valid: false };
      // A key with allowed_ips needs the end caller's address; no address fails closed.
      if (key.allowed_ips && key.allowed_ips.length > 0) {
        if (!opts.clientIp) return { valid: false, code: 'client_ip_required' };
        if (!ipInAllowlist(opts.clientIp, key.allowed_ips)) return { valid: false, code: 'ip_not_allowed' };
      }
      let effective = expand(key.scopes ?? [], implications, allowed);
      let organization: ApiKeyOrganization | undefined;
      if (key.subject_type === 'user' && key.organization_id) {
        // A bound key stands for the user's CURRENT membership; never answer from the key's own scopes.
        if (options.membership) {
          const held = await options.membership(key.subject_id, key.organization_id);
          if (!held) return { valid: false };
          organization = held;
          effective = intersectScopesWithPermissions(effective, held.permissions);
        } else if (apiKeys.verify) {
          const remote = await apiKeys.verify(secret, opts.clientIp ? { client_ip: opts.clientIp } : {});
          if (!remote.valid || !remote.organization) return { valid: false };
          organization = remote.organization;
          effective = remote.effective_scopes ?? [];
        } else {
          return { valid: false, code: 'membership_unresolved' };
        }
      }
      const missing = (opts.requiredScopes ?? []).filter((s) => !effective.includes(s));
      if (missing.length > 0) return { valid: false, code: 'insufficient_scope', missing_scopes: missing };
      return { valid: true, key, metadata: key.metadata ?? {}, effective_scopes: effective, ...(organization ? { organization } : {}), ...(servedStale ? { stale: true as const } : {}) };
    },

    /**
     * Verify a key-pair assertion (the JWT from `signApiKeyAssertion`) locally, with the checks
     * Atlas verify makes: signature (ES256 raw r||s or EdDSA, matching the stored key), `iss` = `kid`,
     * `aud`, `iat`, `exp` and the lifetime cap, `nbf`, single-use `jti` (via the store's
     * `claimAssertionJti`, else in memory), `scope` (a subset of the key's, narrows the result),
     * then revocation, expiry and the IP allowlist. A key not in the mirror answers `{ valid: false }`.
     */
    async verifyAssertion(jwt: string, opts: { requiredScopes?: string[]; clientIp?: string } = {}): Promise<MirrorAssertionVerification> {
      const fresh = await freshness();
      if ('refuse' in fresh) return fresh.refuse;
      const parsed = parseAssertion(jwt);
      if (!parsed) return { valid: false, code: 'invalid_assertion' };
      const { header, claims } = parsed;
      if (typeof header.kid !== 'string' || !header.kid) return { valid: false, code: 'invalid_assertion' };
      const key = await store.get(header.kid);
      if (!key) return { valid: false };
      if (key.credential !== 'key_pair' || !key.publicKeyPem) return { valid: false, code: 'invalid_assertion' };
      if (!(await verifyAssertionSignature(parsed, key.publicKeyPem)) || claims.iss !== header.kid) return { valid: false, code: 'invalid_assertion' };
      if (key.revoked_at !== null || key.enabled === false) return { valid: false };
      const nowMs = now();
      if (key.expires_at !== null && key.expires_at <= nowMs) return { valid: false };
      const nowS = Math.floor(nowMs / 1000);
      const { aud, iat, exp, nbf, jti, scope } = claims;
      if (!(typeof aud === 'string' ? aud === key.audience : Array.isArray(aud) && aud.includes(key.audience))) return { valid: false, code: 'wrong_audience' };
      if (typeof iat !== 'number' || typeof exp !== 'number' || (nbf !== undefined && typeof nbf !== 'number')) return { valid: false, code: 'invalid_assertion' };
      if (jti !== undefined && (typeof jti !== 'string' || !jti)) return { valid: false, code: 'invalid_assertion' };
      if (scope !== undefined && typeof scope !== 'string') return { valid: false, code: 'invalid_assertion' };
      if (iat > nowS + 60 || (nbf !== undefined && nbf > nowS + 60)) return { valid: false, code: 'assertion_not_yet_valid' };
      if (exp <= nowS - 30) return { valid: false, code: 'assertion_expired' };
      if (exp - iat > Math.min(key.max_token_lifetime_seconds ?? 3600, 86400)) return { valid: false, code: 'assertion_lifetime_too_long' };
      if (key.allowed_ips && key.allowed_ips.length > 0) {
        if (!opts.clientIp) return { valid: false, code: 'client_ip_required' };
        if (!ipInAllowlist(opts.clientIp, key.allowed_ips)) return { valid: false, code: 'ip_not_allowed' };
      }
      let effective = expand(key.scopes ?? [], implications, allowed);
      let organization: ApiKeyOrganization | undefined;
      if (key.subject_type === 'user' && key.organization_id) {
        const held = options.membership ? await options.membership(key.subject_id, key.organization_id) : undefined;
        if (held === undefined) return { valid: false, code: 'membership_unresolved' };
        if (!held) return { valid: false };
        organization = held;
        effective = intersectScopesWithPermissions(effective, held.permissions);
      }
      if (typeof scope === 'string' && scope.trim()) {
        const asked = scope.trim().split(/\s+/);
        const missing = asked.filter((x) => !effective.includes(x));
        if (missing.length > 0) return { valid: false, code: 'scope_not_granted', missing_scopes: missing };
        effective = effective.filter((x) => asked.includes(x));
      }
      const missing = (opts.requiredScopes ?? []).filter((x) => !effective.includes(x));
      if (missing.length > 0) return { valid: false, code: 'insufficient_scope', missing_scopes: missing };
      // Last, so a refused assertion never burns its jti.
      if (typeof jti === 'string') {
        const until = exp * 1000;
        let first: boolean;
        if (store.claimAssertionJti) first = await store.claimAssertionJti(key.id, jti, until);
        else {
          for (const [k, t] of usedJtis) if (t <= nowMs) usedJtis.delete(k);
          const id = `${key.id}\n${jti}`;
          first = !usedJtis.has(id);
          if (first) usedJtis.set(id, until);
        }
        if (!first) return { valid: false, code: 'assertion_replayed' };
      }
      return { valid: true, key, metadata: key.metadata ?? {}, effective_scopes: effective, credential: 'key_pair', ...(typeof jti === 'string' ? { jti } : {}), exp, ...(organization ? { organization } : {}), ...(fresh.servedStale ? { stale: true as const } : {}) };
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
          await store.markRevoked(ref.id, ref.revoked_at ?? now(), ref.revoked_reason ?? null);
          revoked++;
        }
        if (page.next_cursor) {
          since = page.next_cursor;
          await store.setCursor(since);
        }
        if (!page.has_more || !page.next_cursor) {
          memorySyncAt = now();
          await store.setLastSyncAt?.(memorySyncAt);
          return { revoked };
        }
      }
    },

    /**
     * Apply a VERIFIED `api_key.*` webhook (check the signature first, e.g. with
     * `verifyWebhook`). `api_key.revoked` revokes locally; `api_key.restored` lifts a revocation a ban caused; `api_key.updated`
     * refreshes name, scopes and expiry of a key the mirror holds. The hash never
     * changes, so a key the mirror does not hold is ignored (mint/import adds it).
     * Returns whether the event changed the mirror.
     */
    async applyWebhook(event: { type: string; data: unknown }): Promise<boolean> {
      // A member removed from an organization: drop the keys bound to that membership at once.
      if (event?.type === 'organization_membership.deleted' || event?.type === 'organizationMembership.deleted') {
        const m = event.data as { user_id?: unknown; organization_id?: unknown } | null;
        if (m && typeof m.user_id === 'string' && typeof m.organization_id === 'string' && store.markMembershipEnded) {
          await store.markMembershipEnded(m.user_id, m.organization_id, now());
          return true;
        }
        return false;
      }
      if (!event || typeof event.type !== 'string' || !event.type.startsWith('api_key.')) return false;
      const data = event.data as Partial<ApiKey> | null;
      if (!data || typeof data.id !== 'string') return false;
      const held = await store.get(data.id);
      if (!held) return false;
      // A key a ban had suspended works again: lift the local revocation.
      if (event.type === 'api_key.restored') {
        if (held.revoked_at === null) return false;
        await store.put({
          ...held,
          revoked_at: null,
          revoked_reason: null,
          expires_at: data.expires_at !== undefined ? data.expires_at ?? null : held.expires_at,
        });
        return true;
      }
      if (event.type === 'api_key.revoked' || (typeof data.revoked_at === 'number' && held.revoked_at === null)) {
        await store.markRevoked(held.id, typeof data.revoked_at === 'number' ? data.revoked_at : now(), data.revoked_reason ?? null);
        return true;
      }
      if (event.type === 'api_key.updated' || event.type === 'api_key.created') {
        await store.put({
          ...held,
          name: data.name !== undefined ? data.name ?? null : held.name,
          scopes: data.scopes !== undefined ? data.scopes ?? null : held.scopes,
          allowed_ips: data.allowed_ips !== undefined ? data.allowed_ips ?? null : held.allowed_ips ?? null,
          expires_at: data.expires_at !== undefined ? data.expires_at ?? null : held.expires_at,
          metadata: data.metadata ?? data.claims ?? held.metadata ?? {},
          constraints: (data as { constraints?: Record<string, unknown> }).constraints ?? held.constraints ?? {},
          dies_with: data.dies_with !== undefined ? data.dies_with ?? null : held.dies_with ?? null,
          // Disabling is not a revocation, so it reaches the mirror only through this event.
          enabled: typeof data.enabled === 'boolean' ? data.enabled : held.enabled,
        });
        return true;
      }
      return false;
    },
  };
}

export type KeyMirror = ReturnType<typeof createKeyMirror>;

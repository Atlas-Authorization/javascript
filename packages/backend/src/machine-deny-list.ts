import type { MachineTokenClaims } from './credential-verify';
import type { RevokedMachineRef } from './client/machines';

/**
 * A deny list for machine tokens, so a revoked machine (or a machine grant that ended) stops verifying within
 * seconds instead of at the token's expiry. Machine tokens verify offline against the instance keys; this is the
 * one check that needs Atlas to tell you something happened.
 *
 * - a revoked machine denies every token with that `sub` issued at or before the revocation;
 * - an ended grant denies tokens with that `sub` AND that `aud` (the resource server) issued at or before it.
 *
 * Tokens issued AFTER the revocation are not denied: a machine that was revoked and later approved again mints
 * fresh tokens that work. Entries are dropped once no token that could be live is left (`maxTokenLifetimeSeconds`).
 *
 * Feed it from `createRevocationMirror` (push, within seconds) and/or call `sync()` on a slow timer to reconcile
 * from the `/v1/machines/revoked` feed (after an outage, and as the backstop).
 */
export interface MachineDenyListOptions {
  /** `createAtlasClient(...).machines`, or anything with `listRevoked`. Needed for `sync()`. */
  machines?: { listRevoked(query: { since?: string; limit?: number }): Promise<{ data: RevokedMachineRef[]; has_more: boolean; next_cursor: string | null }> };
  /** Your longest machine token lifetime in seconds (Atlas issues up to 600). An entry is remembered this long. Default 900. */
  maxTokenLifetimeSeconds?: number;
  now?: () => number;
}

export interface MachineDenyList {
  /** Record one feed entry (a revoked machine, or an ended machine grant). */
  apply(ref: RevokedMachineRef): void;
  /** True when the token's machine (or its grant for the token's audience) was revoked at or after the token was issued. Pass to `verifyMachineToken({ isRevoked })`. */
  isRevoked(claims: Pick<MachineTokenClaims, 'sub' | 'aud' | 'iat'>): boolean;
  /** Pull the `/v1/machines/revoked` feed from the last cursor. Returns how many entries it applied. */
  sync(): Promise<{ applied: number }>;
  /** Whether `sync()` can run (a `machines` client was given). */
  readonly canSync: boolean;
  /** Number of entries held (for tests and metrics). */
  size(): number;
}

export function createMachineDenyList(options: MachineDenyListOptions = {}): MachineDenyList {
  const now = options.now ?? Date.now;
  const lifetimeMs = (options.maxTokenLifetimeSeconds ?? 900) * 1000;
  /** machine id -> revoked_at (ms) */
  const machines = new Map<string, number>();
  /** `${machine id}\n${audience}` -> ended_at (ms) */
  const grants = new Map<string, number>();
  let cursor: string | undefined;

  const prune = () => {
    const floor = now() - lifetimeMs;
    for (const [k, at] of machines) if (at < floor) machines.delete(k);
    for (const [k, at] of grants) if (at < floor) grants.delete(k);
  };
  const keep = (map: Map<string, number>, key: string, at: number) => map.set(key, Math.max(map.get(key) ?? 0, at));

  const list: MachineDenyList = {
    apply(ref) {
      if (ref.object === 'machine') keep(machines, ref.id, ref.revoked_at);
      else if (ref.object === 'machine_grant') keep(grants, `${ref.machine_id}\n${ref.audience}`, ref.revoked_at);
    },
    isRevoked(claims) {
      prune();
      const issuedAt = typeof claims.iat === 'number' ? claims.iat * 1000 : 0;
      const m = machines.get(claims.sub);
      // Compared at second resolution: `iat` has no milliseconds, so a token minted in the revoking second is denied too.
      if (m !== undefined && issuedAt <= m) return true;
      for (const aud of Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : []) {
        const g = grants.get(`${claims.sub}\n${aud}`);
        if (g !== undefined && issuedAt <= g) return true;
      }
      return false;
    },
    async sync() {
      if (!options.machines) throw new TypeError('sync needs a `machines` client with listRevoked().');
      let applied = 0;
      for (;;) {
        const page = await options.machines.listRevoked({ ...(cursor ? { since: cursor } : {}), limit: 100 });
        for (const ref of page.data) {
          list.apply(ref);
          applied++;
        }
        if (page.next_cursor) cursor = page.next_cursor;
        if (!page.has_more || !page.next_cursor) return { applied };
      }
    },
    canSync: options.machines !== undefined,
    size: () => machines.size + grants.size,
  };
  return list;
}

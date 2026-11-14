import { nextBackchannelLogout, type BackchannelLogoutOptions, type LogoutTokenClaims, type SessionClaims } from '@atlasauth/backend';

/**
 * Sessions your app must treat as signed out because Atlas sent a back-channel logout for them. In memory, bounded and
 * time-limited: a session id is remembered for `ttlSeconds` (default one hour, longer than any session token), a user
 * for the same time after the logout. Pass the same instance to {@link atlasBackchannelLogout} and to
 * `atlasMiddleware({ logoutDenylist })`. Each server instance (or edge isolate) holds its own copy, so for several
 * instances use `revocation` in the middleware as well: it asks Atlas, which is the same for all of them.
 */
export class LogoutDenylist {
  private readonly sids = new Map<string, number>();
  private readonly users = new Map<string, number>();

  constructor(
    private readonly options: { ttlSeconds?: number; maxEntries?: number; now?: () => number } = {},
  ) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  private remember(map: Map<string, number>, key: string): void {
    const max = this.options.maxEntries ?? 50_000;
    if (map.size >= max) {
      // Drop the expired first, then the oldest, so a flood cannot grow the map without bound.
      for (const [k, until] of map) if (until <= this.now) map.delete(k);
      while (map.size >= max) map.delete(map.keys().next().value as string);
    }
    map.set(key, this.now + (this.options.ttlSeconds ?? 3600) * 1000);
  }

  /** Record a verified logout: one session (`sid`), or every session of the user (`sub` alone). */
  add(claims: Pick<LogoutTokenClaims, 'sid' | 'sub'>): void {
    if (claims.sid) this.remember(this.sids, claims.sid);
    else if (claims.sub) this.remember(this.users, claims.sub);
  }

  /** True when this verified session token belongs to a session a logout ended. */
  has(claims: Pick<SessionClaims, 'sid' | 'sub' | 'iat'> | null | undefined): boolean {
    if (!claims) return false;
    const now = this.now;
    const sidUntil = this.sids.get(claims.sid);
    if (sidUntil !== undefined) {
      if (sidUntil > now) return true;
      this.sids.delete(claims.sid);
    }
    const userUntil = this.users.get(claims.sub);
    if (userUntil !== undefined) {
      if (userUntil > now) {
        // Only tokens minted before the logout are ended: the user may sign in again.
        const loggedOutAt = userUntil - (this.options.ttlSeconds ?? 3600) * 1000;
        return typeof claims.iat !== 'number' || claims.iat * 1000 <= loggedOutAt;
      }
      this.users.delete(claims.sub);
    }
    return false;
  }
}

export interface AtlasBackchannelLogoutOptions extends Partial<Omit<BackchannelLogoutOptions, 'onLogout'>> {
  /** Records the logout so `atlasMiddleware({ logoutDenylist })` signs the session out. */
  denylist?: LogoutDenylist;
  /** Your own cleanup (delete an app-side session row, close sockets). Runs after the denylist is updated. */
  onLogout?: BackchannelLogoutOptions['onLogout'];
}

/**
 * The route handler for Atlas back-channel logout in the App Router:
 *
 *   // app/api/auth/backchannel-logout/route.ts
 *   export const POST = atlasBackchannelLogout({ denylist });
 *
 * `issuer` and `clientId` default to `ATLAS_ISSUER` and `ATLAS_CLIENT_ID`. A bad token answers 400 (Atlas does not
 * retry), a failure on your side 503 (Atlas retries).
 */
export function atlasBackchannelLogout(options: AtlasBackchannelLogoutOptions = {}) {
  const env = (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>;
  const issuer = options.issuer ?? env.ATLAS_ISSUER ?? env.NEXT_PUBLIC_ATLAS_ISSUER;
  const clientId = options.clientId ?? env.ATLAS_CLIENT_ID;
  if (!issuer || !clientId) {
    throw new Error('atlasBackchannelLogout needs `issuer` and `clientId` (or ATLAS_ISSUER and ATLAS_CLIENT_ID).');
  }
  const { denylist, onLogout, ...rest } = options;
  return nextBackchannelLogout({
    ...rest,
    issuer,
    clientId,
    async onLogout(claims) {
      denylist?.add(claims);
      await onLogout?.(claims);
    },
  });
}

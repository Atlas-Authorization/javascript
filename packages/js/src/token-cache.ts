/**
 * §7.4 step 1: "the SDK calls POST /v1/client/sessions/:sid/tokens with the
 * refresh cookie whenever its cached JWT is within 10 s of expiry (proactive,
 * jittered to avoid thundering herds across tabs)."
 *
 * The scheduling is the whole problem, and every parameter here is chosen
 * against a specific failure:
 *
 *   Refreshing at expiry rather than before it means every request in the
 *   window between "token died" and "new token arrived" gets a 401. Users
 *   experience that as random logouts on slow connections.
 *
 *   Refreshing with no jitter means twenty tabs wake at the same millisecond
 *   and hit the API together — which is fine at ten users and an outage at ten
 *   thousand.
 *
 *   Jittering too WIDELY is worse than not jittering: a token with 60 seconds
 *   of life, refreshed 10 seconds early with ±15 seconds of jitter, sometimes
 *   refreshes after it has already expired. The jitter window is therefore
 *   bounded to strictly less than the lead time, and there is a test that
 *   pins it.
 */

/** §7.4: refresh once the token is within this of expiring. */
export const REFRESH_LEAD_MS = 10_000;

/**
 * Jitter is subtracted from the delay only, never added. Adding could push the
 * refresh past expiry; subtracting only ever makes it earlier, which is safe.
 */
export const MAX_JITTER_MS = 5_000;

export interface CachedToken {
  jwt: string;
  /** Absolute expiry, epoch ms. */
  expiresAt: number;
  sessionId: string;
}

export interface ScheduleInput {
  token: CachedToken;
  now: number;
  leadMs?: number;
  /** Injected so the schedule is deterministic under test. */
  jitter?: () => number;
}

/**
 * Milliseconds until this token should be refreshed.
 *
 * Zero means "refresh now" — the token is already inside its lead window, or
 * past expiry. Never negative, because a negative delay in a `setTimeout` is
 * silently treated as zero anyway and the explicit clamp is clearer than
 * relying on that.
 */
export function msUntilRefresh(input: ScheduleInput): number {
  const lead = input.leadMs ?? REFRESH_LEAD_MS;
  const jitterFn = input.jitter ?? (() => Math.random() * MAX_JITTER_MS);

  // Bounded to strictly less than the lead, so subtracting jitter can never
  // move the refresh past the moment the token actually dies.
  const jitter = Math.min(Math.max(jitterFn(), 0), Math.max(lead - 1, 0));

  const target = input.token.expiresAt - lead - jitter;
  return Math.max(0, target - input.now);
}

/** Whether the cached token can still be handed to a caller. */
export function isUsable(token: CachedToken | null, now: number, skewMs = 0): boolean {
  if (!token) return false;
  return token.expiresAt - skewMs > now;
}

/**
 * Read `exp` out of a JWT without verifying it.
 *
 * Deliberately does NOT verify. The client cannot verify — it has no key, and
 * shipping one would be absurd — so this is a scheduling hint and nothing more.
 * Every security decision is made by the server against a signature; a token
 * whose `exp` a hostile party edited only causes the client to refresh at the
 * wrong moment, which the server then rejects on its own terms.
 */
export function readExpiry(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;

  try {
    const payload = JSON.parse(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: number;
    };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export class TokenCache {
  private token: CachedToken | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  set(token: CachedToken): void {
    this.token = token;
  }

  /** The cached token, or null if it is gone or too close to expiry to use. */
  get(skewMs = 0): CachedToken | null {
    if (!isUsable(this.token, this.now(), skewMs)) return null;
    return this.token;
  }

  /** Present regardless of usability — for deciding whether to refresh or sign in. */
  peek(): CachedToken | null {
    return this.token;
  }

  clear(): void {
    this.token = null;
  }
}

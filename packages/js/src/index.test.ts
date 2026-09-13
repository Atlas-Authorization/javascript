import { describe, expect, it } from 'vitest';
import {
  MAX_JITTER_MS,
  REFRESH_LEAD_MS,
  TokenCache,
  isUsable,
  msUntilRefresh,
  readExpiry,
} from './token-cache';
import { CLAIM_WINDOW_MS, isRefreshMessage, winsElection } from './tab-election';
import { errorsFor, fieldErrors, formErrors, isTerminal, nextStep } from './attempt';

const NOW = 1_800_000_000_000;
const token = (expiresInMs: number) => ({
  jwt: 'header.payload.signature',
  expiresAt: NOW + expiresInMs,
  sessionId: 'sess_1',
});

/**
 * Every parameter here is chosen against a specific failure. The tests name
 * the failure rather than the number.
 */
describe('refresh scheduling', () => {
  const noJitter = () => 0;

  it('schedules a refresh before expiry, not at it', () => {
    const delay = msUntilRefresh({ token: token(60_000), now: NOW, jitter: noJitter });
    // Refreshing at expiry means every request in the gap between "token died"
    // and "new token arrived" gets a 401 — random logouts on slow connections.
    expect(delay).toBe(60_000 - REFRESH_LEAD_MS);
  });

  it('refreshes immediately once inside the lead window', () => {
    expect(msUntilRefresh({ token: token(REFRESH_LEAD_MS - 1), now: NOW, jitter: noJitter })).toBe(
      0,
    );
  });

  it('refreshes immediately for an already-expired token', () => {
    expect(msUntilRefresh({ token: token(-5_000), now: NOW, jitter: noJitter })).toBe(0);
  });

  it('jitters so tabs do not wake together', () => {
    const early = msUntilRefresh({ token: token(60_000), now: NOW, jitter: () => 4_000 });
    const later = msUntilRefresh({ token: token(60_000), now: NOW, jitter: () => 1_000 });
    // Twenty tabs waking at the same millisecond is fine at ten users and an
    // outage at ten thousand.
    expect(early).toBeLessThan(later);
  });

  /**
   * The subtle one. A token with 60s of life refreshed 10s early with ±15s of
   * jitter would sometimes refresh AFTER it had already expired.
   */
  it('never lets jitter push a refresh past expiry', () => {
    for (const jitter of [0, 5_000, 60_000, 1_000_000]) {
      const delay = msUntilRefresh({ token: token(60_000), now: NOW, jitter: () => jitter });
      const refreshAt = NOW + delay;
      expect(refreshAt, `jitter ${jitter}`).toBeLessThan(token(60_000).expiresAt);
    }
  });

  it('ignores negative jitter rather than scheduling later', () => {
    const delay = msUntilRefresh({ token: token(60_000), now: NOW, jitter: () => -10_000 });
    expect(delay).toBe(60_000 - REFRESH_LEAD_MS);
  });

  it('keeps the default jitter inside its bound', () => {
    const delays = Array.from({ length: 200 }, () =>
      msUntilRefresh({ token: token(60_000), now: NOW }),
    );
    const floor = 60_000 - REFRESH_LEAD_MS - MAX_JITTER_MS;
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(floor);
    expect(Math.max(...delays)).toBeLessThanOrEqual(60_000 - REFRESH_LEAD_MS);
  });
});

describe('using a cached token', () => {
  it('reports a live token as usable', () => {
    expect(isUsable(token(30_000), NOW)).toBe(true);
  });

  it('reports an expired token as unusable', () => {
    expect(isUsable(token(-1), NOW)).toBe(false);
  });

  it('honours a skew so a token expiring mid-flight is not handed out', () => {
    // It would die inside the customer's request, surfacing as an intermittent
    // 401 nobody can reproduce.
    expect(isUsable(token(2_000), NOW, 5_000)).toBe(false);
  });

  it('withholds an expired token but still lets a caller see it', () => {
    let clock = NOW;
    const cache = new TokenCache(() => clock);
    cache.set(token(1_000));

    expect(cache.get()).not.toBeNull();
    clock += 2_000;

    expect(cache.get()).toBeNull();
    // `peek` is how the SDK tells "expired, refresh it" from "never signed in".
    expect(cache.peek()).not.toBeNull();
  });

  it('clears', () => {
    const cache = new TokenCache(() => NOW);
    cache.set(token(30_000));
    cache.clear();
    expect(cache.peek()).toBeNull();
  });
});

/**
 * Reading `exp` is a scheduling hint. The client has no key and cannot verify —
 * every security decision is the server's, against a signature.
 */
describe('reading expiry from a JWT', () => {
  const encode = (payload: unknown) =>
    `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

  it('reads exp as milliseconds', () => {
    expect(readExpiry(encode({ exp: 1_800_000_060 }))).toBe(1_800_000_060_000);
  });

  it('returns null for a token with no exp', () => {
    expect(readExpiry(encode({ sub: 'user_1' }))).toBeNull();
  });

  it('returns null rather than throwing on garbage', () => {
    for (const value of ['', 'not-a-jwt', 'a.b', 'a.!!!.c']) {
      expect(readExpiry(value), value).toBeNull();
    }
  });
});

/**
 * §7.4: refresh tokens ROTATE. Twenty simultaneous refreshes send the same
 * token twenty times, nineteen land outside the grace window, and the session
 * is revoked for token reuse. Getting this wrong signs the user out.
 */
describe('electing one refreshing tab', () => {
  it('lets the lowest id win', () => {
    expect(winsElection({ id: 'a', at: NOW }, [{ id: 'b', at: NOW }], NOW)).toBe(true);
    expect(winsElection({ id: 'b', at: NOW }, [{ id: 'a', at: NOW }], NOW)).toBe(false);
  });

  it('lets a lone tab win', () => {
    expect(winsElection({ id: 'z', at: NOW }, [], NOW)).toBe(true);
  });

  /**
   * A tab that crashed mid-refresh must not block every other tab forever —
   * that is a permanent sign-out for everyone still open.
   */
  it('ignores a claim older than the window', () => {
    const stale = { id: 'a', at: NOW - CLAIM_WINDOW_MS - 1 };
    expect(winsElection({ id: 'z', at: NOW }, [stale], NOW)).toBe(true);
  });

  it('still respects a claim inside the window', () => {
    const fresh = { id: 'a', at: NOW - (CLAIM_WINDOW_MS - 1) };
    expect(winsElection({ id: 'z', at: NOW }, [fresh], NOW)).toBe(false);
  });

  it('produces exactly one winner among many tabs', () => {
    const claims = ['e', 'c', 'a', 'd', 'b'].map((id) => ({ id, at: NOW }));
    const winners = claims.filter((claim) =>
      winsElection(
        claim,
        claims.filter((other) => other.id !== claim.id),
        NOW,
      ),
    );
    expect(winners).toHaveLength(1);
  });

  it('recognises only its own message shapes', () => {
    expect(isRefreshMessage({ type: 'claim', id: 'a', at: NOW })).toBe(true);
    expect(isRefreshMessage({ type: 'refreshed' })).toBe(true);
    // Another script sharing the channel must not be able to drive our state.
    expect(isRefreshMessage({ type: 'something_else' })).toBe(false);
    expect(isRefreshMessage(null)).toBe(false);
    expect(isRefreshMessage('claim')).toBe(false);
  });
});

/**
 * §5: the client renders whatever the server demands and never picks the step
 * itself.
 */
describe('the attempt state machine client', () => {
  it('maps every status the server can send', () => {
    const cases: Array<[string, string]> = [
      ['needs_identifier', 'collect_identifier'],
      ['needs_first_factor', 'collect_first_factor'],
      ['needs_second_factor', 'collect_second_factor'],
      ['needs_mfa_enrollment', 'enroll_second_factor'],
      ['needs_email_verification', 'collect_email_code'],
      ['needs_oauth_callback', 'await_oauth'],
      ['needs_new_password', 'collect_new_password'],
      ['complete', 'done'],
      ['abandoned', 'restart'],
    ];

    for (const [status, kind] of cases) {
      expect(nextStep({ status }).kind, status).toBe(kind);
    }
  });

  /**
   * §11.1 MFA policy `required`. This user has NO second factor, so a screen
   * asking them to "enter your code" would demand something that does not
   * exist and leave them with no way past it.
   */
  it('separates enrolling a factor from entering an existing one', () => {
    expect(nextStep({ status: 'needs_mfa_enrollment' }).kind).toBe('enroll_second_factor');
    expect(nextStep({ status: 'needs_second_factor' }).kind).toBe('collect_second_factor');
    // Still somewhere to go, so a poller keeps polling.
    expect(isTerminal({ status: 'needs_mfa_enrollment' })).toBe(false);
  });

  /**
   * An if-ladder falls through silently on a status it has not seen, and in a
   * sign-in flow that means a blank screen with no error.
   */
  it('reports an unrecognised status instead of rendering nothing', () => {
    const step = nextStep({ status: 'some_future_status' });
    expect(step).toEqual({ kind: 'unknown', status: 'some_future_status' });
  });

  /**
   * §13.2 makes the factor list identical for unknown identifiers. A client
   * that filtered it by "what this user probably has" would reintroduce the
   * enumeration leak the uniform response exists to close.
   */
  it('passes the server factor list through untouched', () => {
    const step = nextStep({
      status: 'needs_first_factor',
      supported_first_factors: ['password', 'email_code'],
    });
    expect(step).toEqual({
      kind: 'collect_first_factor',
      strategies: ['password', 'email_code'],
    });
  });

  it('carries the session id through completion', () => {
    expect(nextStep({ status: 'complete', created_session_id: 'sess_9' })).toEqual({
      kind: 'done',
      sessionId: 'sess_9',
    });
  });

  it('knows which statuses can still progress', () => {
    expect(isTerminal({ status: 'complete' })).toBe(true);
    expect(isTerminal({ status: 'abandoned' })).toBe(true);
    expect(isTerminal({ status: 'needs_second_factor' })).toBe(false);
  });
});

describe('surfacing §9.1 errors in a form', () => {
  const body = {
    errors: [
      {
        code: 'PASSWORD_POLICY',
        message: 'Password must be at least 8 characters.',
        param: 'password',
      },
      { code: 'RATE_LIMITED', message: 'Too many attempts. Try again shortly.' },
    ],
  };

  it('keeps the API message verbatim', () => {
    // The API writes for humans; replacing its text loses the only actionable
    // information the user gets.
    expect(fieldErrors(body)[0]!.message).toBe('Password must be at least 8 characters.');
  });

  it('separates field errors from form errors', () => {
    const errors = fieldErrors(body);
    // Otherwise "password too short" appears next to the email input.
    expect(errorsFor(errors, 'password')).toHaveLength(1);
    expect(formErrors(errors)).toHaveLength(1);
    expect(formErrors(errors)[0]!.code).toBe('RATE_LIMITED');
  });

  it('returns nothing for a body that is not an error envelope', () => {
    for (const value of [null, undefined, {}, { errors: 'nope' }, 'string']) {
      expect(fieldErrors(value)).toEqual([]);
    }
  });

  it('skips malformed entries rather than crashing the form', () => {
    const mixed = { errors: [null, { code: 'X' }, { code: 'Y', message: 'real' }] };
    expect(fieldErrors(mixed)).toHaveLength(1);
  });
});

describe('channels', () => {
  it('falls back to storage when BroadcastChannel is missing', async () => {
    const original = globalThis.BroadcastChannel;
    // Safari private mode and older browsers.
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;

    const { bestChannel } = await import('./tab-election');
    // No window in this environment either, so the honest answer is null — and
    // null is a supported state: one tab cannot stampede.
    expect(bestChannel('refresh')).toBeNull();

    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = original;
  });

  it('uses BroadcastChannel when it exists', async () => {
    const posted: unknown[] = [];
    class FakeChannel {
      postMessage(message: unknown) {
        posted.push(message);
      }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    const original = globalThis.BroadcastChannel;
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeChannel;

    const { broadcastChannel } = await import('./tab-election');
    const channel = broadcastChannel('refresh')!;
    channel.post({ type: 'claim' });

    expect(posted).toEqual([{ type: 'claim' }]);
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = original;
  });
});

describe('the token cache never holds a refresh token', () => {
  it('has no field that could hold one', () => {
    const cache = new TokenCache(() => NOW);
    cache.set(token(30_000));

    /**
     * The refresh token is HttpOnly precisely so customer JavaScript never
     * touches it. A cache with somewhere to put it is a cache someone will
     * eventually put it in.
     */
    expect(Object.keys(cache.peek()!)).toEqual(['jwt', 'expiresAt', 'sessionId']);
  });
});

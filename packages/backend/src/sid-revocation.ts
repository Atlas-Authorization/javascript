import { DEFAULT_API_URL } from './client/request';
import { createEdgeRevocationChecker } from './status-list';

/** `authenticateRequest(request, { revocation })`: also reject tokens whose session Atlas has revoked. */
export interface SidListRevocation {
  /** Poll `GET /v1/sessions/revoked` (needs `secretKey` with `sessions:read`) and reject a token whose `sid` is listed. */
  mode: 'sid_list';
  /** How often to poll, in milliseconds. Default 15000. This plus the token lifetime is the worst-case window. */
  intervalMs?: number;
  /** Your longest-lived session token, in seconds (Atlas's default is 60). A listed sid is remembered this long. Default 3600. */
  maxTokenLifetimeSeconds?: number;
  /**
   * What to do when the list cannot be refreshed (Atlas unreachable) for longer than `staleAfterMs`.
   * `allow` (default) keeps trusting the last list, so sign-ins that verify locally keep working through an
   * incident but a session revoked during it is not seen until a poll succeeds again. `reject` fails closed:
   * every token is refused with reason `revocation_unavailable` until a poll succeeds.
   */
  onStale?: 'allow' | 'reject';
  /** How long without a successful poll counts as stale. Default 120000 (two minutes). */
  staleAfterMs?: number;
  /**
   * With `onStale: 'reject'`: keep answering from the last list for this many extra milliseconds after `staleAfterMs`
   * before failing closed, so a short Atlas outage does not sign everyone out. `onServeStale` fires for each check
   * inside the grace. Default 0: fail closed as soon as the list is stale.
   */
  serveStaleForMs?: number;
  /** Called (not awaited) when a check is answered from a list that is stale but still inside `serveStaleForMs`. */
  onServeStale?: (info: { lastSuccessAt: number | null; staleForMs: number }) => void;
  /**
   * Where the list comes from. `feed` (default) pages `GET /v1/sessions/revoked`. `status_list` fetches the signed
   * list at `GET /v1/sessions/revocations/status-list` and verifies it against the instance JWKS (`jwksUrl`), the
   * smaller answer for a busy verifier. Both need `sessions:read` on the secret key.
   */
  source?: 'feed' | 'status_list';
  /** `status_list` source: the instance JWKS URL the signature is checked against. */
  jwksUrl?: string;
  /** `status_list` source: the issuer the signed list must carry. */
  issuer?: string;
  /** Called when a poll fails. The last list stays in force (a failed poll never rejects or accepts more than before). */
  onError?: (error: unknown) => void;
}

interface Page {
  data: Array<{ sid: string; revoked_at: number }>;
  has_more: boolean;
  next_cursor: string | null;
  server_time: number;
}

/** One poller: an in-memory set of revoked session ids, each kept until its token cannot be live any more. */
export class SidRevocationList {
  private readonly revoked = new Map<string, number>();
  private since: number | undefined;
  private nextPollAt = 0;
  private inflight: Promise<void> | undefined;
  private lastSuccessAt: number | undefined;
  private readonly createdAt: number;
  private readonly intervalMs: number;
  private readonly lifetimeMs: number;

  constructor(
    private readonly opts: SidListRevocation,
    private readonly io: { secretKey: string; baseUrl?: string; fetchImpl?: typeof fetch; now: () => number },
  ) {
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.lifetimeMs = (opts.maxTokenLifetimeSeconds ?? 3600) * 1000;
    this.createdAt = io.now();
  }

  /** True when the list could not be refreshed for `staleAfterMs` and the caller asked to fail closed. Call after `isRevoked`. */
  unavailable(): boolean {
    if (this.opts.onStale !== 'reject') return false;
    const stale = this.io.now() - (this.lastSuccessAt ?? this.createdAt) - (this.opts.staleAfterMs ?? 120_000);
    if (stale <= 0) return false;
    // A list that was fetched at least once may be served a little longer; one never fetched may not.
    if (this.lastSuccessAt !== undefined && stale <= (this.opts.serveStaleForMs ?? 0)) {
      this.opts.onServeStale?.({ lastSuccessAt: this.lastSuccessAt, staleForMs: stale });
      return false;
    }
    return true;
  }

  async isRevoked(sid: string): Promise<boolean> {
    if (this.opts.source === 'status_list') {
      const verdict = await this.statusListVerdict(sid);
      if (verdict !== 'fallback') return verdict === 'revoked';
    }
    const now = this.io.now();
    if (now >= this.nextPollAt) await (this.inflight ??= this.poll().finally(() => (this.inflight = undefined)));
    const expiry = this.revoked.get(sid);
    return expiry !== undefined && expiry > now;
  }

  private statusChecker?: ReturnType<typeof createEdgeRevocationChecker>;

  /** The `status_list` source: the signed list answers instead of the paged feed. */
  private async statusListVerdict(sid: string): Promise<'revoked' | 'ok' | 'fallback'> {
    if (!this.opts.jwksUrl) throw new Error('revocation source `status_list` needs `jwksUrl`.');
    this.statusChecker ??= createEdgeRevocationChecker({
      secretKey: this.io.secretKey,
      baseUrl: this.io.baseUrl,
      jwksUrl: this.opts.jwksUrl,
      issuer: this.opts.issuer,
      windowSeconds: Math.min(86_400, Math.max(60, Math.ceil(this.lifetimeMs / 1000))),
      refreshMs: this.intervalMs,
      staleAfterMs: this.opts.staleAfterMs,
      fetchImpl: this.io.fetchImpl,
      now: this.io.now,
      // The checker's own stale verdict is mapped by `unavailable()`; keep its refresh failures reported.
      onStale: 'allow',
      onError: (error) => this.opts.onError?.(error),
    });
    const verdict = await this.statusChecker.check(sid);
    this.lastSuccessAt = this.statusChecker.lastSuccessAt() ?? undefined;
    // A list that was cut short, or never fetched, cannot clear a session: ask the feed.
    return verdict === 'unavailable' ? 'fallback' : verdict;
  }

  private async poll(): Promise<void> {
    const started = this.io.now();
    this.nextPollAt = started + this.intervalMs;
    try {
      let cursor: string | undefined;
      let serverTime = started;
      do {
        const q = new URLSearchParams({ since: String(this.since ?? started - this.lifetimeMs), limit: '5000' });
        if (cursor) q.set('cursor', cursor);
        const res = await (this.io.fetchImpl ?? fetch)(`${(this.io.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, '')}/v1/sessions/revoked?${q}`, {
          headers: { authorization: `Bearer ${this.io.secretKey}` },
        });
        if (!res.ok) throw new Error(`GET /v1/sessions/revoked answered ${res.status}`);
        const page = (await res.json()) as Page;
        for (const r of page.data) this.revoked.set(r.sid, r.revoked_at + this.lifetimeMs);
        serverTime = page.server_time;
        cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
      } while (cursor);
      // Re-ask from a little before the answer's own clock, so a row committed late is not missed.
      this.since = serverTime - 10_000;
      this.lastSuccessAt = started;
      for (const [sid, expiry] of this.revoked) if (expiry <= started) this.revoked.delete(sid);
    } catch (error) {
      this.opts.onError?.(error);
    }
  }
}

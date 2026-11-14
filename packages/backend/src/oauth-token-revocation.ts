import { DEFAULT_API_URL } from './client/request';

/** Tunables for `createAccessTokenVerifier({ revocation })`: poll the API's revoked-token feed and reject listed tokens. */
export interface OAuthTokenRevocationOptions {
  /** How often to poll, in milliseconds. Default 15000. This plus the token lifetime is the worst-case window. */
  intervalMs?: number;
  /** Your longest-lived access token, in seconds (Atlas allows up to 86400). A listed family or jti is remembered this long. Default 86400. */
  maxTokenLifetimeSeconds?: number;
  /**
   * What to do when the feed cannot be refreshed for longer than `staleAfterMs`. `allow` (default) keeps trusting the last
   * list; `reject` fails closed: every token is refused until a poll succeeds.
   */
  onStale?: 'allow' | 'reject';
  /** How long without a successful poll counts as stale. Default 120000. */
  staleAfterMs?: number;
  /** Called when a poll fails. The last list stays in force. */
  onError?: (error: unknown) => void;
}

interface Page {
  data: Array<{ family_id: string | null; jti: string | null; revoked_at: number }>;
  has_more: boolean;
  next_cursor: string | null;
  server_time: number;
}

/**
 * One poller: an in-memory set of revoked token families (`fid` claim) and single
 * access tokens (`jti`), each kept until its token cannot be live any more. The
 * API's resource-server id is looked up by its identifier on the first poll when
 * not given.
 */
export class OAuthTokenRevocationList {
  private readonly revoked = new Map<string, number>();
  private since: number | undefined;
  private nextPollAt = 0;
  private inflight: Promise<void> | undefined;
  private lastSuccessAt: number | undefined;
  private resourceServerId: string | undefined;
  private readonly createdAt: number;
  private readonly intervalMs: number;
  private readonly lifetimeMs: number;

  constructor(
    private readonly opts: OAuthTokenRevocationOptions,
    private readonly io: {
      secretKey: string;
      resourceServerId?: string;
      /** The API identifier (audience), used to find the resource server when no id is given. */
      identifier?: string;
      baseUrl?: string;
      fetchImpl?: typeof fetch;
      now: () => number;
    },
  ) {
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.lifetimeMs = (opts.maxTokenLifetimeSeconds ?? 86_400) * 1000;
    this.createdAt = io.now();
    this.resourceServerId = io.resourceServerId;
  }

  /** True when the feed could not be refreshed for `staleAfterMs` and the caller asked to fail closed. Call after `isRevoked`. */
  unavailable(): boolean {
    if (this.opts.onStale !== 'reject') return false;
    return this.io.now() - (this.lastSuccessAt ?? this.createdAt) > (this.opts.staleAfterMs ?? 120_000);
  }

  /** Is this token's family or jti on the feed? Refreshes the feed first when the interval has passed. */
  async isRevoked(claims: { fid?: unknown; jti?: unknown }): Promise<boolean> {
    const now = this.io.now();
    if (now >= this.nextPollAt) await (this.inflight ??= this.poll().finally(() => (this.inflight = undefined)));
    const live = (key: string) => (this.revoked.get(key) ?? 0) > now;
    return (typeof claims.fid === 'string' && live(`fid:${claims.fid}`)) || (typeof claims.jti === 'string' && live(`jti:${claims.jti}`));
  }

  private base(): string {
    return (this.io.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
  }

  private async resolveResourceServer(): Promise<string> {
    if (this.resourceServerId) return this.resourceServerId;
    if (!this.io.identifier) throw new Error('Token revocation needs `resourceServerId`, or a single string `audience` to look it up.');
    const res = await (this.io.fetchImpl ?? fetch)(`${this.base()}/v1/resource_servers`, {
      headers: { authorization: `Bearer ${this.io.secretKey}` },
    });
    if (!res.ok) throw new Error(`GET /v1/resource_servers answered ${res.status}`);
    const list = (await res.json()) as { data: Array<{ id: string; identifier: string }> };
    const found = list.data.find((r) => r.identifier === this.io.identifier);
    if (!found) throw new Error(`No resource server has the identifier ${this.io.identifier}.`);
    return (this.resourceServerId = found.id);
  }

  private async poll(): Promise<void> {
    const started = this.io.now();
    this.nextPollAt = started + this.intervalMs;
    try {
      const id = await this.resolveResourceServer();
      let cursor: string | undefined;
      let serverTime = started;
      do {
        const q = new URLSearchParams({ since: String(this.since ?? started - this.lifetimeMs), limit: '5000' });
        if (cursor) q.set('after', cursor);
        const res = await (this.io.fetchImpl ?? fetch)(`${this.base()}/v1/resource_servers/${encodeURIComponent(id)}/revoked_tokens?${q}`, {
          headers: { authorization: `Bearer ${this.io.secretKey}` },
        });
        if (!res.ok) throw new Error(`GET /v1/resource_servers/{id}/revoked_tokens answered ${res.status}`);
        const page = (await res.json()) as Page;
        for (const r of page.data) {
          if (r.family_id) this.revoked.set(`fid:${r.family_id}`, r.revoked_at + this.lifetimeMs);
          if (r.jti) this.revoked.set(`jti:${r.jti}`, r.revoked_at + this.lifetimeMs);
        }
        serverTime = page.server_time;
        cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
      } while (cursor);
      // Re-ask from a little before the answer's own clock, so a row committed late is not missed.
      this.since = serverTime - 10_000;
      this.lastSuccessAt = started;
      for (const [key, expiry] of this.revoked) if (expiry <= started) this.revoked.delete(key);
    } catch (error) {
      this.opts.onError?.(error);
    }
  }
}

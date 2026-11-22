import { DEFAULT_TTL_MS, REFETCH_INTERVAL_MS } from './jwks-cache';
import { discoveryUrlFor } from './discovery';

/**
 * The issuers an instance says it used to have, read from its discovery document (`atlas_previous_issuers`, which
 * includes issuers you declared as aliases). A verifier configured with `previousIssuers: 'discovery'` accepts each one
 * until its `accepted_until`.
 *
 * It only widens which `iss` is accepted; every token is still verified against the instance's own keys. The list is
 * cached for the JWKS TTL, a failed refresh keeps the last good list (never longer than each entry's own end date),
 * and a failing endpoint is retried at most once a minute.
 */
export class PreviousIssuersFeed {
  private list: { issuer: string; until: number }[] = [];
  private fetchedAt = 0;
  private lastAttemptAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly deps: { issuer: string; instanceId?: string; fetchImpl?: typeof fetch; now?: () => number; ttlMs?: number },
  ) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The earlier issuers still inside their window. */
  async get(): Promise<string[]> {
    const now = this.now;
    const stale = this.fetchedAt === 0 || now - this.fetchedAt >= (this.deps.ttlMs ?? DEFAULT_TTL_MS);
    if (stale && now - this.lastAttemptAt >= REFETCH_INTERVAL_MS) {
      this.lastAttemptAt = now;
      this.inflight ??= this.refresh(now).finally(() => {
        this.inflight = null;
      });
      await this.inflight;
    } else if (stale && this.inflight) {
      await this.inflight;
    }
    return this.list.filter((e) => e.until > now).map((e) => e.issuer);
  }

  private async refresh(now: number): Promise<void> {
    try {
      const response = await (this.deps.fetchImpl ?? fetch)(discoveryUrlFor(this.deps.issuer, this.deps.instanceId), {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return;
      const doc = (await response.json()) as { issuer?: unknown; atlas_previous_issuers?: unknown } | null;
      // The document must be about the issuer it was fetched for, or its list means nothing.
      if (!doc || typeof doc.issuer !== 'string' || doc.issuer.replace(/\/+$/, '') !== this.deps.issuer.replace(/\/+$/, '')) return;
      const entries = Array.isArray(doc.atlas_previous_issuers) ? doc.atlas_previous_issuers : [];
      const next: { issuer: string; until: number }[] = [];
      for (const e of entries.slice(0, 20)) {
        const r = (e ?? {}) as { issuer?: unknown; accepted_until?: unknown };
        if (typeof r.issuer !== 'string' || !r.issuer.startsWith('https://') || typeof r.accepted_until !== 'number') continue;
        next.push({ issuer: r.issuer.replace(/\/+$/, ''), until: r.accepted_until * 1000 });
      }
      this.list = next;
      this.fetchedAt = now;
    } catch {
      // Keep the last good list; each entry still ends at its own date.
    }
  }
}

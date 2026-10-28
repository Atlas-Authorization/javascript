import type { LocalPdp, DecisionRecord, PdpTuple, PdpTupleChange } from './pdp';

type Fetch = typeof fetch;

export interface SyncOptions {
  pdp: LocalPdp;
  /** Atlas Backend API origin, e.g. `https://api.example.com`. */
  baseUrl: string;
  /** A secret key with policy_bundles:read, fga:read (and authz_decisions:write to ship decisions). */
  apiKey: string;
  /** Pin the trusted bundle signing keys. Default: fetched once from `<baseUrl>/.well-known/jwks.json` (trust on first use over TLS). */
  jwks?: { keys: Array<Record<string, unknown>> };
  intervalMs?: number;
  fetch?: Fetch;
  onError?: (err: unknown) => void;
}

interface Snapshot {
  full: boolean;
  revision: number;
  tuples?: PdpTuple[];
  changes?: PdpTupleChange[];
  next_cursor?: string | null;
  has_more?: boolean;
}

/** Keeps a {@link LocalPdp} current: the signed bundle (by revision) and each store's tuples (full, then deltas). */
export class PdpSync {
  private timer: ReturnType<typeof setInterval> | undefined;
  private jwks: SyncOptions['jwks'];
  private storeIds = new Map<string, string>();
  private readonly f: Fetch;
  private running = false;

  constructor(private readonly o: SyncOptions) {
    this.f = o.fetch ?? fetch;
    this.jwks = o.jwks;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.f(`${this.o.baseUrl.replace(/\/$/, '')}${path}`, { headers: { authorization: `Bearer ${this.o.apiKey}` } });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    return (await res.json()) as T;
  }

  /** One sync pass. Safe to call concurrently (extra calls are skipped). */
  async syncOnce(): Promise<{ bundleChanged: boolean }> {
    if (this.running) return { bundleChanged: false };
    this.running = true;
    try {
      const { revision } = await this.get<{ revision: string }>('/v1/policy_bundles/current');
      let bundleChanged = false;
      if (revision !== this.o.pdp.revision) {
        const row = await this.get<{ bundle: string; signature: string; revision: string }>(`/v1/policy_bundles/${encodeURIComponent(revision)}`);
        if (!this.jwks) this.jwks = await (await this.f(`${this.o.baseUrl.replace(/\/$/, '')}/.well-known/jwks.json`)).json() as SyncOptions['jwks'];
        await this.o.pdp.loadBundle({ bundle: row.bundle, signature: row.signature, jwks: this.jwks as { keys: never[] }, expectedRevision: revision });
        bundleChanged = true;
      }
      await this.syncTuples();
      return { bundleChanged };
    } finally {
      this.running = false;
    }
  }

  private async syncTuples(): Promise<void> {
    const names = this.o.pdp.storeNames();
    if (names.length === 0) return;
    if (this.storeIds.size < names.length) {
      const list = await this.get<{ data: Array<{ id: string; name: string }> }>('/v1/fga/stores');
      this.storeIds = new Map(list.data.map((s) => [s.name, s.id]));
    }
    for (const name of names) {
      const id = this.storeIds.get(name);
      if (!id) continue;
      const known = this.o.pdp.storeRevision(name);
      let snap = await this.get<Snapshot>(`/v1/fga/stores/${id}/snapshot${known > 0 ? `?since=${known}` : ''}`);
      if (!snap.full) {
        this.o.pdp.applyChanges(name, snap.changes ?? [], snap.revision);
        while (snap.has_more) {
          snap = await this.get<Snapshot>(`/v1/fga/stores/${id}/snapshot?since=${snap.revision}`);
          this.o.pdp.applyChanges(name, snap.changes ?? [], snap.revision);
        }
        continue;
      }
      // Full resync: gather every page first so a half-loaded store is never visible.
      const all: PdpTuple[] = [...(snap.tuples ?? [])];
      const revision = snap.revision;
      while (snap.has_more && snap.next_cursor) {
        snap = await this.get<Snapshot>(`/v1/fga/stores/${id}/snapshot?cursor=${encodeURIComponent(snap.next_cursor)}`);
        all.push(...(snap.tuples ?? []));
      }
      this.o.pdp.loadTuples(name, all, { revision });
    }
  }

  start(): void {
    const tick = () => this.syncOnce().catch((e) => this.o.onError?.(e));
    void tick();
    this.timer = setInterval(tick, this.o.intervalMs ?? 15_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

export interface ShipperOptions {
  baseUrl: string;
  apiKey: string;
  pdp: { id: string; name?: string; version?: string };
  /** Reports the bundle revision the PDP currently runs. */
  revision: () => string | null;
  batchSize?: number;
  intervalMs?: number;
  /** Keep at most this many unsent decisions (oldest dropped). */
  maxBuffer?: number;
  fetch?: Fetch;
  onError?: (err: unknown) => void;
}

/** Batches decisions and ships them to `/v1/authz_decisions/ingest` (also a heartbeat for the fleet list). */
export class DecisionShipper {
  private buf: DecisionRecord[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly f: Fetch;

  constructor(private readonly o: ShipperOptions) {
    this.f = o.fetch ?? fetch;
  }

  push = (d: DecisionRecord): void => {
    this.buf.push(d);
    const max = this.o.maxBuffer ?? 10_000;
    if (this.buf.length > max) this.buf.splice(0, this.buf.length - max);
    if (this.buf.length >= (this.o.batchSize ?? 200)) void this.flush().catch((e) => this.o.onError?.(e));
  };

  async flush(): Promise<number> {
    const batch = this.buf.splice(0, 500);
    try {
      const res = await this.f(`${this.o.baseUrl.replace(/\/$/, '')}/v1/authz_decisions/ingest`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          pdp: { id: this.o.pdp.id, name: this.o.pdp.name, version: this.o.pdp.version, bundle_revision: this.o.revision() },
          decisions: batch.map((d) => ({ decision: d.decision, principal: d.principal, action: d.action, resource: d.resource, latency_ms: d.latency_ms, result: d.result, input: { principal: d.principal, action: d.action, resource: d.resource } })),
        }),
      });
      if (!res.ok) throw new Error(`ingest failed: ${res.status}`);
      return batch.length;
    } catch (e) {
      this.buf.unshift(...batch); // keep for the next attempt
      throw e;
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.flush().catch((e) => this.o.onError?.(e)), this.o.intervalMs ?? 10_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush().catch(() => undefined);
  }
}

import {
  authorizeAbac,
  linkAbacTemplate,
  parseAbacPolicies,
  parseAbacTemplate,
  type AbacDecision,
  type AbacEvalHost,
  type AbacPolicy,
  type AbacRequest,
} from '../../core/src/abac/policy-language';
import {
  MemoryTupleReader,
  check as fgaCheck,
  listObjects as fgaListObjects,
  parseModel,
  type CheckRequest,
  type CompiledModel,
  type ListObjectsRequest,
  type RelationshipTuple,
} from '../../core/src/fga/index';
import { verifyPolicyBundle, type VerifiedPolicyBundle, type VerifyPolicyBundleOptions } from '../../backend/src/policy-bundle';

/** A tuple as the snapshot API returns it. */
export interface PdpTuple {
  user: string;
  relation: string;
  object: string;
  condition?: { name: string; context?: Record<string, unknown> };
  /** Epoch milliseconds, ISO string or Date. */
  expires_at?: number | string | Date;
}

export interface PdpTupleChange extends PdpTuple {
  operation: 'write' | 'delete';
}

export interface PdpDecision extends AbacDecision {
  /** Names of the policies that decided it. */
  reasons: string[];
  /** The bundle revision that decided it. */
  revision: string;
}

export interface DecisionRecord {
  decision: 'allow' | 'deny';
  principal: string;
  action: string;
  resource: string;
  latency_ms: number;
  result: Record<string, unknown>;
  at: number;
}

interface StoreState {
  model: CompiledModel | null;
  reader: MemoryTupleReader;
  /** The store revision the tuples are at (from the last snapshot or delta). */
  revision: number;
  tuples: number;
}

const toTuple = (t: PdpTuple): RelationshipTuple => {
  const expiresAt = t.expires_at === undefined || t.expires_at === null ? undefined : new Date(t.expires_at);
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error(`tuple ${t.user} ${t.relation} ${t.object}: invalid expires_at`);
  return { user: t.user, relation: t.relation, object: t.object, ...(t.condition ? { condition: t.condition } : {}), ...(expiresAt ? { expiresAt } : {}) };
};

export class PdpError extends Error {
  constructor(
    readonly code: 'unknown_store' | 'no_model' | 'not_loaded',
    message: string,
  ) {
    super(message);
    this.name = 'PdpError';
  }
}

/**
 * An in-process policy decision point. Authenticity comes from the signed bundle (verified offline); tuple data
 * is pushed in by {@link PdpSync} or the caller. Expired tuples stop granting at their `expires_at` even if the
 * sync is behind. Decisions never throw on policy errors: Cedar semantics (forbid wins, default deny).
 */
export class LocalPdp {
  private bundle: VerifiedPolicyBundle | null = null;
  private policies: Array<{ policy: AbacPolicy; owner: string; store: string | null }> = [];
  private stores = new Map<string, StoreState>();
  /** Called after every decision; wire a {@link DecisionShipper} here. */
  onDecision?: (d: DecisionRecord) => void;

  constructor(private readonly now: () => number = Date.now) {}

  /** Verify (signature + integrity, offline) and load a bundle. Throws `PolicyBundleError` on any failure. */
  static async load(opts: VerifyPolicyBundleOptions & { now?: () => number }): Promise<LocalPdp> {
    const pdp = new LocalPdp(opts.now);
    await pdp.loadBundle(opts);
    return pdp;
  }

  async loadBundle(opts: VerifyPolicyBundleOptions): Promise<VerifiedPolicyBundle> {
    const v = await verifyPolicyBundle(opts);
    this.use(v);
    return v;
  }

  /** Install an already-verified bundle (atomic swap; tuples of stores that keep their name are kept). */
  use(v: VerifiedPolicyBundle): void {
    const policies: LocalPdp['policies'] = [];
    for (const p of v.policies) {
      if (!p.enabled) continue;
      for (const parsed of parseAbacPolicies(p.source)) policies.push({ policy: parsed, owner: p.name, store: p.fga_store });
    }
    const templates = new Map(v.abacTemplates.map((t) => [t.name, t]));
    for (const l of v.abacLinks) {
      const t = templates.get(l.template);
      if (!l.enabled || !t) continue;
      for (const parsed of linkAbacTemplate(parseAbacTemplate(t.source), { principal: l.principal ?? undefined, resource: l.resource ?? undefined })) {
        policies.push({ policy: parsed, owner: l.name, store: t.fga_store });
      }
    }
    const next = new Map<string, StoreState>();
    for (const s of v.fgaStores) {
      const prev = this.stores.get(s.name);
      next.set(s.name, { model: s.model ? parseModel(s.model) : null, reader: prev?.reader ?? new MemoryTupleReader([], this.now), revision: prev?.revision ?? 0, tuples: prev?.tuples ?? 0 });
    }
    this.bundle = v;
    this.policies = policies;
    this.stores = next;
  }

  get revision(): string | null {
    return this.bundle?.revision ?? null;
  }

  storeNames(): string[] {
    return [...this.stores.keys()];
  }

  /** The revision the named store's tuples are at (0 before the first sync). */
  storeRevision(name: string): number {
    return this.stores.get(name)?.revision ?? 0;
  }

  private store(name: string): StoreState {
    const s = this.stores.get(name);
    if (!s) throw new PdpError('unknown_store', `The bundle has no FGA store named "${name}".`);
    return s;
  }

  /** Replace the store's tuples (a full snapshot) or merge a further page of one (`replace: false`). */
  loadTuples(storeName: string, tuples: PdpTuple[], opts: { revision?: number; replace?: boolean } = {}): void {
    const s = this.store(storeName);
    const reader = opts.replace === false ? s.reader : new MemoryTupleReader([], this.now);
    for (const t of tuples) reader.add(toTuple(t));
    s.reader = reader;
    s.tuples = opts.replace === false ? s.tuples + tuples.length : tuples.length;
    if (opts.revision !== undefined) s.revision = opts.revision;
  }

  /** Apply a delta from the snapshot API (idempotent). */
  applyChanges(storeName: string, changes: PdpTupleChange[], revision: number): void {
    const s = this.store(storeName);
    for (const c of changes) {
      if (c.operation === 'delete') s.reader.remove(toTuple(c));
      else s.reader.add(toTuple(c));
    }
    s.revision = revision;
  }

  private hostFor(storeName: string | null): AbacEvalHost {
    const s = storeName ? this.stores.get(storeName) : undefined;
    if (!s?.model) return {};
    const model = s.model;
    return { fga: (user, relation, object) => fgaCheck(model, s.reader, { user, relation, object }) };
  }

  /** Decide an ABAC request against the loaded bundle. */
  async authorize(req: AbacRequest): Promise<PdpDecision> {
    if (!this.bundle) throw new PdpError('not_loaded', 'No policy bundle is loaded.');
    const t0 = performance.now();
    const hosts = new Map<string | null, AbacEvalHost>();
    const decision = await authorizeAbac(
      this.policies.map((p) => p.policy),
      req,
      (i) => {
        const store = this.policies[i]!.store;
        let h = hosts.get(store);
        if (!h) hosts.set(store, (h = this.hostFor(store)));
        return h;
      },
    );
    const out: PdpDecision = { ...decision, reasons: [...new Set(decision.determining.map((i) => this.policies[i]!.owner))], revision: this.bundle.revision };
    this.onDecision?.({
      decision: out.decision,
      principal: `${req.principal.type}::${req.principal.id}`,
      action: req.action.id,
      resource: `${req.resource.type}::${req.resource.id}`,
      latency_ms: performance.now() - t0,
      result: { reasons: out.reasons, errors: out.errors.length },
      at: this.now(),
    });
    return out;
  }

  /** An FGA check against a bundle store. */
  async check(storeName: string, req: CheckRequest): Promise<boolean> {
    const s = this.store(storeName);
    if (!s.model) throw new PdpError('no_model', `Store "${storeName}" has no authorization model.`);
    const t0 = performance.now();
    const allowed = await fgaCheck(s.model, s.reader, req);
    this.onDecision?.({ decision: allowed ? 'allow' : 'deny', principal: req.user, action: req.relation, resource: req.object, latency_ms: performance.now() - t0, result: { store: storeName }, at: this.now() });
    return allowed;
  }

  async listObjects(storeName: string, req: ListObjectsRequest): Promise<string[]> {
    const s = this.store(storeName);
    if (!s.model) throw new PdpError('no_model', `Store "${storeName}" has no authorization model.`);
    return fgaListObjects(s.model, s.reader, req);
  }

  status() {
    return {
      revision: this.revision,
      policies: this.policies.length,
      stores: [...this.stores].map(([name, s]) => ({ name, has_model: !!s.model, tuples: s.tuples, revision: s.revision })),
    };
  }
}

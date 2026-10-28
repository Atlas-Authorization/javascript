/**
 * Authorization-filtered retrieval. A RAG pipeline must never put a document in front of a model that the
 * asking user may not read. Two ways to enforce that, both supported:
 *
 *  - PRE-filter: ask Atlas which objects the user can access (FGA list-objects) and hand the vector store a
 *    metadata filter limited to those ids. The vector store only ever sees permitted documents.
 *  - POST-filter: retrieve more candidates than needed, batch-check them against FGA, keep the permitted ones,
 *    and fetch again if too few survive. Right when the permitted set is huge.
 *
 * `strategy: 'auto'` pre-filters while the permitted set is small (`maxPrefilterIds`) and post-filters beyond.
 * Fails closed: if Atlas cannot be reached, retrieval throws; it never falls back to unfiltered results.
 */

/** The slice of an Atlas FGA client this package needs (`atlas.fga.store(id)` from @atlasauth/backend, or @atlasauth/fga-js). */
export interface FgaAccess {
  listObjects(body: { user: string; relation: string; type: string; limit?: number; starting_after?: string; context?: Record<string, unknown> }): Promise<{ objects: string[]; has_more: boolean; next_cursor: string | null }>;
  batchCheck?(body: { checks: Array<{ user: string; relation: string; object: string; correlation_id: string }> }): Promise<{ result: Array<{ correlation_id: string; allowed: boolean }> }>;
}

export class AuthorizationUnavailableError extends Error {}

export interface AccessQuery {
  fga: FgaAccess;
  /** The asking user as an FGA user, e.g. `user:alice`. */
  user: string;
  /** The relation that grants reading, e.g. `viewer`. */
  relation: string;
  /** The object type of the documents, e.g. `document`. */
  type: string;
  context?: Record<string, unknown>;
}

const stripType = (type: string, object: string) => (object.startsWith(`${type}:`) ? object.slice(type.length + 1) : object);

/** Ids (without the `type:` prefix) the user may access, up to `max`; `truncated` when there were more. */
export async function allowedIds(q: AccessQuery, max = 5000): Promise<{ ids: string[]; truncated: boolean }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  try {
    for (;;) {
      const page = await q.fga.listObjects({ user: q.user, relation: q.relation, type: q.type, limit: Math.min(1000, max + 1 - ids.length), starting_after: cursor, context: q.context });
      for (const o of page.objects) ids.push(stripType(q.type, o));
      if (ids.length > max) return { ids: ids.slice(0, max), truncated: true };
      if (!page.has_more || !page.next_cursor) return { ids, truncated: false };
      cursor = page.next_cursor;
    }
  } catch (err) {
    throw new AuthorizationUnavailableError(`Could not list the objects ${q.user} may ${q.relation}: ${(err as Error).message}`);
  }
}

/** Keep the ids the user may access, via batch-check (chunks of 100). */
export async function filterAllowed(q: AccessQuery, ids: string[]): Promise<Set<string>> {
  if (!q.fga.batchCheck) throw new AuthorizationUnavailableError('The FGA client has no batchCheck; post-filtering needs it.');
  const allowed = new Set<string>();
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const res = await q.fga.batchCheck({ checks: chunk.map((id, n) => ({ user: q.user, relation: q.relation, object: `${q.type}:${id}`, correlation_id: String(n) })) });
      for (const r of res.result) if (r.allowed) allowed.add(chunk[Number(r.correlation_id)]!);
    }
  } catch (err) {
    throw new AuthorizationUnavailableError(`Could not check access for ${q.user}: ${(err as Error).message}`);
  }
  return allowed;
}

/** A Mongo-style metadata filter (`$in`, `$and`, ...), which most vector stores accept or adapt. */
export type MetadataFilter = Record<string, unknown>;

export interface RetrieverOptions<Doc> {
  /** Run the vector query. `filter` is the metadata filter to apply (undefined = none, which only happens for post-filtering). */
  retrieve: (query: string, opts: { k: number; filter?: MetadataFilter }) => Promise<Doc[]>;
  access: AccessQuery;
  /** The document id as FGA knows it (without the type prefix). Default: `doc.metadata.id`. */
  idOf?: (doc: Doc) => string | undefined;
  /** The metadata key holding the id, for the pre-filter. Default `id`. */
  metadataKey?: string;
  /** Build the vector-store filter from the permitted ids. Default `{ [metadataKey]: { $in: ids } }`. */
  buildFilter?: (ids: string[]) => MetadataFilter;
  /** Merged with the permitted-ids filter via `$and`. */
  extraFilter?: MetadataFilter;
  strategy?: 'prefilter' | 'postfilter' | 'auto';
  /** `auto`: pre-filter up to this many permitted ids. Default 1000. */
  maxPrefilterIds?: number;
  /** Post-filter: candidates fetched per round as a multiple of k, and the number of rounds. */
  overfetch?: number;
  maxRounds?: number;
}

const defaultIdOf = (doc: unknown): string | undefined => {
  const m = (doc as { metadata?: Record<string, unknown> })?.metadata;
  const v = m?.id ?? m?.doc_id ?? m?.source_id;
  return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined;
};

/** Retrieve at most `k` documents, all of which the user may access. */
export function createAuthorizedRetriever<Doc>(o: RetrieverOptions<Doc>) {
  const key = o.metadataKey ?? 'id';
  const idOf = o.idOf ?? (defaultIdOf as (d: Doc) => string | undefined);
  const build = o.buildFilter ?? ((ids: string[]) => ({ [key]: { $in: ids } }));
  const withExtra = (f: MetadataFilter) => (o.extraFilter ? { $and: [o.extraFilter, f] } : f);

  return async function retrieve(query: string, k = 4): Promise<Doc[]> {
    const strategy = o.strategy ?? 'auto';
    if (strategy !== 'postfilter') {
      const { ids, truncated } = await allowedIds(o.access, strategy === 'prefilter' ? 100_000 : (o.maxPrefilterIds ?? 1000));
      if (!truncated) {
        // An empty permitted set must not become "no filter".
        if (ids.length === 0) return [];
        return o.retrieve(query, { k, filter: withExtra(build(ids)) });
      }
    }
    const over = o.overfetch ?? 4;
    const rounds = o.maxRounds ?? 3;
    const kept: Doc[] = [];
    const seen = new Set<string>();
    for (let round = 1; round <= rounds && kept.length < k; round++) {
      const docs = await o.retrieve(query, { k: k * over * round, ...(o.extraFilter ? { filter: o.extraFilter } : {}) });
      const fresh = docs.filter((d) => {
        const id = idOf(d);
        return id !== undefined && !seen.has(id);
      });
      const allowed = await filterAllowed(o.access, [...new Set(fresh.map((d) => idOf(d)!))]);
      for (const d of fresh) {
        const id = idOf(d)!;
        seen.add(id);
        if (allowed.has(id) && kept.length < k) kept.push(d);
      }
      if (docs.length < k * over * round) break; // the store has nothing more
    }
    return kept;
  };
}

/* ------------------------- ABAC filter to vector filter ------------------------- */

type Scalar = string | number | boolean;
type AbacFilter =
  | { op: 'true' | 'false' }
  | { op: 'and' | 'or'; args: AbacFilter[] }
  | { op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; field: string; value?: Scalar; ref?: string }
  | { op: 'in' | 'not_in'; field: string; values: Scalar[] }
  | { op: 'contains' | 'not_contains'; field: string; value: Scalar }
  | { op: 'exists' | 'missing'; field: string }
  | { op: string; [k: string]: unknown };

export class UnsupportedFilterError extends Error {}

/**
 * Turn the filter from `atlas.abac.partialEvaluate({ ..., unknowns: ['resource'], resolve_relations: true })` into a
 * Mongo-style metadata filter. `fieldMap` maps policy fields (`resource.department`, `resource.$id`) to metadata
 * keys; unmapped `resource.x` becomes `x`. Throws {@link UnsupportedFilterError} for forms that have no metadata
 * equivalent (arithmetic, `like`, unresolved relations), so a caller never silently widens access.
 */
export function abacFilterToMetadata(f: AbacFilter, fieldMap: Record<string, string> = {}): MetadataFilter | null {
  const field = (name: string) => {
    if (fieldMap[name]) return fieldMap[name]!;
    if (name === 'resource.$id') return 'id';
    if (name.startsWith('resource.')) return name.slice('resource.'.length);
    throw new UnsupportedFilterError(`Field ${name} is not a document field.`);
  };
  const cmp: Record<string, string> = { eq: '$eq', ne: '$ne', lt: '$lt', lte: '$lte', gt: '$gt', gte: '$gte' };
  const walk = (n: AbacFilter): MetadataFilter | null => {
    switch (n.op) {
      case 'true':
        return null;
      case 'false':
        return { $and: [{ id: { $in: [] } }] };
      case 'and': {
        const parts = (n as { args: AbacFilter[] }).args.map(walk);
        if (parts.some((p) => p === null)) {
          const real = parts.filter((p): p is MetadataFilter => p !== null);
          return real.length === 0 ? null : real.length === 1 ? real[0]! : { $and: real };
        }
        return { $and: parts as MetadataFilter[] };
      }
      case 'or': {
        const parts = (n as { args: AbacFilter[] }).args.map(walk);
        if (parts.some((p) => p === null)) return null; // one branch is unconditional
        return { $or: parts as MetadataFilter[] };
      }
      case 'eq': case 'ne': case 'lt': case 'lte': case 'gt': case 'gte': {
        const c = n as { field: string; value?: Scalar; ref?: string };
        if (c.value === undefined) throw new UnsupportedFilterError('Comparing two fields cannot be expressed as a metadata filter.');
        return { [field(c.field)]: { [cmp[n.op]!]: c.value } };
      }
      case 'in': return { [field((n as { field: string }).field)]: { $in: (n as { values: Scalar[] }).values } };
      case 'not_in': return { [field((n as { field: string }).field)]: { $nin: (n as { values: Scalar[] }).values } };
      case 'exists': return { [field((n as { field: string }).field)]: { $exists: true } };
      case 'missing': return { [field((n as { field: string }).field)]: { $exists: false } };
      default:
        throw new UnsupportedFilterError(`The filter operator "${n.op}" has no metadata-filter equivalent.`);
    }
  };
  return walk(f);
}

import { createAuthorizedRetriever, type AccessQuery, type MetadataFilter, type RetrieverOptions } from '@atlasauth/rag';

export { AuthorizationUnavailableError, allowedIds, abacFilterToMetadata, type AccessQuery, type FgaAccess } from '@atlasauth/rag';

/** LlamaIndex.TS `MetadataFilters`. */
export interface LlamaMetadataFilters {
  filters: Array<LlamaMetadataFilter | LlamaMetadataFilters>;
  condition?: 'and' | 'or';
}
export interface LlamaMetadataFilter {
  key: string;
  value: unknown;
  operator: '==' | '!=' | '>' | '<' | '>=' | '<=' | 'in' | 'nin' | 'exists';
}

const OPS: Record<string, LlamaMetadataFilter['operator']> = { $eq: '==', $ne: '!=', $gt: '>', $lt: '<', $gte: '>=', $lte: '<=', $in: 'in', $nin: 'nin', $exists: 'exists' };

/** Convert the Mongo-style filter used by `@atlasauth/rag` to LlamaIndex `MetadataFilters`. */
export function toLlamaFilters(f: MetadataFilter): LlamaMetadataFilters {
  if ('$and' in f || '$or' in f) {
    const cond = '$and' in f ? 'and' : 'or';
    return { condition: cond, filters: ((f.$and ?? f.$or) as MetadataFilter[]).map((x) => ('$and' in x || '$or' in x ? toLlamaFilters(x) : toLlamaFilters(x).filters[0]!)).flat() as LlamaMetadataFilters['filters'] };
  }
  const filters: LlamaMetadataFilter[] = [];
  for (const [key, cond] of Object.entries(f)) {
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      for (const [op, value] of Object.entries(cond)) {
        const operator = OPS[op];
        if (!operator) throw new Error(`Unsupported filter operator ${op}.`);
        filters.push({ key, value, operator });
      }
    } else filters.push({ key, value: cond, operator: '==' });
  }
  return { condition: 'and', filters };
}

export interface AtlasLlamaRetrieverOptions<Node> extends Omit<RetrieverOptions<Node>, 'retrieve' | 'buildFilter'> {
  /** Query the index with these metadata filters (e.g. `index.asRetriever({ similarityTopK: k, filters })`). */
  retrieve: (query: string, opts: { k: number; filters?: LlamaMetadataFilters }) => Promise<Node[]>;
  k?: number;
}

/**
 * A LlamaIndex-style retriever (`retrieve({ query })`) limited to the nodes the asking user may access in Atlas FGA.
 * Node ids are read from `node.node.metadata.id` unless `idOf` says otherwise. Build one per request.
 */
export class AtlasAuthorizedRetriever<Node> {
  private readonly run: (query: string, k?: number) => Promise<Node[]>;
  constructor(private readonly o: AtlasLlamaRetrieverOptions<Node>) {
    const idOf = o.idOf ?? ((n: Node) => {
      const meta = (n as { node?: { metadata?: Record<string, unknown> }; metadata?: Record<string, unknown> }).node?.metadata ?? (n as { metadata?: Record<string, unknown> }).metadata;
      const v = meta?.[o.metadataKey ?? 'id'];
      return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined;
    });
    this.run = createAuthorizedRetriever<Node>({ ...o, idOf, retrieve: (q, { k, filter }) => o.retrieve(q, { k, filters: filter ? toLlamaFilters(filter) : undefined }) });
  }
  retrieve(params: string | { query: string }): Promise<Node[]> {
    return this.run(typeof params === 'string' ? params : params.query, this.o.k ?? 4);
  }
}


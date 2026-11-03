import { createAuthorizedRetriever, type AccessQuery, type MetadataFilter, type RetrieverOptions } from '@atlasauth/rag';

export { AuthorizationUnavailableError, allowedIds, abacFilterToMetadata, type AccessQuery, type FgaAccess } from '@atlasauth/rag';

/** The slice of a LangChain VectorStore used here (`similaritySearch(query, k, filter)`). */
export interface LangChainVectorStore<Doc> {
  similaritySearch(query: string, k?: number, filter?: MetadataFilter): Promise<Doc[]>;
}

export interface AtlasRetrieverOptions<Doc> extends Omit<RetrieverOptions<Doc>, 'retrieve'> {
  vectorStore: LangChainVectorStore<Doc>;
  /** Documents returned per query. Default 4. */
  k?: number;
}

/**
 * A LangChain-compatible retriever (`invoke`, `getRelevantDocuments`) over a vector store, limited to the documents
 * the asking user may access in Atlas FGA. Build one per request (it is bound to a user):
 *
 *   const retriever = new AtlasAuthorizedRetriever({ vectorStore, access: { fga: atlas.fga.store(id), user: 'user:alice', relation: 'viewer', type: 'document' } });
 *   const docs = await retriever.invoke('how do refunds work?');
 *
 * To compose it in a chain, `retriever.asRunnable(RunnableLambda)` with `RunnableLambda` from `@langchain/core/runnables`.
 */
export class AtlasAuthorizedRetriever<Doc> {
  private readonly run: (query: string, k?: number) => Promise<Doc[]>;
  constructor(private readonly o: AtlasRetrieverOptions<Doc>) {
    this.run = createAuthorizedRetriever<Doc>({ ...o, retrieve: (q, { k, filter }) => o.vectorStore.similaritySearch(q, k, filter) });
  }
  invoke(query: string): Promise<Doc[]> {
    return this.run(query, this.o.k ?? 4);
  }
  getRelevantDocuments(query: string): Promise<Doc[]> {
    return this.invoke(query);
  }
  asRunnable<R>(RunnableLambda: { from(fn: (input: string) => Promise<Doc[]>): R }): R {
    return RunnableLambda.from((q) => this.invoke(q));
  }
}

/** One-shot form for a plain `similaritySearch` call site. */
export function authorizedSimilaritySearch<Doc>(vectorStore: LangChainVectorStore<Doc>, query: string, access: AccessQuery, opts: Omit<AtlasRetrieverOptions<Doc>, 'vectorStore' | 'access'> & { k?: number } = {}): Promise<Doc[]> {
  return new AtlasAuthorizedRetriever<Doc>({ ...opts, vectorStore, access }).invoke(query);
}

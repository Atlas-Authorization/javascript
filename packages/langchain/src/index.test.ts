import { describe, expect, it } from 'vitest';
import { AtlasAuthorizedRetriever, authorizedSimilaritySearch, type FgaAccess } from './index';

type D = { pageContent: string; metadata: { id: string } };
const docs: D[] = ['a', 'b', 'c', 'd'].map((id) => ({ pageContent: id, metadata: { id } }));
const vectorStore = {
  async similaritySearch(_q: string, k = 4, filter?: Record<string, unknown>) {
    const ids = (filter as { id?: { $in: string[] } } | undefined)?.id?.$in;
    return docs.filter((d) => !ids || ids.includes(d.metadata.id)).slice(0, k);
  },
};
const fga: FgaAccess = { listObjects: async () => ({ objects: ['document:b', 'document:d'], has_more: false, next_cursor: null }) };
const access = { fga, user: 'user:alice', relation: 'viewer', type: 'document' };

describe('AtlasAuthorizedRetriever', () => {
  it('only returns permitted documents', async () => {
    const r = new AtlasAuthorizedRetriever<D>({ vectorStore, access });
    expect((await r.invoke('q')).map((d) => d.metadata.id)).toEqual(['b', 'd']);
    expect((await r.getRelevantDocuments('q')).length).toBe(2);
    expect((await authorizedSimilaritySearch(vectorStore, 'q', access, { k: 1 })).map((d) => d.metadata.id)).toEqual(['b']);
  });
  it('wraps as a runnable', async () => {
    const r = new AtlasAuthorizedRetriever<D>({ vectorStore, access });
    const lambda = r.asRunnable({ from: (fn) => ({ invoke: fn }) });
    expect((await lambda.invoke('q')).length).toBe(2);
  });
});

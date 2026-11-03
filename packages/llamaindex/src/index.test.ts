import { describe, expect, it } from 'vitest';
import { AtlasAuthorizedRetriever, toLlamaFilters, type FgaAccess } from './index';

type N = { node: { metadata: { id: string } } };
const nodes: N[] = ['a', 'b', 'c', 'd'].map((id) => ({ node: { metadata: { id } } }));
const fga: FgaAccess = { listObjects: async () => ({ objects: ['document:c'], has_more: false, next_cursor: null }) };

describe('llamaindex adapter', () => {
  it('converts filters', () => {
    expect(toLlamaFilters({ $and: [{ lang: 'en' }, { id: { $in: ['a'] } }] })).toEqual({ condition: 'and', filters: [{ key: 'lang', value: 'en', operator: '==' }, { key: 'id', value: ['a'], operator: 'in' }] });
  });
  it('retrieves only permitted nodes with the metadata filter applied', async () => {
    let seen: unknown;
    const r = new AtlasAuthorizedRetriever<N>({
      access: { fga, user: 'user:a', relation: 'viewer', type: 'document' },
      retrieve: async (_q, { filters }) => {
        seen = filters;
        const ids = (filters?.filters[0] as { value: string[] } | undefined)?.value;
        return nodes.filter((n) => !ids || ids.includes(n.node.metadata.id));
      },
    });
    expect((await r.retrieve({ query: 'q' })).map((n) => n.node.metadata.id)).toEqual(['c']);
    expect(seen).toEqual({ condition: 'and', filters: [{ key: 'id', value: ['c'], operator: 'in' }] });
  });
});

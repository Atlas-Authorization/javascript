import { describe, expect, it } from 'vitest';
import { AuthorizationUnavailableError, UnsupportedFilterError, abacFilterToMetadata, allowedIds, createAuthorizedRetriever, type FgaAccess } from './index';

const fgaWith = (allowed: string[], page = 2): FgaAccess & { calls: number } => {
  const api = {
    calls: 0,
    async listObjects(b: { starting_after?: string }) {
      api.calls++;
      const start = b.starting_after ? Number(b.starting_after) : 0;
      const slice = allowed.slice(start, start + page);
      const next = start + page < allowed.length ? String(start + page) : null;
      return { objects: slice.map((i) => `doc:${i}`), has_more: next !== null, next_cursor: next };
    },
    async batchCheck(b: { checks: Array<{ object: string; correlation_id: string }> }) {
      return { result: b.checks.map((c) => ({ correlation_id: c.correlation_id, allowed: allowed.includes(c.object.slice(4)) })) };
    },
  };
  return api;
};
type D = { metadata: { id: string }; text: string };
const corpus: D[] = Array.from({ length: 20 }, (_, i) => ({ metadata: { id: String(i) }, text: `t${i}` }));
const store = async (_q: string, { k, filter }: { k: number; filter?: Record<string, unknown> }) => {
  const ids = filter && (filter as { id?: { $in: string[] } }).id?.$in;
  return corpus.filter((d) => !ids || ids.includes(d.metadata.id)).slice(0, k);
};

describe('allowedIds', () => {
  it('pages through list-objects and strips the type', async () => {
    expect((await allowedIds({ fga: fgaWith(['1', '2', '3', '4', '5']), user: 'user:a', relation: 'viewer', type: 'doc' })).ids).toEqual(['1', '2', '3', '4', '5']);
    expect((await allowedIds({ fga: fgaWith(['1', '2', '3', '4', '5']), user: 'user:a', relation: 'viewer', type: 'doc' }, 3))).toEqual({ ids: ['1', '2', '3'], truncated: true });
  });
  it('fails closed when Atlas errors', async () => {
    const fga: FgaAccess = { listObjects: async () => { throw new Error('down'); } };
    await expect(allowedIds({ fga, user: 'u', relation: 'r', type: 'doc' })).rejects.toBeInstanceOf(AuthorizationUnavailableError);
  });
});

describe('createAuthorizedRetriever', () => {
  const access = (allowed: string[]) => ({ fga: fgaWith(allowed), user: 'user:a', relation: 'viewer', type: 'doc' });
  it('pre-filters the vector query to permitted ids', async () => {
    const r = createAuthorizedRetriever<D>({ retrieve: store, access: access(['3', '7', '9']) });
    expect((await r('q', 2)).map((d) => d.metadata.id)).toEqual(['3', '7']);
  });
  it('returns nothing, not everything, when the user may see nothing', async () => {
    const r = createAuthorizedRetriever<D>({ retrieve: store, access: access([]) });
    expect(await r('q', 4)).toEqual([]);
  });
  it('post-filters with batch-check when the permitted set is too large to pre-filter', async () => {
    const r = createAuthorizedRetriever<D>({ retrieve: store, access: access(['15', '16', '17']), maxPrefilterIds: 2, overfetch: 20, maxRounds: 2 });
    expect((await r('q', 2)).map((d) => d.metadata.id)).toEqual(['15', '16']);
  });
  it('combines an extra filter with the permitted ids', async () => {
    let seen: unknown;
    const r = createAuthorizedRetriever<D>({ retrieve: async (q, o) => { seen = o.filter; return store(q, o); }, access: access(['1']), extraFilter: { lang: 'en' } });
    await r('q');
    expect(seen).toEqual({ $and: [{ lang: 'en' }, { id: { $in: ['1'] } }] });
  });
});

describe('abacFilterToMetadata', () => {
  it('maps simple filters and refuses forms it cannot represent', () => {
    expect(abacFilterToMetadata({ op: 'and', args: [{ op: 'eq', field: 'resource.department', value: 'eng' }, { op: 'in', field: 'resource.$id', values: ['a'] }] })).toEqual({ $and: [{ department: { $eq: 'eng' } }, { id: { $in: ['a'] } }] });
    expect(abacFilterToMetadata({ op: 'true' })).toBeNull();
    expect(abacFilterToMetadata({ op: 'or', args: [{ op: 'true' }, { op: 'eq', field: 'resource.x', value: 1 }] })).toBeNull();
    expect(() => abacFilterToMetadata({ op: 'like', field: 'resource.x', pattern: 'a*' })).toThrow(UnsupportedFilterError);
    expect(() => abacFilterToMetadata({ op: 'eq', field: 'principal.x', value: 1 })).toThrow(UnsupportedFilterError);
  });
});

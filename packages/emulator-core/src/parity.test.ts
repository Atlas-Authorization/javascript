import { describe, expect, it } from 'vitest';
import { defaultParityRequests, diffShape, runParity, shapeOf } from './parity';
import { KEY, makeEngine } from './test-support';

describe('shape diff', () => {
  it('reports missing, extra and mistyped keys, and tolerates null and int/number', () => {
    const a = shapeOf({ id: 'x', n: 1, tags: [{ a: 1 }], only_emu: true, maybe: null });
    const b = shapeOf({ id: 'y', n: 2.5, tags: [{ a: 2 }], only_ref: 1, maybe: 'text' });
    expect(diffShape(a, b).sort()).toEqual(['only_emu: only on the emulator', 'only_ref: only on the reference']);
    expect(diffShape(shapeOf({ n: 'text' }), shapeOf({ n: 1 }))).toEqual(['n: emulator string, reference integer']);
    expect(diffShape(shapeOf({ list: [1] }), shapeOf({ list: 'x' }))).toHaveLength(1);
    expect(diffShape(shapeOf({ a: 1, b: 2 }), shapeOf({ a: 1 }), '', ['b'])).toEqual([]);
  });
});

describe('parity runner', () => {
  it('two emulators agree on the whole default request list (the runner and the list are sound)', async () => {
    const [a, b] = [makeEngine(), makeEngine()];
    const asFetch = (e: ReturnType<typeof makeEngine>) => (async (url: string, init: RequestInit) => e.handle(new Request(url, init))) as unknown as typeof fetch;
    const routed = (async (url: string, init: RequestInit) => (String(url).startsWith('http://a.test') ? asFetch(a)(url, init) : asFetch(b)(url, init))) as unknown as typeof fetch;
    const results = await runParity({ requests: defaultParityRequests, emulator: { baseUrl: 'http://a.test', secretKey: KEY }, reference: { baseUrl: 'http://b.test', secretKey: KEY }, fetchImpl: routed });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.find((r) => r.id === 'user create')?.status.emulator).toBe(201);
    expect(results.find((r) => r.id === 'membership again')?.status.emulator).toBe(409);
  });

  it('flags a difference when the two sides disagree', async () => {
    const a = makeEngine();
    const b = makeEngine({ secretKeys: 'sk_other' });
    const routed = (async (url: string, init: RequestInit) => (String(url).startsWith('http://a.test') ? a : b).handle(new Request(url, init))) as unknown as typeof fetch;
    const results = await runParity({ requests: [{ id: 'list', method: 'GET', path: '/v1/users' }], emulator: { baseUrl: 'http://a.test', secretKey: KEY }, reference: { baseUrl: 'http://b.test', secretKey: KEY }, fetchImpl: routed });
    expect(results[0]).toMatchObject({ ok: false, status: { emulator: 200, reference: 401 } });
  });
});

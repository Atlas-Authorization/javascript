import { setupServer } from 'msw/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreHandlers } from './msw';
import { KEY, makeEngine } from './test-support';

describe('coreHandlers', () => {
  const engine = makeEngine();
  const server = setupServer(...coreHandlers(engine, { baseUrl: 'https://api.atlas.test' }));
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => server.close());

  it('answers fetch calls to the base URL from the engine, sharing its state', async () => {
    const res = await fetch('https://api.atlas.test/v1/organizations', { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Via msw' }) });
    expect(res.status).toBe(200);
    expect(engine.db.organizations.all()).toHaveLength(1);
    expect((await fetch('https://api.atlas.test/v1/organizations')).status).toBe(401);
  });
});

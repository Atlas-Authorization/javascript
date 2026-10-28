import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDocsSource, docsToolSpecs, findDoc, parseDocs, searchDocs } from './docs';
import { createAtlasMcpServer } from './server';

const DOCS = `# Atlas — full documentation

> Concatenated Atlas docs for AI tools.

# Migrate from Clerk to Atlas
Source: https://atlasauth.net/docs/migrate-from-clerk

Move users from Clerk with atlas import --from clerk.

Passwords move verbatim as bcrypt digests.

---

# Session tokens and claims
Source: https://atlasauth.net/docs/session-tokens-and-claims

Verify the session JWT against your instance's JWKS. The token carries sub, sid and org_id.

---

# Webhooks
Source: https://atlasauth.net/docs/webhooks

Atlas signs every webhook. Verify it with verifyWebhook.
`;

const fakeFetch = (body: string, calls: { n: number }, status = 200) =>
  (async () => {
    calls.n++;
    return new Response(body, { status });
  }) as unknown as typeof fetch;

describe('docs parsing and search', () => {
  const pages = parseDocs(DOCS);

  it('splits the concatenated file into titled pages with their URLs', () => {
    expect(pages.map((p) => p.title)).toEqual(['Migrate from Clerk to Atlas', 'Session tokens and claims', 'Webhooks']);
    expect(pages[0]!.url).toBe('https://atlasauth.net/docs/migrate-from-clerk');
    expect(pages[0]!.body).not.toContain('---');
    expect(pages[0]!.body).toContain('bcrypt');
  });

  it('ranks title matches first and returns an excerpt with the terms', () => {
    const hits = searchDocs(pages, 'how do I verify a session token');
    expect(hits[0]!.title).toBe('Session tokens and claims');
    expect(hits[0]!.excerpt).toContain('JWKS');
    expect(searchDocs(pages, 'import users from clerk')[0]!.url).toBe('https://atlasauth.net/docs/migrate-from-clerk');
    expect(searchDocs(pages, 'quantum entanglement')).toEqual([]);
    expect(searchDocs(pages, 'the a of')).toEqual([]);
  });

  it('finds a page by URL, slug or title', () => {
    expect(findDoc(pages, 'https://atlasauth.net/docs/webhooks/')?.title).toBe('Webhooks');
    expect(findDoc(pages, 'migrate-from-clerk')?.title).toBe('Migrate from Clerk to Atlas');
    expect(findDoc(pages, 'session tokens and claims')?.url).toContain('session-tokens');
    expect(findDoc(pages, 'nope')).toBeUndefined();
  });
});

describe('docs source', () => {
  it('caches for the TTL and keeps the last good copy when a refresh fails', async () => {
    let now = 0;
    const calls = { n: 0 };
    let body = DOCS;
    let status = 200;
    const source = createDocsSource({
      fetch: (async () => {
        calls.n++;
        return new Response(body, { status });
      }) as unknown as typeof fetch,
      ttlMs: 1000,
      now: () => now,
    });
    expect(await source.pages()).toHaveLength(3);
    await source.pages();
    expect(calls.n).toBe(1);
    now = 5000;
    status = 503;
    body = '';
    expect(await source.pages()).toHaveLength(3);
    expect(calls.n).toBe(2);
  });

  it('reports a fetch failure as a tool error, never a throw', async () => {
    const [search] = docsToolSpecs(createDocsSource({ fetch: fakeFetch('', { n: 0 }, 500) }));
    const result = await search!.handler({ query: 'webhooks' });
    expect(result.isError).toBe(true);
  });
});

describe('docs tools on the MCP server', () => {
  it('serves docs-only without a key, over a live transport', async () => {
    const { server, tools } = createAtlasMcpServer({ docs: { fetch: fakeFetch(DOCS, { n: 0 }) } });
    expect(tools.map((t) => t.name)).toEqual(['search_atlas_docs', 'read_atlas_doc']);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    expect(listed.tools.find((t) => t.name === 'search_atlas_docs')?.annotations?.readOnlyHint).toBe(true);
    const found = (await client.callTool({ name: 'search_atlas_docs', arguments: { query: 'webhook signature' } })) as {
      content: Array<{ text?: string }>;
    };
    expect(JSON.parse(found.content[0]!.text!)[0].url).toBe('https://atlasauth.net/docs/webhooks');
    const read = (await client.callTool({ name: 'read_atlas_doc', arguments: { page: 'webhooks' } })) as {
      content: Array<{ text?: string }>;
    };
    expect(read.content[0]!.text).toContain('verifyWebhook');

    await client.close();
    await server.close();
  });

  it('an allowlist governs the docs tools too; docs:false leaves them out', () => {
    expect(createAtlasMcpServer({ allowedTools: ['read_atlas_doc'] }).tools.map((t) => t.name)).toEqual(['read_atlas_doc']);
    expect(() => createAtlasMcpServer({ docs: false })).toThrow(/No tools/);
  });
});

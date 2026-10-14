import { describe, expect, it } from 'vitest';
import type { AtlasClient } from '@atlasauth/backend';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAtlasMcpServer } from './server';

/**
 * A minimal in-memory `@atlasauth/backend` stand-in. The real fake lives in
 * `@atlasauth/agent-toolkit/src/testing`, but it is NOT part of that package's
 * public `exports` map (and this task may not modify that package), so we inline
 * the few methods the tools under test call. Several fixtures deliberately carry
 * sensitive fields a model must never see — `private_metadata` and the one-time
 * api-key `secret` — so the sanitization boundary can be proven.
 */
function createFakeBackend(): AtlasClient {
  const user = (id: string) => ({
    object: 'user',
    id,
    first_name: 'Ada',
    public_metadata: { tier: 'pro' },
    private_metadata: { ssn: 'XXX-XX-1234' },
    banned: false,
  });

  const client = {
    users: {
      get: (id: string) => Promise.resolve(user(id)),
      list: () => Promise.resolve({ data: [user('user_1')], has_more: false, next_cursor: null }),
      create: (body: unknown) => Promise.resolve({ ...user('user_new'), body }),
      update: (id: string) => Promise.resolve(user(id)),
      ban: (id: string) => Promise.resolve({ ...user(id), banned: true }),
      unban: (id: string) => Promise.resolve({ ...user(id), banned: false }),
      delete: (id: string) => Promise.resolve({ object: 'user', id, deleted: true }),
    },
    apiKeys: {
      create: () =>
        Promise.resolve({
          object: 'api_key',
          id: 'ak_new',
          prefix: 'ak_live_new',
          name: 'minted',
          // The one-time plaintext secret — must never survive sanitization.
          secret: 'ak_live_SUPERSECRETVALUE',
        }),
    },
  };

  return client as unknown as AtlasClient;
}

/** The text payload of a tool result, concatenated across content parts. */
function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

describe('createAtlasMcpServer — tool registry (safe by default)', () => {
  it('registers only read tools when no allowlist/scopes are given', () => {
    const { tools } = createAtlasMcpServer({ backend: createFakeBackend() });
    const names = tools.map((t) => t.name);

    // Reads are present…
    expect(names).toContain('get_user');
    expect(names).toContain('list_users');
    // …and every write/delete is hidden.
    expect(names).not.toContain('create_user');
    expect(names).not.toContain('delete_user');
    expect(names).not.toContain('create_api_key');
  });

  it('exposes a write tool ONLY when it is allow-listed', () => {
    const hidden = createAtlasMcpServer({ backend: createFakeBackend() });
    expect(hidden.tools.map((t) => t.name)).not.toContain('create_user');

    const exposed = createAtlasMcpServer({
      backend: createFakeBackend(),
      allowedTools: ['create_user'],
    });
    expect(exposed.tools.map((t) => t.name)).toContain('create_user');
  });

  it('honors `resource:verb` scopes, keeping delete gated behind an explicit :delete', () => {
    const { tools } = createAtlasMcpServer({
      backend: createFakeBackend(),
      scopes: ['users:write'],
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain('create_user'); // write granted
    expect(names).toContain('get_user'); // write implies read
    expect(names).not.toContain('delete_user'); // :write never implies :delete
  });
});

describe('createAtlasMcpServer — tool handlers', () => {
  it('executes a read tool and maps the backend result into MCP text content', async () => {
    const { tools } = createAtlasMcpServer({ backend: createFakeBackend() });
    const getUser = tools.find((t) => t.name === 'get_user');
    expect(getUser).toBeDefined();

    const result = await getUser!.handler({ user_id: 'user_42' });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(resultText(result));
    expect(payload).toMatchObject({ id: 'user_42', first_name: 'Ada' });
  });

  it('never leaks a secret or private metadata through a tool result', async () => {
    const { tools } = createAtlasMcpServer({
      backend: createFakeBackend(),
      allowedTools: ['create_api_key', 'get_user'],
    });

    const mint = tools.find((t) => t.name === 'create_api_key')!;
    const minted = await mint.handler({ subject_type: 'user', subject_id: 'user_1', name: 'ci' });
    const mintedText = resultText(minted);
    expect(mintedText).not.toContain('ak_live_SUPERSECRETVALUE');
    expect(mintedText).not.toContain('"secret"');

    const getUser = tools.find((t) => t.name === 'get_user')!;
    const userText = resultText(await getUser.handler({ user_id: 'user_1' }));
    expect(userText).not.toContain('private_metadata');
    expect(userText).not.toContain('XXX-XX-1234');
  });
});

describe('createAtlasMcpServer — over a live (in-memory) MCP transport', () => {
  it('lists the registered tools and round-trips a tool call to a client', async () => {
    const { server } = createAtlasMcpServer({
      backend: createFakeBackend(),
      allowedTools: ['get_user'],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(['get_user']);

    const called = await client.callTool({
      name: 'get_user',
      arguments: { user_id: 'user_7' },
    });
    const text = resultText(called as { content: Array<{ type: string; text?: string }> });
    expect(JSON.parse(text)).toMatchObject({ id: 'user_7' });

    await client.close();
    await server.close();
  });
});

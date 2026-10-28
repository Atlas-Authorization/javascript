import { describe, expect, it } from 'vitest';
import { createConnectionsToolkit } from './connections';
import { toOpenAiAgentsTools } from './openai-agents';
import { toMastraTools } from './mastra';
import { toLlamaIndexTools } from './llamaindex';
import { toAdkTools } from './google-adk';

const calls: { url: string; init: RequestInit }[] = [];
const respond = (status: number, body: unknown) => (async (url: unknown, init?: RequestInit) => {
  calls.push({ url: String(url), init: init ?? {} });
  return new Response(JSON.stringify(body), { status });
}) as typeof fetch;

describe('connections toolkit', () => {
  it('lists, runs actions and relays as the agent, never exposing a token tool', async () => {
    calls.length = 0;
    const tools = createConnectionsToolkit({ baseUrl: 'https://api.example.com/', agentToken: () => 'agt', publishableKey: 'pk_x', fetch: respond(200, { object: 'list', data: [] }) });
    expect(tools.map((t) => t.name)).toEqual(['list_connections', 'list_connection_actions', 'run_connection_action', 'call_provider_api']);
    await tools[0]!.execute({});
    const run = tools.find((t) => t.name === 'run_connection_action')!;
    await run.execute(run.schema.parse({ connection: 'provider:github', action: 'create_issue', input: { title: 't' } }));
    expect(calls[0]!.url).toBe('https://api.example.com/v1/agents/connections');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer agt');
    expect(calls[1]!.url).toBe('https://api.example.com/v1/agents/connections/provider%3Agithub/actions/create_issue');
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({ input: { title: 't' } });
  });
  it('turns a 402 into a result the model can act on', async () => {
    const tools = createConnectionsToolkit({
      baseUrl: 'https://api.example.com', agentToken: 'agt',
      fetch: respond(402, { errors: [{ code: 'CONNECTION_REQUIRED', message: 'No credential.', meta: { reason: 'not_connected', authorize_url: 'https://p.example/authorize' } }] }),
    });
    const out = (await tools[0]!.execute({})) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: false, status: 402, authorize_url: 'https://p.example/authorize', reason: 'not_connected' });
  });
  it('offers request_connection_access only with the agent credentials', () => {
    const base = { baseUrl: 'https://a.example', agentToken: 't', fetch: respond(200, {}) };
    expect(createConnectionsToolkit(base).some((t) => t.name === 'request_connection_access')).toBe(false);
    expect(createConnectionsToolkit({ ...base, agentId: 'a', agentSecret: 's' }).some((t) => t.name === 'request_connection_access')).toBe(true);
  });
});

describe('framework adapters', () => {
  const tools = createConnectionsToolkit({ baseUrl: 'https://a.example', agentToken: 't', fetch: respond(200, { ok: true }) });
  it('maps onto the OpenAI Agents tool() shape with non-strict parameters', async () => {
    const made: any[] = [];
    toOpenAiAgentsTools(tools, { tool: (d) => (made.push(d), d) });
    expect(made).toHaveLength(tools.length);
    expect(made[0]).toMatchObject({ name: 'list_connections', strict: false });
    expect(JSON.parse(await made[0].execute({}))).toEqual({ ok: true });
  });
  it('maps onto Mastra createTool keyed by id', async () => {
    const out = toMastraTools(tools, { createTool: (d) => d }) as Record<string, any>;
    expect(Object.keys(out)).toContain('run_connection_action');
    expect(out.list_connections.inputSchema).toBeDefined();
    expect(await out.list_connections.execute({})).toEqual({ ok: true });
  });
  it('maps onto LlamaIndex tool(fn, config)', async () => {
    const made: any[] = [];
    toLlamaIndexTools(tools, { tool: (fn, cfg) => (made.push({ fn, cfg }), cfg) });
    expect(made[0].cfg).toMatchObject({ name: 'list_connections' });
    expect(JSON.parse(await made[0].fn({}))).toEqual({ ok: true });
  });
  it('maps onto ADK FunctionTool and wraps non-object results', async () => {
    class Fake { constructor(public def: any) {} }
    const out = toAdkTools(tools, { FunctionTool: Fake as never }) as Fake[];
    expect(out[0]!.def.name).toBe('list_connections');
    expect(await out[0]!.def.execute({})).toEqual({ ok: true });
  });
  it('rejects arguments that fail the schema before calling out', async () => {
    const out = toMastraTools(tools, { createTool: (d) => d }) as Record<string, any>;
    await expect(out.run_connection_action.execute({})).rejects.toThrow();
  });
});

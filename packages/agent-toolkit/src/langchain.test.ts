import { describe, expect, it } from 'vitest';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { createAtlasToolkit } from './index';
import { toLangChainTools, type DynamicStructuredToolCtor } from './langchain';
import { createFakeBackend } from './testing/fake-backend';

describe('langchain adapter', () => {
  function build(scopes: string[] = ['*:*']) {
    const fake = createFakeBackend();
    const toolkit = createAtlasToolkit({ backend: fake.client, scopes });
    return { toolkit, fake };
  }

  it('yields real DynamicStructuredTool instances with name + schema + func', () => {
    const { toolkit } = build(['users:read']);
    // Inject the imported class so the produced instances are identity-equal to
    // it: the lazy `require` default would load @langchain/core's CJS build,
    // a different copy than this ESM import, defeating `instanceof` across the
    // module boundary even though both are the same class.
    // Cast via `unknown`: the real class's generic constructor is structurally
    // deep enough to trip TS2589 against the adapter's minimal ctor type; this
    // keeps the check shallow without weakening what the test proves at runtime.
    const tools = toLangChainTools(toolkit, {
      DynamicStructuredTool: DynamicStructuredTool as unknown as DynamicStructuredToolCtor,
    });
    const getUser = tools.find((t) => t.name === 'get_user')!;
    expect(getUser).toBeInstanceOf(DynamicStructuredTool);
    expect(getUser.name).toBe('get_user');
    expect(typeof getUser.description).toBe('string');
    expect(getUser.schema.safeParse({ user_id: 'u1' }).success).toBe(true);
    expect(typeof getUser.func).toBe('function');
  });

  it('only maps exposed (scoped) tools', () => {
    const { toolkit } = build(['users:read']);
    const names = toLangChainTools(toolkit).map((t) => t.name);
    expect(names).toContain('get_user');
    expect(names).not.toContain('delete_user');
  });

  it('invoking a tool calls the backend and returns a JSON string, sanitized', async () => {
    const { toolkit, fake } = build();
    const getUser = toLangChainTools(toolkit).find((t) => t.name === 'get_user')!;
    // `.func` is the exposed executor (name + schema + func is the tool shape);
    // call it directly to exercise the mapping end-to-end.
    const out = await getUser.func({ user_id: 'user_3' });
    expect(fake.last()).toEqual({ method: 'users.get', args: ['user_3'] });
    expect(typeof out).toBe('string');
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.id).toBe('user_3');
    expect(parsed).not.toHaveProperty('private_metadata');
    expect(out).not.toContain('XXX-XX-1234');
  });

  it('accepts an injected DynamicStructuredTool class (DI, no lazy require)', () => {
    const { toolkit } = build(['users:read']);
    const seen: string[] = [];
    const FakeCtor = class {
      name: string;
      description: string;
      schema: unknown;
      func: (i: Record<string, unknown>) => Promise<string>;
      constructor(fields: {
        name: string;
        description: string;
        schema: unknown;
        func: (i: Record<string, unknown>) => Promise<string>;
      }) {
        this.name = fields.name;
        this.description = fields.description;
        this.schema = fields.schema;
        this.func = fields.func;
        seen.push(fields.name);
      }
    } as unknown as DynamicStructuredToolCtor;

    const tools = toLangChainTools(toolkit, { DynamicStructuredTool: FakeCtor });
    expect(seen).toContain('get_user');
    expect(tools[0]!.name).toBe('get_user');
  });
});

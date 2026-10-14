import { describe, expect, it } from 'vitest';
import { createAtlasToolkit } from './index';
import { toAiSdkTools } from './ai-sdk';
import { createFakeBackend } from './testing/fake-backend';

describe('ai-sdk adapter', () => {
  function tools(scopes: string[] = ['*:*']) {
    const fake = createFakeBackend();
    const toolkit = createAtlasToolkit({ backend: fake.client, scopes });
    return { aiTools: toAiSdkTools(toolkit), fake, toolkit };
  }

  it('yields objects with description + parameters + execute, keyed by tool name', () => {
    const { aiTools } = tools();
    const getUser = aiTools.get_user!;
    expect(getUser).toBeDefined();
    expect(typeof getUser.description).toBe('string');
    expect(getUser.description.length).toBeGreaterThan(0);
    expect(typeof getUser.execute).toBe('function');
    // `parameters` is a Zod schema — it can parse.
    expect(getUser.parameters.safeParse({ user_id: 'user_1' }).success).toBe(true);
    expect(getUser.parameters.safeParse({}).success).toBe(false);
  });

  it('only maps the exposed (scoped) tools', () => {
    const { aiTools } = tools(['users:read']);
    expect(aiTools.get_user).toBeDefined();
    expect(aiTools.delete_user).toBeUndefined();
    expect(aiTools.get_organization).toBeUndefined();
  });

  it('execute calls the backend and returns a sanitized result', async () => {
    const { aiTools, fake } = tools();
    const result = (await aiTools.get_user!.execute({ user_id: 'user_5' })) as Record<string, unknown>;
    expect(fake.last()).toEqual({ method: 'users.get', args: ['user_5'] });
    expect(result.id).toBe('user_5');
    expect(result).not.toHaveProperty('private_metadata');
  });

  it('accepts a raw list of bound tools too', () => {
    const { toolkit } = tools();
    const aiTools = toAiSdkTools(toolkit.all);
    expect(Object.keys(aiTools).length).toBe(toolkit.all.length);
  });
});

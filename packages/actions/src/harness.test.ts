import { describe, expect, it } from 'vitest';
import { createTestEvent, runAction, runScript } from './harness';
import { defineAction, type PostLoginApi, type PostLoginEvent } from './types';

describe('createTestEvent', () => {
  it('populates a post_login event with a real user id', () => {
    const event = createTestEvent('post_login');
    expect(event.user.id).toBe('user_sample');
    expect(event.user.email).toBe('sample@example.com');
    expect(event.connection.strategy).toBe('password');
    expect(event.request.ip).toBeTruthy();
    expect(event.secrets).toEqual({});
  });

  it('gives pre_user_registration a null user id (no row yet)', () => {
    const event = createTestEvent('pre_user_registration');
    expect(event.user.id).toBeNull();
  });

  it('merges overrides one level deep without dropping defaults', () => {
    const event = createTestEvent('post_login', {
      user: { email: 'ada@acme.com', metadata: { roles: ['admin'] } },
      secrets: { CLAIM_NAMESPACE: 'https://acme.test' },
    });
    expect(event.user.email).toBe('ada@acme.com');
    expect(event.user.metadata).toEqual({ roles: ['admin'] });
    // Untouched defaults survive the merge.
    expect(event.user.emailVerified).toBe(true);
    expect(event.connection.strategy).toBe('password');
    expect(event.secrets.CLAIM_NAMESPACE).toBe('https://acme.test');
  });
});

describe('runAction — captures api calls', () => {
  it('captures access.deny with its reason', async () => {
    const action = defineAction('post_login', async (event, api) => {
      if (!event.user.emailVerified) api.access.deny('Verify your email first.');
    });
    const result = await runAction(action, createTestEvent('post_login', { user: { emailVerified: false } }));
    expect(result.denied).toBe(true);
    expect(result.denyReason).toBe('Verify your email first.');
    expect(result.calls).toContainEqual({ method: 'access.deny', args: ['Verify your email first.'] });
  });

  it('defaults the deny reason when none is given', async () => {
    const result = await runAction(
      defineAction('post_login', (_event, api) => api.access.deny()),
      createTestEvent('post_login'),
    );
    expect(result.denied).toBe(true);
    expect(result.denyReason).toBe('Access denied.');
  });

  it('captures setCustomClaim on both token buckets and setAppMetadata', async () => {
    const action = defineAction('post_login', (_event, api) => {
      api.idToken.setCustomClaim('role', 'admin');
      api.accessToken.setCustomClaim('role', 'admin');
      api.user.setAppMetadata('onboarded', true);
      api.console.log('done', { ok: 1 });
    });
    const result = await runAction(action, createTestEvent('post_login'));
    expect(result.idTokenClaims).toEqual({ role: 'admin' });
    expect(result.accessTokenClaims).toEqual({ role: 'admin' });
    expect(result.appMetadata).toEqual({ onboarded: true });
    expect(result.logs).toEqual(['done {"ok":1}']);
    expect(result.denied).toBe(false);
  });

  it('accepts a bare handler as well as a DefinedAction', async () => {
    // A bare handler (not a DefinedAction), with explicit param types.
    const result = await runAction(
      (_event: PostLoginEvent, api: PostLoginApi) => api.idToken.setCustomClaim('x', 1),
      createTestEvent('post_login'),
    );
    expect(result.idTokenClaims).toEqual({ x: 1 });
  });

  it('captures a thrown error instead of propagating it', async () => {
    const result = await runAction(
      () => {
        throw new Error('boom');
      },
      createTestEvent('post_login'),
    );
    expect(result.error).toBe('boom');
    expect(result.denied).toBe(false);
  });

  it('truncates a claim key to 256 chars, matching the isolate', async () => {
    const long = 'k'.repeat(300);
    const result = await runAction(
      defineAction('post_login', (_e, api) => api.idToken.setCustomClaim(long, 1)),
      createTestEvent('post_login'),
    );
    expect(Object.keys(result.idTokenClaims)[0]!.length).toBe(256);
  });
});

describe('runScript — the deployable code body', () => {
  it('runs a raw script that denies', async () => {
    const result = await runScript(
      `if (!event.user.emailVerified) { api.access.deny('nope'); }`,
      createTestEvent('post_login', { user: { emailVerified: false } }),
    );
    expect(result.denied).toBe(true);
    expect(result.denyReason).toBe('nope');
  });

  it('a defineAction.toCode() round-trips to the same result as the handler', async () => {
    const action = defineAction('post_login', async (_event, api) => {
      api.idToken.setCustomClaim('via', 'code');
    });
    const viaHandler = await runAction(action, createTestEvent('post_login'));
    const viaCode = await runScript(action.toCode(), createTestEvent('post_login'));
    expect(viaCode.idTokenClaims).toEqual(viaHandler.idTokenClaims);
  });

  it('a script using a forbidden host global (bare console) fails, as it would in the isolate', async () => {
    // The isolate has no bare `console` (logging is `api.console.log`); the
    // harness shadows it to undefined, so using it throws and is captured.
    const result = await runScript(`console.log('hi')`, createTestEvent('post_login'));
    expect(result.error).toBeTruthy();
    expect(result.logs).toEqual([]); // nothing reached the real stdout
  });
});

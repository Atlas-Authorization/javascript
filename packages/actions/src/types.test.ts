import { describe, expect, it } from 'vitest';
import { ACTION_TRIGGERS, defineAction } from './types';

/**
 * These assertions are mostly about the COMPILER: the file must typecheck, and
 * the `@ts-expect-error` lines must each flag a real type error. `tsc --noEmit`
 * (the package `typecheck`) is the real gate; the runtime `expect`s just keep
 * vitest from reporting an empty file.
 */
describe('typed event/api per trigger', () => {
  it('post_login exposes the full api and a populated user id', () => {
    const action = defineAction('post_login', (event, api) => {
      const id: string = event.user.id; // string, not string | null
      api.access.deny('x');
      api.accessToken.setCustomClaim('a', 1);
      api.idToken.setCustomClaim('b', 2);
      api.user.setAppMetadata('c', 3);
      api.console.log(id);
    });
    expect(action.trigger).toBe('post_login');
  });

  it('pre_user_registration has a null user id and can deny', () => {
    const action = defineAction('pre_user_registration', (event, api) => {
      const id: null = event.user.id; // id is null here
      api.access.deny('blocked');
      void id;
    });
    expect(action.trigger).toBe('pre_user_registration');
  });

  it('post_user_registration has NO access api (deny is ignored by the host)', () => {
    const action = defineAction('post_user_registration', (event, api) => {
      api.user.setAppMetadata('welcomed', true);
      api.console.log(event.user.id);
      // @ts-expect-error — api.access does not exist on a side-effect trigger.
      api.access.deny('nope');
    });
    expect(action.trigger).toBe('post_user_registration');
  });

  it('a handler rejects the wrong trigger shape at compile time', () => {
    defineAction('pre_user_registration', (event) => {
      // @ts-expect-error — pre_user_registration user.id is null, not string.
      const id: string = event.user.id;
      void id;
    });
    expect(ACTION_TRIGGERS).toContain('post_login');
  });
});

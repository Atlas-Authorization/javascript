import { describe, expect, it } from 'vitest';
import {
  addAtlasCommands,
  type AtlasSignInParams,
  type CypressStatic,
  type CyChainable,
} from './cypress';
import { TESTING_TOKEN_PARAM } from './playwright';

/** A Cypress stub that captures the registered command. */
function cypressStub(env: Record<string, unknown>): {
  Cypress: CypressStatic;
  getCommand: () => ((params: AtlasSignInParams) => unknown) | undefined;
} {
  let registered: ((params: AtlasSignInParams) => unknown) | undefined;
  return {
    getCommand: () => registered,
    Cypress: {
      Commands: {
        add: (name, fn) => {
          if (name === 'atlasSignIn') registered = fn as unknown as (p: AtlasSignInParams) => unknown;
        },
      },
      env: (key: string) => env[key],
    },
  };
}

/** A `cy` chain stub: records requests/cookies, feeds queued responses to `.then`. */
function cyStub(responses: unknown[]): {
  cy: CyChainable;
  requests: Array<Record<string, unknown>>;
  cookies: Array<{ name: string; value: string }>;
} {
  const requests: Array<Record<string, unknown>> = [];
  const cookies: Array<{ name: string; value: string }> = [];
  let next = 0;
  let last: unknown;
  const chain: CyChainable = {
    request: (options) => {
      requests.push(options as Record<string, unknown>);
      last = responses[next++];
      return chain;
    },
    then: (fn) => {
      const out = fn(last);
      return (out && typeof (out as CyChainable).then === 'function' ? (out as CyChainable) : chain);
    },
    setCookie: (name, value) => {
      cookies.push({ name, value });
      return chain;
    },
    log: () => chain,
  };
  return { cy: chain, requests, cookies };
}

describe('addAtlasCommands', () => {
  it('registers a cy.atlasSignIn command', () => {
    const { Cypress, getCommand } = cypressStub({});
    addAtlasCommands({ Cypress, frontendApiUrl: 'https://fapi.acme.test' });
    expect(typeof getCommand()).toBe('function');
  });

  it('fail-soft: is a no-op outside a Cypress run', () => {
    expect(() => addAtlasCommands({})).not.toThrow();
  });

  it('drives the FAPI sign-in, carrying the testing token, and sets the session cookie', () => {
    const { Cypress, getCommand } = cypressStub({
      ATLAS_FAPI_URL: 'https://fapi.acme.test',
      ATLAS_TESTING_TOKEN: 'tt_cy',
    });
    const { cy, requests, cookies } = cyStub([
      { body: { response: { created_session_id: 'si_1' } } },
      { body: { client: { sessions: [{ last_active_token: { jwt: 'sess.jwt.cy' } }] } } },
    ]);

    addAtlasCommands({ Cypress, cy });
    getCommand()!({ identifier: 'e2e@acme.test', password: 's3cret' });

    expect(requests).toHaveLength(2);
    // Step 1: open the sign-in with the identifier + testing token.
    expect(requests[0]!.url).toBe('https://fapi.acme.test/v1/client/sign_ins');
    expect((requests[0]!.qs as Record<string, string>)[TESTING_TOKEN_PARAM]).toBe('tt_cy');
    expect((requests[0]!.body as { identifier: string }).identifier).toBe('e2e@acme.test');
    // Step 2: attempt the password first factor on the created sign-in.
    expect(requests[1]!.url).toBe('https://fapi.acme.test/v1/client/sign_ins/si_1/attempt_first_factor');
    expect((requests[1]!.body as { strategy: string; password: string })).toMatchObject({
      strategy: 'password',
      password: 's3cret',
    });
    // The returned session JWT is written as the session cookie.
    expect(cookies).toEqual([{ name: '__session', value: 'sess.jwt.cy' }]);
  });

  it('omits the testing-token query param when none is configured', () => {
    const { Cypress, getCommand } = cypressStub({ ATLAS_FAPI_URL: 'https://fapi.acme.test' });
    const { cy, requests } = cyStub([{ body: {} }, { body: {} }]);
    addAtlasCommands({ Cypress, cy });
    getCommand()!({ identifier: 'x', password: 'y' });
    expect(requests[0]!.qs).toEqual({});
  });

  it('respects a custom cookie name', () => {
    const { Cypress, getCommand } = cypressStub({ ATLAS_TESTING_TOKEN: 't' });
    const { cy, cookies } = cyStub([
      { body: {} },
      { body: { client: { sessions: [{ last_active_token: { jwt: 'j' } }] } } },
    ]);
    addAtlasCommands({ Cypress, cy, frontendApiUrl: 'https://f.test', cookieName: '__atlas_session' });
    getCommand()!({ identifier: 'x', password: 'y' });
    expect(cookies).toEqual([{ name: '__atlas_session', value: 'j' }]);
  });
});

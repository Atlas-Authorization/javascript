/**
 * Cypress adapter for `@atlasauth/testing`.
 *
 * `cypress` is an OPTIONAL peer, so this module imports nothing from it and
 * models the globals it touches — `Cypress` (for `Commands.add` and `env`) and
 * the `cy` command chain — as minimal STRUCTURAL interfaces. The real Cypress
 * types are supersets, so a real `Cypress`/`cy` satisfy them, and the package
 * compiles with Cypress absent. A guarded `/// <reference types="cypress" />`
 * is intentionally OMITTED: it would hard-fail the build when the optional peer
 * is not installed. In a project that HAS Cypress, call {@link addAtlasCommands}
 * from your support file and the real `cy.atlasSignIn` typing comes from the
 * `declare global` block below once Cypress's own `Chainable` is in scope.
 *
 * ```ts
 * // cypress/support/e2e.ts
 * import { addAtlasCommands } from '@atlasauth/testing/cypress';
 * addAtlasCommands({ frontendApiUrl: Cypress.env('ATLAS_FAPI_URL') });
 *
 * // a spec — the testing token must be in Cypress.env('ATLAS_TESTING_TOKEN'),
 * // minted in Node via getTestingToken() in your setupNodeEvents / before:run.
 * cy.atlasSignIn({ identifier: 'e2e@acme.test', password: 's3cret' });
 * ```
 */
import { TESTING_TOKEN_PARAM } from './playwright';

/** Parameters for the registered `cy.atlasSignIn(...)` command. */
export interface AtlasSignInParams {
  /** Email, username or phone the test user signs in with. */
  identifier: string;
  /** The test user's password (password strategy). */
  password: string;
}

/** Structural subset of Cypress's `Commands`. */
export interface CypressCommands {
  add(name: string, fn: (...args: never[]) => unknown): void;
}

/** Structural subset of the `Cypress` global. */
export interface CypressStatic {
  Commands: CypressCommands;
  env(key: string): unknown;
}

/** Structural subset of the `cy` command chain used by the sign-in command. */
export interface CyChainable {
  request(options: {
    method: string;
    url: string;
    qs?: Record<string, string>;
    body?: unknown;
    failOnStatusCode?: boolean;
  }): CyChainable;
  then(fn: (subject: unknown) => unknown): CyChainable;
  setCookie(name: string, value: string, options?: Record<string, unknown>): CyChainable;
  log(message: string): CyChainable;
}

/** Options for {@link addAtlasCommands}. */
export interface AddAtlasCommandsOptions {
  /**
   * The instance's FAPI origin, e.g. `https://fapi.acme.atlasauth.net`. Defaults
   * to `Cypress.env('ATLAS_FAPI_URL')`.
   */
  frontendApiUrl?: string;
  /**
   * The Cypress env key holding the testing token minted in Node.
   * @default 'ATLAS_TESTING_TOKEN'
   */
  testingTokenEnvKey?: string;
  /**
   * The session-cookie name the FAPI sets. @default '__session'
   */
  cookieName?: string;
  /** Injectable `Cypress` global, for unit testing. Defaults to `globalThis.Cypress`. */
  Cypress?: CypressStatic;
  /** Injectable `cy` chain, for unit testing. Defaults to `globalThis.cy`. */
  cy?: CyChainable;
}

/** The FAPI session responses this helper reads a session JWT out of. */
interface FapiSignInResponse {
  body?: {
    response?: {
      created_session_id?: string;
    };
    client?: {
      sessions?: Array<{ id?: string; last_active_token?: { jwt?: string } }>;
      last_active_session_id?: string;
    };
  };
}

// A real Cypress project augments its own `Chainable` so `cy.atlasSignIn` is
// typed. Guarded behind `cypress` being resolvable so it is a no-op here (the
// optional peer is absent) yet merges correctly where Cypress IS installed.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cypress {
    interface Chainable {
      /**
       * Sign a test user in through the Atlas FAPI using the testing token.
       * Returns the Cypress chain (bare `Chainable` so the type is valid both
       * with Cypress installed — its `Chainable` defaults its type argument —
       * and against this package's own structural fallback).
       */
      atlasSignIn(params: AtlasSignInParams): Chainable;
    }
  }
}

/**
 * Register the `cy.atlasSignIn({ identifier, password })` custom command.
 *
 * The command signs the user in by driving the Atlas FAPI directly — far faster
 * and less flaky than clicking through the hosted UI — and carries the testing
 * token so bot protection is waived:
 *
 * 1. `POST {fapi}/v1/client/sign_ins?__atlas_testing_token=<t>` with the
 *    `identifier` to open a sign-in.
 * 2. `POST .../attempt_first_factor` with `strategy=password` + the password.
 * 3. The FAPI sets the session cookie on the response; the session JWT returned
 *    is also written via `cy.setCookie` so the very next `cy.visit` is signed in.
 *
 * The testing token is read from `Cypress.env(testingTokenEnvKey)` — mint it in
 * Node (your `setupNodeEvents`/`before:run`) with {@link getTestingToken} and
 * stash it there; a secret key must never reach the browser.
 *
 * **Fail-soft:** outside a Cypress run (no `Cypress.Commands`) it is a no-op, so
 * importing the module can never crash a non-Cypress process.
 */
export function addAtlasCommands(options: AddAtlasCommandsOptions = {}): void {
  const g = globalThis as unknown as { Cypress?: CypressStatic; cy?: CyChainable };
  const CypressRef = options.Cypress ?? g.Cypress;
  if (!CypressRef || typeof CypressRef.Commands?.add !== 'function') {
    // Not inside a Cypress run — nothing to register.
    return;
  }

  const tokenEnvKey = options.testingTokenEnvKey ?? 'ATLAS_TESTING_TOKEN';
  const cookieName = options.cookieName ?? '__session';

  CypressRef.Commands.add('atlasSignIn', ((params: AtlasSignInParams) => {
    const cy = options.cy ?? g.cy;
    if (!cy) return;

    const fapi = (options.frontendApiUrl ?? String(CypressRef.env('ATLAS_FAPI_URL') ?? '')).replace(
      /\/+$/,
      '',
    );
    const token = String(CypressRef.env(tokenEnvKey) ?? '');
    const qs: Record<string, string> = token ? { [TESTING_TOKEN_PARAM]: token } : {};

    cy.log('atlasSignIn: creating sign-in via FAPI');

    return cy
      .request({
        method: 'POST',
        url: `${fapi}/v1/client/sign_ins`,
        qs,
        body: { identifier: params.identifier },
        failOnStatusCode: false,
      })
      .then((signIn) => {
        const id = (signIn as FapiSignInResponse)?.body?.response?.created_session_id;
        return cy
          .request({
            method: 'POST',
            url: `${fapi}/v1/client/sign_ins/${encodeURIComponent(String(id ?? 'current'))}/attempt_first_factor`,
            qs,
            body: { strategy: 'password', password: params.password },
            failOnStatusCode: false,
          })
          .then((attempt) => {
            const jwt = (attempt as FapiSignInResponse)?.body?.client?.sessions?.[0]
              ?.last_active_token?.jwt;
            if (jwt) {
              cy.setCookie(cookieName, jwt, { httpOnly: false });
            }
          });
      });
  }) as (...args: never[]) => unknown);
}

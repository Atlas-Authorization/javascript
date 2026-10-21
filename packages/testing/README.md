# @atlasauth/testing

Test helpers that let automated end-to-end suites — [Playwright](https://playwright.dev)
and [Cypress](https://www.cypress.io) — sign a user into an Atlas-backed app
**without tripping the instance's bot/abuse protection**. The Atlas peer of
[`@clerk/testing`](https://www.npmjs.com/package/@clerk/testing).

A headless browser that signs in over and over looks, to Atlas, exactly like the
credential-stuffing and abuse that bot protection exists to stop — so CAPTCHA
challenges, device fingerprinting and velocity checks will challenge or block it.
A **testing token** is a short-lived credential, minted from your secret key,
that marks the requests carrying it as a known automated test, so those checks
are waived for them (and only them).

Everything here is **fail-soft**: if a token can't be minted, the helpers resolve
to `null` / no-op rather than throw, so a flaky network never takes your suite
down before the first test.

## Offline unit tests

For backend unit tests that need no browser and no network, this package also
exports `createTestIssuer` (from `@atlasauth/backend`). It mints session tokens and
ID tokens with a throwaway key, serves discovery, the JWKS and a token endpoint
through its own `fetch`, and forges the six bad tokens a verifier must refuse
(`TEST_TOKEN_TAMPERS`). See the `@atlasauth/backend` README.

```ts
import { createTestIssuer } from '@atlasauth/testing';

const fx = await createTestIssuer();
const token = await fx.mintIdToken({ sub: 'user_1' }, { aud: fx.clientId, nonce: 'n-1' });
```

## Install

```sh
pnpm add -D @atlasauth/testing
```

`@playwright/test` and `cypress` are **optional** peer dependencies — install only
the one your suite uses; neither is required to add this package.

## Core

```ts
import { getTestingToken, atlasSetup } from '@atlasauth/testing';

// One-shot:
const token = await getTestingToken({ secretKey: process.env.ATLAS_SECRET_KEY! });

// Or cache one token for the whole run (minted lazily on first getToken()):
const atlas = atlasSetup({ secretKey: process.env.ATLAS_SECRET_KEY! });
const t = await atlas.getToken(); // same value on every later call, one round-trip
```

The **secret key never reaches the browser** — only the short-lived token does.
Keep `ATLAS_SECRET_KEY` in your CI secrets / `.env`, out of page and spec code.

## Playwright

```ts
import { test } from '@playwright/test';
import { setupAtlasTestingToken } from '@atlasauth/testing/playwright';

test.beforeEach(async ({ page }) => {
  await setupAtlasTestingToken({ page, secretKey: process.env.ATLAS_SECRET_KEY! });
});

test('signs in', async ({ page }) => {
  await page.goto('/'); // Atlas FAPI calls now carry __atlas_testing_token
});
```

`setupAtlasTestingToken` mints a token and installs a `page.route(...)` handler
that appends it as the `__atlas_testing_token` query parameter to the instance's
FAPI requests. Pass `frontendApiUrl` to scope interception to a single origin.

## Cypress

Mint the token in Node (where the secret key is safe) and stash it in
`Cypress.env`, then register the command in your support file:

```ts
// cypress.config.ts — setupNodeEvents
import { getTestingToken } from '@atlasauth/testing';
on('before:run', async () => {
  config.env.ATLAS_TESTING_TOKEN = await getTestingToken({
    secretKey: process.env.ATLAS_SECRET_KEY!,
  });
});

// cypress/support/e2e.ts
import { addAtlasCommands } from '@atlasauth/testing/cypress';
addAtlasCommands({ frontendApiUrl: Cypress.env('ATLAS_FAPI_URL') });

// a spec
cy.atlasSignIn({ identifier: 'e2e@acme.test', password: 's3cret' });
```

`cy.atlasSignIn` drives the Atlas FAPI directly (open sign-in → attempt the
password first factor) carrying the testing token, then writes the returned
session JWT as the session cookie so the next `cy.visit` is signed in.

## How the testing token is minted

`POST {apiUrl}/v1/testing_tokens` with `Authorization: Bearer <secretKey>`; the
2xx body `{ token }` is the token. `apiUrl` defaults to `https://api.atlasauth.net`.

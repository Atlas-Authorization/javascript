# @atlasauth/actions

Typed SDK, local test harness and template gallery for **Atlas Actions** — a
tenant's own JavaScript run at fixed points in the auth pipeline (`post_login`,
`pre_user_registration`, `post_user_registration`) inside a hardened V8 isolate.

The Atlas peer of `@auth0/actions` + `@kilterset/auth0-actions-testing`.

## Author

```ts
import { defineAction } from '@atlasauth/actions';

export const action = defineAction('post_login', async (event, api) => {
  if (!event.user.emailVerified) {
    api.access.deny('Please verify your email before signing in.');
    return;
  }
  const roles = Array.isArray(event.user.metadata.roles) ? event.user.metadata.roles : [];
  api.idToken.setCustomClaim('https://atlasauth.net/roles', roles);
});
```

`event` and `api` are typed per trigger. Inside an action there is **only**
`event` and `api` — no `require`, `fetch`, `process`, or bare `console`
(logging is `api.console.log`). The isolate runs your code as
`(async function () { <code> })()` with those two in scope.

### event (per trigger)

| field | shape |
| --- | --- |
| `user` | `{ id, email, emailVerified, firstName, lastName, username, metadata }` — `id` is `string` for `post_login` / `post_user_registration`, `null` for `pre_user_registration` |
| `connection` | `{ strategy, method? }` — strategy: `password`, `oauth_google`, `passkey`, `sso_<id>`, `lti`, …; method (registration triggers only): `password`, `email_code`, `email_link`, `phone_code`, `social`, `enterprise_sso`, `web3_wallet`, `lti`, `passkey` |
| `request` | `{ ip, userAgent }` |
| `secrets` | `Record<string, string>` — this action's own decrypted secrets |

### api (per trigger)

| method | post_login | pre_user_registration | post_user_registration |
| --- | :-: | :-: | :-: |
| `api.access.deny(reason?)` | ✓ | ✓ | — (ignored by host) |
| `api.accessToken.setCustomClaim(name, value)` | ✓ | ✓ | — |
| `api.idToken.setCustomClaim(name, value)` | ✓ | ✓ | — |
| `api.user.setAppMetadata(name, value)` | ✓ | ✓ | ✓ |
| `api.console.log(...args)` | ✓ | ✓ | ✓ |

`post_login` and `pre_user_registration` are **fail-closed** (a thrown error or
`deny` blocks the transaction); `post_user_registration` is a fail-open
side-effect hook.

## Test (offline)

```ts
import { createTestEvent, runAction } from '@atlasauth/actions';
import { action } from './my-action';

const result = await runAction(
  action,
  createTestEvent('post_login', { user: { emailVerified: false } }),
);

expect(result.denied).toBe(true);
expect(result.denyReason).toBe('Please verify your email before signing in.');
// result also exposes: accessTokenClaims, idTokenClaims, appMetadata, logs, error, calls
```

`runScript(code, event)` runs the raw deployable body (what the server stores)
the same way — useful for testing `action.toCode()` or a hand-written script.

## Deploy

`action.toCode()` returns the deployable script body. The CLI does this for you:

```sh
atlas actions deploy ./my-action.js --trigger post_login --name "require-verified-email"
atlas actions test   ./my-action.js --trigger post_login   # dry-run via the harness
atlas actions list
```

## Templates

```ts
import { templates, getTemplate } from '@atlasauth/actions/templates';
```

| slug | trigger | what it does |
| --- | --- | --- |
| `enforce-email-domain-allowlist` | pre_user_registration | only allow approved email domains |
| `block-disposable-emails` | pre_user_registration | reject throwaway inboxes |
| `add-roles-to-token` | post_login | copy `metadata.roles` into namespaced claims |
| `enrich-profile-from-secrets` | post_login | derive a plan tier from a pre-provisioned secret map (the sandbox has no network) |
| `restrict-signin-by-ip` | post_login | gate sign-in to approved network prefixes |

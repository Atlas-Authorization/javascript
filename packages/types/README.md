# @atlasauth/types

Shared public TypeScript types for Atlas — the Atlas peer of [`@clerk/types`](https://www.npmjs.com/package/@clerk/types).

Dependency-free and runtime-free. Every export is a type, so you can

```ts
import type { User, SessionClaims, WebhookEvent } from '@atlasauth/types';
```

with **no** runtime SDK pulled into your bundle.

## Install

```sh
pnpm add -D @atlasauth/types
```

## What's here

The types an integrator reads are aggregated from the SDKs that own them:

| Module        | Types                                                                                                    | Source                                   |
| ------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| session       | `SessionClaims`                                                                                          | `@atlasauth/core` (copied)               |
| authz         | `AuthzClaims`, `ProtectCondition`, `ProtectOutcome`, `ProtectReason`                                     | `@atlasauth/authz` (copied)              |
| verify        | `VerifiedSessionClaims`, `AuthorizedSession`, `VerifyResult`                                             | `@atlasauth/backend` (copied)            |
| resources     | `User`, `EmailAddress`, `Session`, `Organization`, `OrganizationMembership`, `Invitation`, `ApiKey`, `ApiKeyVerification`, and the `Metadata`/`CursorPage`/`DataList`/`CursorParams`/`DeletedObject` envelopes | `@atlasauth/backend` client (copied) |
| webhooks      | `WebhookEvent`, `WebhookPayload`, `WebhookVerifyResult`, `WebhookVerifyFailure`                          | `@atlasauth/core` + `@atlasauth/backend` (copied) |
| appearance    | `Appearance`, `DesignTokens`, `ElementKey`                                                               | `@atlasauth/react` (copied)              |
| localization  | `LocalizationResource`, `Localization`, `DeepPartial`                                                    | `@atlasauth/localizations` (re-exported) |

Types are **copied** from packages that ship runtime code or dependencies (so
this package stays standalone) and **re-exported** type-only from the one source
that is itself runtime-free (`@atlasauth/localizations`). The copies track their
sources — they are a mirror of the live contract, not a second source of truth.

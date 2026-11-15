# Changelog

## 0.3.1

- Validates requests against the latest API description: operations that the real API documents with more than one success status now answer with the same status (for example 201 on create), and newly required request fields are enforced.
- Instance import accepts the bundle digest as `sha256` (the older `bundle_sha256` still works).

## 0.3.0

- Models FGA model rewrites with batch check, list and expand, Cedar templates, access conditions, agent delegations, sandboxed Action code, encrypted request objects, `private_key_jwt`, form_post and JARM, billing proration and provider webhooks, journey experiments and scheduled messages, the audit chain, device-bound sessions, age assurance, erasure connectors, region pinning, SAML artifact binding, config snapshots and clones, and more of the advanced OAuth flows.
- Breaking: `time/advance` and some helpers (client authentication, client requirement and consent checks) are now async and return promises; `await` them.
- Workflows created without `enabled` are now enabled, like the real API.

## 0.2.0

- Models machine device-key enrolment, federation, DPoP and mTLS binding, agent grants, an OAuth/OIDC provider (PKCE, refresh rotation, token exchange, introspection, revocation, consent, PAR, device and CIBA), SCIM, a virtual WebAuthn authenticator (`createVirtualAuthenticator`) and the real session refresh route.
- Models approvals, step-up policies, the message ledger, authorization explain and what-if, FGA sync, legal hold, instance export and import, and the journey, billing, webhook, workflow, write-budget and connection routes; `coverageList` and `x-atlas-emulator-coverage` show what each operation does.

## 0.1.0

- First release: the in-memory Atlas Backend API engine behind `@atlasauth/emulator` and `@atlasauth/msw` (key and scope checks, idempotency replay, signed tokens and webhooks, change feed, grant counters, parity suite).


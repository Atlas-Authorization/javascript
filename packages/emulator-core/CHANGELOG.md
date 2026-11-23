# Changelog

## 0.7.1

- The Brevo delivery callback accepts the per-instance token as a bearer header, basic-auth password or `?t=`, like the real receiver.

## 0.7.0

- Models key-pair API keys: create (Atlas-generated P-256 pair with the private key returned once, or your own `public_key`), read and rotate with `credential`, `audience` and `key_id`, verify with `token` and the assertion refusal codes, and `POST /v1/api_keys/token` exchanging an assertion (or a secret) for an access token with real signature and claim checks.

## 0.6.0

- Models native apps (iOS, Android and development apps with allowed users and an expiry) and the publishable key restriction, the before-first-session hook, sign-up forwarding and integration health, issuers, message links, the webhook dead-letter queue, SMS and captcha analytics, provider policies and connection templates, connection rehoming, legacy session import, grants (consent and managed) with metadata, per-user risk signals, deleted-user reconciliation, deletion rescheduling, the security summary, delegation tokens, the by-external-id user upsert, device approval and consent account switching, and staging copies with refresh.
- Models Proof-Carrying Authority: principals, grants with authority statements, step-ups, needs, constitutions, post-quantum pins, beacons, bond accounts, the undo ledger, guardian key rotation, intent maps and schemas, workflow receipts, passkey approvers and their settings, and the hosted action registry (imports, drafts, review, publish, versions, pins, sources, templates). Signatures are not verified.
- Models Shared Signals stream management (configuration, subjects, verification, poll).
- Models organization depth (MFA campaigns, role sets and policy, seats, templates, membership and invitation imports), the organization IT-admin views (health, SCIM request log, directory sync runs, SSO login history and tests, organization webhook endpoints, SCIM token rotation), risk and abuse signals, the user traits schema and search fields, config limits, rotation drills, the role-assignment change feed, identity-check import, Atlas ID app adoption and web bot auth request verification.

## 0.5.0

- Emulates `GET /v1/revocations`, `/v1/revocations/stream`, `/v1/machines/revoked`, soft-ended machine grants, key and machine end records, and the new organization session and invitation routes.

## 0.4.0

- Models `PUT`, `GET` and `DELETE /v1/connections/oauth_clients`, with `host_params` validation for providers with connection extras.
- Knows the `identity_verification.updated` event.

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


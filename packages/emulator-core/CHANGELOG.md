# Changelog

## 0.2.0

- Models machine device-key enrolment, federation, DPoP and mTLS binding, agent grants, an OAuth/OIDC provider (PKCE, refresh rotation, token exchange, introspection, revocation, consent, PAR, device and CIBA), SCIM, a virtual WebAuthn authenticator (`createVirtualAuthenticator`) and the real session refresh route.
- Models approvals, step-up policies, the message ledger, authorization explain and what-if, FGA sync, legal hold, instance export and import, and the journey, billing, webhook, workflow, write-budget and connection routes; `coverageList` and `x-atlas-emulator-coverage` show what each operation does.

## 0.1.0

- First release: the in-memory Atlas Backend API engine behind `@atlasauth/emulator` and `@atlasauth/msw` (key and scope checks, idempotency replay, signed tokens and webhooks, change feed, grant counters, parity suite).


# @atlasauth/lambda-authorizer

## 0.4.0

- **behaviour:** Cookie isolation: with `session.cookieIsolation` on, the server helpers read and write the instance's suffixed cookie names, derived from the publishable key with no configuration.
- Requires @atlasauth/backend 0.67.0.

## 0.3.0

- `feature` option for plan feature gating; verifies the signed session status list at the edge.

## 0.2.0

- New `atlasRateLimit` and `atlasGrantUsage` helpers: enforce Atlas rate-limit policies and metered grant usage (consume/refund with idempotency) in your routes. Requires `@atlasauth/backend` 0.51.0 or later.

## 0.1.1 — 2026-11-14

- Takes `@atlasauth/backend` as a peer dependency (`>=0.49.0 <1.0.0`) instead of pinning one exact version, so an app has a single copy of it.

## 0.1.0

- First release: a Lambda authorizer for API Gateway REST APIs (TOKEN and REQUEST) and HTTP APIs (payload v2, IAM policy or simple response) that verifies Atlas session tokens and OAuth access tokens locally.

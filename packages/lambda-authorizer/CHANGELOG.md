# @atlasauth/lambda-authorizer

## 0.1.1 — 2026-11-14

- Takes `@atlasauth/backend` as a peer dependency (`>=0.49.0 <1.0.0`) instead of pinning one exact version, so an app has a single copy of it.

## 0.1.0

- First release: a Lambda authorizer for API Gateway REST APIs (TOKEN and REQUEST) and HTTP APIs (payload v2, IAM policy or simple response) that verifies Atlas session tokens and OAuth access tokens locally.

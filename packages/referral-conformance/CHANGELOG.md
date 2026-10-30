# Changelog

## 0.2.0 — 2026-10-30

- New case `partner.with_email`: registering a user's own referral code carries the user's email (and
  name), and must be accepted (or 409 when the code is taken). The generic protocol's partner case
  now sends an `emailHash`, as Atlas does.

## 0.1.0

- First release: recorded signed calls with expected answers for the Referalli connection API, a
  runner (`runConformance`), a CLI (`referral-conformance`), recorded inbound events, and
  `verifyRequest` for receivers.

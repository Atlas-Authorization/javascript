# @atlasauth/referral-conformance

Provider-neutral. Two profiles, so any referral platform (Rewardful-, FirstPromoter-, Tolt-,
PartnerStack-style, your own, or Referalli) can be tested:

- `webhook` (`--protocol webhook` (CLI) / `profile: 'webhook'` (API)): the generic Atlas referral protocol. `POST {base}/signups`, `/erase`,
  `/export`, `/partners`, `/signals`, `/aliases`, `/users`, `/ping`; the JSON body names its `op`; signed
  like an Atlas webhook (`atlas-id`, `atlas-timestamp`, `atlas-signature: v1,<base64 HMAC-SHA256(id.timestamp.body)>`).
- `connection` (the default): the connection-API dialect Referalli speaks (below).

A conformance suite for the Atlas referral protocol as spoken to Referalli-style connection APIs
(`{base}/v1/auth/connections/{id}/…`). It is a set of recorded signed calls, each with the answer a
conforming server must give, plus a runner and the events a platform sends back.

Run it in your CI against your own server, or against a sandbox.

```sh
npx @atlasauth/referral-conformance \
  --base-url https://sandbox.example.com \
  --connection-id conn_123 \
  --secret-file ./connection-secret.txt
```

or from the Atlas CLI: `atlas referrals conformance --base-url … --connection-id … --secret-file …`.

```ts
import { runConformance, formatReport } from '@atlasauth/referral-conformance';

const report = await runConformance({ baseUrl, connectionId, secret });
console.log(formatReport(report).join('\n'));
if (!report.ok) process.exit(1);
```

## What it checks

| Area | Cases |
|---|---|
| Authentication | a wrong secret, a missing signature and a stale timestamp are **401**; an unknown connection is **404 or 423**; a reused `x-referalli-id` is **409 `replay`** |
| Ping | `{ok, connectionId, programId, …}`, and any `capabilities` the platform advertises |
| Sign-up | no referral, a code, null `ip`/`ua`/`name`, Atlas's risk object, the `atlas-test: 1` marker, and a structured 400 for a missing `customerRef` |
| Erase and export | an unknown customer is a success (erase) and an empty 200 (export), never a 404 |
| Alias, user, signal | accepted; an unknown signal is a structured 400 |

Atlas reads 401 as "signature rejected" and 404/423 as "connection paused", so answering a bad
signature with 404 silently stops delivery. The suite exists to catch that class of mistake.

## Signing

`x-referalli-signature: t=<unix s>,v1=<hex>,v2=<hex>` (HMAC-SHA256 with the connection secret):

- `v1` over `"{t}.{payload}"` (the raw POST body, or the raw GET query string);
- `v2` over `"{t}.{METHOD}.{path?query}.{body}"`, which binds the request to its endpoint.

The legacy `x-referally-signature`, `x-referally-id` and `referally-version` headers carry the same
values. `verifyRequest` implements the check for a receiver.

## The recording

`RECORDED_CALLS` is every case as the exact signed request, at a fixed time (`RECORDING.nowMs`) with
a fixed secret, so a platform can pin its clock and replay it without Atlas. `INBOUND_EVENT_CASES`
are the events a platform sends back (Standard Webhooks, signed with the endpoint's `whsec_` secret)
and what Atlas must read from each.

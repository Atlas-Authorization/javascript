# @atlasauth/fga-js changelog

## 0.3.0 — 2026-10-28

- Tuple expiry, write conflict modes, bulk import/export, watch, assertions and model tools

## 0.2.0 — 2026-10-27

### Added
- `listUsers()` / `listAllUsers()`: who has a relation on an object, including usersets, the `type:*` wildcard with `excluded_users`, contextual tuples and condition context; paged.
- `readChanges()`: the tuple change log, resumable with `continuation_token`, filterable by `type` and `start_time`.
- Tuple conditions: `condition` on tuple keys, `context` on `check`, `batchCheck` items, `listObjects` and `listUsers`.
- `consistency` and `consistency_token` on every query; writes and queries return a `consistency_token`.

## 0.1.0

First published release.

### Added
- `AtlasFga` client for Atlas fine-grained (relationship-based) authorization, configured with `secretKey`, default `storeId` and optional `authorizationModelId`.
- Query methods: `check()`, `batchCheck()`, `listObjects()`, `read()`, `expand()`.
- Write methods: `write()`, `writeTuples()`, `deleteTuples()`, with optional idempotency keys.
- `store(id)` returns a `BoundStore` scoped to one store.
- `stores` and `models` sub-clients for managing stores and authorization models.
- `AtlasFgaError` carrying `status` and structured `errors`, plus full request/response types.
- No runtime dependencies; injectable `fetch`.

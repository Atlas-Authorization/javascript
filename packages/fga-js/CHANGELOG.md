# @atlasauth/fga-js changelog

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

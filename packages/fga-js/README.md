# @atlasauth/fga-js

The Atlas **FGA** (fine-grained, relationship-based authorization — Zanzibar /
OpenFGA) client for JavaScript & TypeScript. Native, dependency-free, and
preconfigured for Atlas.

```bash
npm install @atlasauth/fga-js
```

## Quickstart

```ts
import { AtlasFga } from '@atlasauth/fga-js';

const fga = new AtlasFga({
  secretKey: process.env.ATLAS_SECRET_KEY!, // sk_live_… / sk_test_…
  storeId: process.env.ATLAS_FGA_STORE_ID!, // default store for every call
});

// write a relationship tuple
await fga.writeTuples([
  { user: 'user:alice', relation: 'viewer', object: 'doc:readme' },
]);

// ask an access question
const { allowed } = await fga.check({
  user: 'user:alice',
  relation: 'viewer',
  object: 'doc:readme',
}); // => true

// list the objects a user can reach
const { objects } = await fga.listObjects({
  user: 'user:alice',
  relation: 'viewer',
  type: 'doc',
}); // => ['doc:readme']
```

All configuration can also come from the environment: `ATLAS_SECRET_KEY`,
`ATLAS_FGA_STORE_ID`, `ATLAS_FGA_MODEL_ID`, and `ATLAS_FGA_URL` (base URL,
defaults to `https://api.atlasauth.net`). So `new AtlasFga()` with no arguments
works when those are set.

## Operations

| Method | Atlas route |
| --- | --- |
| `check({ user, relation, object })` | `POST /v1/fga/stores/:store/check` |
| `batchCheck({ checks })` | `POST /v1/fga/stores/:store/batch-check` |
| `write({ writes, deletes })` / `writeTuples(...)` / `deleteTuples(...)` | `POST /v1/fga/stores/:store/write` |
| `read({ user?, relation?, object? })` | `POST /v1/fga/stores/:store/read` |
| `listObjects({ user, relation, type })` | `POST /v1/fga/stores/:store/list-objects` |
| `expand({ object, relation })` | `POST /v1/fga/stores/:store/expand` |
| `stores.list/create/get/delete` | `/v1/fga/stores` |
| `models.list/create/get` | `/v1/fga/stores/:store/authorization-models` |

### Store binding

With no default `storeId`, bind one for a scope of calls:

```ts
const store = fga.store('store_abc');
await store.check({ user: 'user:a', relation: 'viewer', object: 'doc:1' });
```

### Authorization models

```ts
const model = await fga.models.create('store_abc', {
  schema_version: '1.1',
  type_definitions: [
    { type: 'user' },
    {
      type: 'doc',
      relations: { viewer: { this: {} } },
      metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } },
    },
  ],
});
// pin it on the client so every check/listObjects/expand uses it
const pinned = new AtlasFga({ storeId: 'store_abc', authorizationModelId: model.id });
```

### Errors

Non-2xx responses throw `AtlasFgaError` carrying Atlas's `{ errors: [...] }`
envelope:

```ts
import { AtlasFgaError } from '@atlasauth/fga-js';
try {
  await fga.check({ user: 'user:a', relation: 'viewer', object: 'doc:1' });
} catch (e) {
  if (e instanceof AtlasFgaError && e.code === 'store_id_not_found') { /* ... */ }
}
```

## Relationship to OpenFGA

Atlas's FGA engine is **OpenFGA-shaped**: same model DSL/JSON, the same
`user` / `relation` / `object` tuple vocabulary, and the same operations
(check, write, read, expand, list-objects, batch-check). Atlas also exposes an
OpenFGA **wire-compatible** mirror at `/v1/openfga` — if you prefer the stock
[`@openfga/sdk`](https://www.npmjs.com/package/@openfga/sdk), point its `apiUrl`
at `https://<your-atlas-host>/v1/openfga` with an Atlas secret key as the
`ApiToken` credential and `check` / `write` / store & model operations work
unchanged.

This client targets the **native `/v1/fga` surface** instead, because:

- **`list-objects`, `read`, and `expand` are only on `/v1/fga`.** The
  `/v1/openfga` mirror currently covers check / write / stores / models only, so
  the stock SDK cannot do those three against Atlas.
- **Response envelope.** `/v1/fga` wraps responses as
  `{ object: 'fga.check', allowed, authorization_model_id }`,
  `{ object: 'fga.list_objects', objects, authorization_model_id }`, etc. —
  not the bare OpenFGA shapes.
- **`read` is a list page** (`{ object: 'list', data, has_more }`) with each
  tuple's object field named `target`, rather than OpenFGA's
  `{ tuples: [{ key, timestamp }], continuation_token }`.
- **Auth** is an Atlas secret key (`Authorization: Bearer sk_…`) with the
  `fga:read` / `fga:write` scopes, not an OpenFGA store-scoped token.

Everything else (model format, tuple semantics, contextual tuples) matches
OpenFGA, so models authored for OpenFGA load into Atlas as-is.

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
| `listUsers({ object, relation, user_filters })` / `listAllUsers(...)` | `POST /v1/fga/stores/:store/list-users` |
| `readChanges({ type?, page_size?, continuation_token?, start_time? })` | `GET /v1/fga/stores/:store/changes` |
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

### Who has access (list users)

```ts
const { users, excluded_users } = await fga.listAllUsers({
  object: 'doc:readme',
  relation: 'viewer',
  user_filters: [{ type: 'user' }],
});
// users: ['user:anne', 'user:bob'] — or ['user:*'] with excluded_users when the
// document is public except for some people. Use { type: 'group', relation: 'member' }
// to get usersets ('group:eng#member') instead of people.
```

`listUsers` returns one page (`page_size` up to 1000, default 1000) with a
`continuation_token`; `listAllUsers` follows it for you.

### Conditions

A tuple can carry a condition defined in the model; it grants only while the
condition holds. Values come from the tuple's own `context` and from the
request's `context` (the tuple's value wins on a clash). Missing or ill-typed
values deny, never grant.

```ts
await fga.models.create('store_abc', {
  type_definitions: [/* … `[user with in_office]` on doc#viewer … */],
  conditions: {
    in_office: {
      expression: 'ip.in_cidr(cidr)',
      parameters: { ip: { type_name: 'TYPE_NAME_IPADDRESS' }, cidr: { type_name: 'TYPE_NAME_STRING' } },
    },
  },
});
await fga.writeTuples([
  { user: 'user:anne', relation: 'viewer', object: 'doc:1', condition: { name: 'in_office', context: { cidr: '10.0.0.0/8' } } },
]);
await fga.check({ user: 'user:anne', relation: 'viewer', object: 'doc:1', context: { ip: '10.1.2.3' } });
```

### Freshness: `consistency` and consistency tokens

Every write returns a `consistency_token`. Pass it to a later read and the
answer is guaranteed to reflect at least that write — use it right after
revoking access so a cached answer from before the revocation can never be used:

```ts
const { consistency_token } = await fga.deleteTuples([{ user: 'user:anne', relation: 'viewer', object: 'doc:1' }]);
await fga.check({ user: 'user:anne', relation: 'viewer', object: 'doc:1', consistency_token }); // never stale
```

`consistency: 'MINIMIZE_LATENCY'` (the default) may be answered from a
short-lived cache; `'HIGHER_CONSISTENCY'` skips it and reads the primary.

### The change log

```ts
let page = await fga.readChanges({ type: 'doc' });
// …process page.data…
// later, only what changed since:
page = await fga.readChanges({ type: 'doc', continuation_token: page.continuation_token });
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
(check, write, read, expand, list-objects, list-users, batch-check, read-changes)
plus tuple conditions. Atlas also exposes an OpenFGA **wire-compatible** mirror
at `/v1/openfga` — if you prefer the stock
[`@openfga/sdk`](https://www.npmjs.com/package/@openfga/sdk), point its `apiUrl`
at `https://<your-atlas-host>/v1/openfga` with an Atlas secret key as the
`ApiToken` credential and the store, model, check, write, read, list-objects,
list-users and read-changes operations work unchanged.

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

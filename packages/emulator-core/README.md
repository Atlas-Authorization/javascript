# @atlasauth/emulator-core

An in-memory Atlas engine driven by the Atlas OpenAPI document. It is what `@atlasauth/emulator`, `@atlasauth/msw` and `@atlasauth/testing` run on.

```ts
import { createEmulatorEngine } from '@atlasauth/emulator-core';

const engine = createEmulatorEngine({ openapi });          // the parsed OpenAPI document
const res = await engine.handle(new Request('http://x/v1/users', { headers: { authorization: 'Bearer sk_test_emulator' } }));
```

Subpaths: `/server` (HTTP listener, `loadOpenApi`), `/msw` (msw handlers), `/parity` (compare the emulator with a real instance).

See the "Testing with the emulator" guide for what it models, the message sink, fault injection and the parity suite.

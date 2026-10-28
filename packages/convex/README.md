# @atlasauth/convex

Sign users in with [Atlas](https://atlasauth.net) and authenticate them in [Convex](https://convex.dev).

```bash
npm install @atlasauth/convex @atlasauth/react convex
```

1. Create a JWT template named `convex` with its audience set to `convex`.
2. Tell Convex to trust Atlas:

```ts
// convex/auth.config.ts
import { atlasAuthConfig } from '@atlasauth/convex';

export default atlasAuthConfig({
  issuer: process.env.ATLAS_ISSUER!,         // https://auth.example.com, or https://atlasauth.net
  instanceId: process.env.ATLAS_INSTANCE_ID, // ins_… (needed on the shared atlasauth.net host)
});
```

3. Swap `ConvexProvider` for `ConvexProviderWithAtlas`, inside `AtlasProvider`:

```tsx
import { AtlasProvider } from '@atlasauth/react';
import { ConvexProviderWithAtlas } from '@atlasauth/convex/react';

<AtlasProvider publishableKey="pk_live_…">
  <ConvexProviderWithAtlas client={convex}>
    <App />
  </ConvexProviderWithAtlas>
</AtlasProvider>;
```

In Convex functions, `await ctx.auth.getUserIdentity()` returns the signed-in Atlas user (`subject` is the Atlas user id).

Full guide: https://atlasauth.net/docs/convex

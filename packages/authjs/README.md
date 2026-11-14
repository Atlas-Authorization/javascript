# @atlasauth/authjs

An Auth.js (NextAuth v5, `@auth/core`) provider preset for Atlas. Atlas is a standards OpenID Connect provider, so this is an `oidc` provider with Atlas defaults: scopes `openid profile email`, PKCE and state checks, profile mapping and a button style. It needs no runtime import from Auth.js, so it works with any v5 version.

```ts
import NextAuth from 'next-auth';
import Atlas from '@atlasauth/authjs';

export const { handlers, auth } = NextAuth({
  providers: [
    Atlas({
      issuer: process.env.AUTH_ATLAS_ISSUER,
      clientId: process.env.AUTH_ATLAS_ID,
      clientSecret: process.env.AUTH_ATLAS_SECRET,
    }),
  ],
});
```

`issuer` is your instance's OpenID issuer URL (the origin that serves `/.well-known/openid-configuration`). Add scopes with `scope`, and change the sign-in route segment with `id` (default `atlas`) or the button label with `name`.

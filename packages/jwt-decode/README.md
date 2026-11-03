# @atlasauth/jwt-decode

A tiny, **zero-dependency** helper to **decode** (not verify) a JSON Web Token in
the browser or on the server. It is the Atlas peer of Auth0's
[`jwt-decode`](https://github.com/auth0/jwt-decode) — same job, Atlas claim
types.

```bash
npm install @atlasauth/jwt-decode
```

## Decode only — this does NOT verify

Decoding reads a token's claims; it does **not** check the signature. Anyone can
mint a JWT with any claims, so a **decoded payload is untrusted input**. Use this
package only to read a token you already hold — to display the signed-in user, or
to read `exp` and schedule a refresh.

To **trust** a token's claims, verify it with
[`@atlasauth/backend`](https://www.npmjs.com/package/@atlasauth/backend), which
checks the RS256 signature against your instance JWKS:

```ts
import { AtlasBackend } from '@atlasauth/backend';

const atlas = new AtlasBackend({
  jwksUrl: 'https://<your-frontend-api>/.well-known/jwks.json',
  issuer: 'https://<your-frontend-api>',
});
const result = await atlas.authenticateRequest({ headers: req.headers });
if (result.ok) {
  // result.claims are verified and safe to trust
}
```

## API

### `decodeJwt(token) => { header, payload, signature }`

Splits a JWT into its three parts and base64url-decodes the header and payload
JSON. `signature` is returned as its **raw** (still base64url) segment — it is
never decoded. Throws `InvalidTokenError` on malformed input.

```ts
import { decodeJwt } from '@atlasauth/jwt-decode';

const { header, payload, signature } = decodeJwt(token);
header.alg; // 'RS256'
payload.sub; // 'user_2abc…'
payload.org_id; // 'org_2…' (when a session has an active org)
```

The payload is typed as `AtlasJwtPayload`, carrying Atlas's standard session
claim names (`sub`, `sid`, `org_id`, `org_slug`, `org_role`, `org_permissions`,
`sv`, `mfa`, `azp`, `exp`, `iat`, …) plus an index signature for custom/template
claims. Pass your own payload type if you decode a template token:

```ts
const { payload } = decodeJwt<{ email: string; plan: string }>(token);
```

### `jwtClaims(token) => payload`

Shorthand for `decodeJwt(token).payload`.

### `jwtExpired(token, leewaySec?, nowMs?) => boolean`

Reads the `exp` claim and returns whether the token is expired. `leewaySec`
extends validity to tolerate clock skew — the token counts as expired only once
`now > exp + leewaySec`. Throws `InvalidTokenError` when the token is malformed
or carries no numeric `exp`.

```ts
import { jwtExpired } from '@atlasauth/jwt-decode';

if (jwtExpired(token, 5)) {
  // refresh it
}
```

### `InvalidTokenError`

Thrown for any malformed input: not a string, not three `.`-separated segments,
or a header/payload that is not base64url-encoded JSON.

## Builds

Ships ESM, CommonJS and a UMD browser global:

| Format | File                   | Use                              |
| ------ | ---------------------- | -------------------------------- |
| ESM    | `dist/index.mjs`       | `import` / bundlers              |
| CJS    | `dist/index.cjs`       | `require()`                      |
| UMD    | `dist/index.umd.js`    | `<script>` → `window.AtlasJwtDecode` |

```html
<script src="https://unpkg.com/@atlasauth/jwt-decode"></script>
<script>
  const { payload } = AtlasJwtDecode.decodeJwt(token);
</script>
```

## License

MIT

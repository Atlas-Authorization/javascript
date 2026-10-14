# @atlasauth/jwt-decode changelog

## 0.1.0

First published release.

### Added
- `decodeJwt()` decodes (does not verify) a JWT into its header and payload.
- `jwtClaims()` returns just the payload.
- `jwtExpired()` checks `exp` with optional leeway.
- `AtlasJwtPayload` type covering Atlas session claims (`sid`, `org_id`, `org_role`, `org_permissions`, `roles`, `mfa`, `amr`, and standard claims), plus `JwtHeader` and `DecodedJwt`.
- `InvalidTokenError` for malformed tokens.
- Zero dependencies; works in the browser and on the server.

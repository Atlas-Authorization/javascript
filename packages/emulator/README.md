# @atlasauth/emulator

A local, in-memory Atlas for development and CI. No account, no network.

```sh
npx @atlasauth/emulator --port 4400 --seed seed.json   # or: atlas dev
```

- **FAPI + minimal BAPI** (users, orgs, sessions, sign-in/up) backed by [`@atlasauth/msw`](../msw) state; point `NEXT_PUBLIC_ATLAS_FAPI_URL` / your SDK base URL at the printed origin.
- **Deterministic codes**: every email/SMS code is `424242` (`seed.instance.testOtp` overrides).
- **Mail and SMS catcher**: `/__emulator/mail` (UI) and `/__emulator/mail.json`.
- **OIDC discovery** at `/.well-known/openid-configuration`, JWKS at `/.well-known/jwks.json`.
- **One origin**: `--app http://localhost:3000` forwards everything the emulator does not own to your app. `atlas dev proxy --app <url> --api <fapi url>` does the same against a real instance.
- `POST /__emulator/reset` clears state.
- Docker: see `Dockerfile`.

`seed.json` is `{ "users": [{ "email": "ada@example.com", "password": "pw" }], "organizations": [] }`.

Limits: the emulator does not sign real tokens, run social/SAML flows or proxy WebSocket upgrades.

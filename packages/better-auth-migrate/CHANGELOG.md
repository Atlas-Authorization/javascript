# @atlasauth/better-auth-migrate changelog

## 0.3.0 — 2026-10-24

- SSO organization claims, app adoption, validating dry runs, sealed secrets, consent API adapters; see the Atlas changelog.

## 0.2.0 — 2026-10-24

- Integrator platform release: see the Atlas changelog for 2026-10-24.

## 0.1.0

First published release.

### Added
- `exportBetterAuth(auth, { out, publicKey })` exports a Better Auth app through its own database adapter (every adapter: Prisma, Drizzle, Kysely, MongoDB, memory, custom), page by page.
- Exports the core models and every plugin model present: two-factor, passkeys, API keys, organizations with teams and custom roles, admin, username, phone number, anonymous, Stripe subscriptions, SSO providers, OAuth clients and consents, JWKS public keys and live sessions.
- Two-factor secrets, backup codes, encrypted OAuth tokens and encrypted OAuth client secrets are decrypted with your Better Auth secret (rotation-aware) in memory.
- The bundle is sealed to your Atlas instance's import key (X25519 + HKDF-SHA256 + AES-256-GCM, chunked, tamper and truncation evident), so no plaintext secret touches disk.
- `atlas-better-auth-export --out <file> --public-key <kid:key>` CLI: finds the Better Auth instance in `auth.ts` (or `lib/`, `utils/`, `src/`, `app/`; `--config` overrides), with `--upload` to send the bundle to Atlas.
- `@atlasauth/better-auth-migrate/testing`: an in-memory Better Auth fixture generator using Better Auth's real model and field names.

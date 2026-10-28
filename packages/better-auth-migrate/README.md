# @atlasauth/better-auth-migrate

Move a Better Auth app to Atlas without losing passwords, two-factor, passkeys, API keys or sessions.

The exporter runs **inside your app**, through your own Better Auth instance and database adapter, so it works with Prisma, Drizzle, Kysely, MongoDB and any custom adapter, and with custom table and field names.

```bash
npm install @atlasauth/better-auth-migrate
```

## 1. Get your instance's import key

```bash
curl https://api.atlasauth.net/v1/better_auth_imports/public_key -H "Authorization: Bearer $ATLAS_SECRET_KEY"
```

The bundle can only be opened by that Atlas instance.

## 2. Export

```ts
import { exportBetterAuth, fetchImportKey } from '@atlasauth/better-auth-migrate';
import { auth } from './lib/auth';

const publicKey = await fetchImportKey({ secretKey: process.env.ATLAS_SECRET_KEY! });
const result = await exportBetterAuth(auth, { out: 'better-auth.atlas-bundle', publicKey });
console.log(result.counts);
```

Or from the command line:

```bash
npx atlas-better-auth-export --out better-auth.atlas-bundle --public-key <kid:key>
# or fetch the key and upload in one go:
ATLAS_SECRET_KEY=sk_test_... npx atlas-better-auth-export --out better-auth.atlas-bundle --upload
```

The CLI finds your Better Auth instance in `auth.ts` (also under `lib/`, `utils/`, `src/`, `app/`); pass `--config <path>` otherwise. `atlas import --from better-auth` prints the exact command with your key.

Options: `sessions` (default true), `oauthTokens` (default false), `verifications` (default false), `models`, `pageSize`, `secret`, `apiKeyHashing`, `oauthClientSecretStorage`, `decryptBackupCodes`, `onProgress`.

## What is in the bundle

Users (with admin role and bans, username, phone number, anonymous flag), password hashes, social and SSO accounts, two-factor secrets and backup codes (decrypted with your Better Auth secret), passkeys, API keys (their hashes), organizations, custom roles, members, invitations, teams, Stripe subscriptions, SSO providers, OAuth clients and consents, JWKS public keys and live sessions (as SHA-256 hashes of their tokens).

Plaintext exists only in memory: the file is sealed with X25519 + HKDF-SHA256 + AES-256-GCM in chunks bound to their position, so a modified, reordered or truncated bundle does not open.

## 3. Import

```bash
atlas import --from better-auth --bundle better-auth.atlas-bundle --dry-run
atlas import --from better-auth --bundle better-auth.atlas-bundle
```

See the "Migrate from Better Auth" guide in the Atlas docs.

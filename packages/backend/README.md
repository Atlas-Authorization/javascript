# @atlasauth/backend

Server-side Atlas for Node, Deno, Bun and edge runtimes. It does three things:

- verifies Atlas session tokens, webhooks and back-channel logout tokens
- gives you a typed client for the Backend API, using your secret key (`sk_...`)
- gives you a typed client for the Platform API, using your platform key (`psk_...`)

It needs nothing but `fetch`.

```sh
npm install @atlasauth/backend
```

## Verify a session

```ts
import { AtlasBackend } from '@atlasauth/backend';

const atlas = new AtlasBackend({ issuer: 'https://clerk.example.com' });
const result = await atlas.verify(sessionToken);
if (result.ok) console.log(result.claims.sub);
```

The JWKS is found from the issuer and cached. Instances on the shared host also pass `instanceId` (or `publishableKey`).

## Management client (secret key)

```ts
import { createAtlasClient, paginate } from '@atlasauth/backend';

const atlas = createAtlasClient({ secretKey: process.env.ATLAS_SECRET_KEY! });

const user = await atlas.users.create({ email_address: 'ada@example.com' });
for await (const u of paginate(atlas.users.list)) console.log(u.id);
```

Every Backend API operation has a method, grouped by resource. The groups are:

| Area | Namespaces |
| --- | --- |
| Users and sessions | `users`, `emailAddresses`, `sessions`, `signInTokens`, `actorTokens` |
| Organizations | `organizations`, `invitations` |
| Roles and authorization | `roles`, `permissions`, `fga`, `openfga` |
| Access and sign-up control | `waitlist`, `allowlist`, `blocklist`, `domains`, `redirectUrls` |
| Instance settings | `instance`, `instanceSecurity`, `design`, `branding`, `localizations` |
| Templates and messaging | `emailTemplates`, `smsTemplates`, `messaging`, `notifications` |
| Social and enterprise sign-in | `oauthProviders`, `connectors`, `ssoConnections`, `ssoOnboarding`, `orgLdapConnections`, `scimTokens`, `scimProvisioning`, `legacyAuthConnection` |
| OAuth and tokens | `oauthClients`, `resourceServers`, `jwtTemplates`, `apiKeys`, `machines`, `tokens`, `sessionExchangeApps`, `tickets` |
| Webhooks and audit | `webhooks`, `auditLogs`, `auditEvents`, `events`, `usage`, `configChangelog`, `logStreams` |
| Security | `attackProtection`, `rateLimitPolicy`, `riskBasedMfa`, `botSignals`, `captcha`, `networkAcls`, `managedWaf`, `radiusClients` |
| Billing and entitlements | `billing`, `entitlementOverrides`, `organizationSettingsSchema` |
| Privacy | `dataSubjectRequests`, `importExport` |
| Agents and integrations | `actions`, `pca`, `mcp`, `mcpConnector`, `ltiPlatforms` |
| Development tools | `testMode`, `diagnostics` |

### Check your setup

```ts
const report = await atlas.instance.preflight();
for (const f of report.findings) console.log(f.severity, f.message, '→', f.fix);
```

### Design the sign-in page

```ts
import { readFile } from 'node:fs/promises';

const logo = await atlas.design.assets.upload(await readFile('logo.png'), {
  kind: 'logo',
  contentType: 'image/png',
});
await atlas.design.update({
  palette: { primary: '#4f46e5' },
  logo: { assetId: logo.asset_id },
});
// Per-organization override; null removes a setting.
await atlas.design.organizations.update('org_123', { palette: { primary: null } });
```

Uploads send the raw image bytes with their content type. A `Blob` brings its own type.

### API key spend caps

Give an end-user API key caps per unit and period (`request`, `day`, `month` or `total`), then meter what each call costs. A debit that would exceed a cap is refused without recording anything; it resolves with `allowed: false` rather than throwing.

```ts
const key = await atlas.apiKeys.create({
  subject_type: 'user',
  subject_id: 'user_123',
  limits: [
    { unit: 'requests', amount: 1000, period: 'day' },
    { unit: 'usd_cents', amount: 5000, period: 'month' },
  ],
});

const debit = await atlas.apiKeys.recordUsage(key.id, {
  unit: 'usd_cents',
  amount: 12,
  idempotency_key: 'req_8f2c', // a retry returns the first outcome without counting again
});
if (!debit.allowed) {
  // debit.code === 'LIMIT_EXCEEDED'; debit.exceeded lists the caps that refused it
}

const { usage } = await atlas.apiKeys.getUsage(key.id); // used / remaining / resets_at per cap
await atlas.apiKeys.update(key.id, { limits: null }); // remove the caps
```

`apiKeys.verify(secret)` also returns the key's `name`, `scopes`, `constraints`, `limits` and current `usage`.

### Session keep-alive

If your app loads the Atlas frontend SDK only on some pages, time spent on the other pages can count as inactivity. Touch the session from your backend to slide its inactivity window:

```ts
const s = await atlas.sessions.touch(sessionId);
// s.idle_expires_at is the new inactivity deadline; s.extended is false when a touch in the last minute already did it
```

A touch never extends past the session's absolute expiry and never revives an ended session (`409 SESSION_REVOKED`, `SESSION_IDLE_EXPIRED` or `SESSION_EXPIRED`). It writes at most once a minute, so calling it on every request is safe.

### Strict request bodies

By default Atlas ignores a body field an endpoint does not accept. It lists the ignored fields in the `Atlas-Unknown-Fields` response header.

```ts
const atlas = createAtlasClient({
  secretKey,
  strict: true, // refuse unknown fields with 422 UNKNOWN_FIELD instead
  onUnknownFields: ({ method, path, fields }) => console.warn(method, path, 'ignored', fields),
});

// Override for some calls:
await atlas.withOptions({ strict: false }).users.update('user_123', body);
```

### Errors

Every failed call throws `AtlasApiError`, which has `status`, `code` and the full `errors` list. `AtlasErrorCodes` names the codes worth branching on:

```ts
import { AtlasApiError, AtlasErrorCodes } from '@atlasauth/backend';

try {
  await atlas.notifications.send(body);
} catch (e) {
  if (e instanceof AtlasApiError && e.hasCode(AtlasErrorCodes.EMAIL_DELIVERY_NOT_CONFIGURED)) {
    // set up an email provider first
  }
}
```

## Platform client (platform key)

```ts
import { createAtlasPlatformClient } from '@atlasauth/backend';

const platform = createAtlasPlatformClient({ platformKey: process.env.ATLAS_PLATFORM_KEY! });

const app = await platform.apps.create({ name: 'Acme' });
const signIn = await platform.atlasIdApps.create({
  name: 'Acme',
  redirect_uris: ['https://acme.example/callback'],
  post_logout_redirect_uris: ['https://acme.example/'],
  backchannel_logout_uri: 'https://acme.example/backchannel-logout',
  branding: { theme: 'dark', accent_color: '#4f46e5' },
});
console.log(signIn.client_id, signIn.client_secret); // the secret is shown once
```

The platform client has these namespaces:

- `apps`: create, update, archive, transfer, claim and delete apps, manage their instances, rotate and list secrets
- `accountlessApps`
- `atlasIdApps`: Sign in with Atlas apps, including design preview and secret rotation
- `designAssets`

It accepts the same `strict`, `onUnknownFields` and `withOptions` settings.

## Back-channel logout

When a user signs out of Atlas, Atlas POSTs a `logout_token` to your `backchannel_logout_uri`. Verify it before you end the matching local sessions:

```ts
import { LogoutTokenVerifier, memoryLogoutReplayStore } from '@atlasauth/backend';

const logoutTokens = new LogoutTokenVerifier({
  issuer: 'https://atlasauth.net', // or your instance's issuer
  clientId: process.env.ATLAS_CLIENT_ID!,
  replayStore: memoryLogoutReplayStore(), // use a shared store across processes
});

// Framework-agnostic handler: (form body) -> { status, headers }
export async function handleBackchannelLogout(form: URLSearchParams) {
  const headers = { 'Cache-Control': 'no-store' };
  const token = form.get('logout_token');
  if (!token) return { status: 400, headers };

  const result = await logoutTokens.verify(token);
  if (!result.ok) return { status: 400, headers };

  const { sid, sub } = result.claims;
  if (sid) await sessions.deleteByAtlasSid(sid); // your session store
  else if (sub) await sessions.deleteAllForUser(sub);
  return { status: 200, headers };
}
```

The verifier checks the following:

- the RS256 signature
- `iss`, and that `aud` contains your client id
- `iat`, which must be present, not in the future and not too old, and `exp` if present
- `jti`
- the back-channel logout event
- that `sid` or `sub` is present
- that there is no `nonce`
- that `typ` is `logout+jwt`, when the header has one

For tokens signed by your own instance, `new AtlasBackend({ issuer }).verifyLogoutToken(token, { clientId })` reuses the instance's cached keys.

To refuse replays across several servers, implement `LogoutReplayStore.remember(jti, expiresAtMs)` on a shared store, for example Redis `SET NX PX`.

## Webhooks

`verifyWebhook` checks the signature on events Atlas sends to your webhook endpoints. You manage endpoints with `atlas.webhooks.endpoints`: create, update, reveal or rotate a secret, send a test event, and redeliver a past delivery.

# @atlasauth/backend

Server-side Atlas for Node, Deno, Bun and edge runtimes. It does three things:

- verifies Atlas session tokens, webhooks and back-channel logout tokens
- runs the server side of a hosted-redirect (OpenID Connect) sign-in
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

## Sign in with a redirect (OpenID Connect)

`oidc` runs the relying-party side of the hosted-redirect integration: state, nonce and PKCE, the flow cookie, the code exchange and the ID-token checks (RS256 only, `iss`, `aud` = your client id, `nonce`, `exp`).

```ts
import { oidc, AtlasOidcError } from '@atlasauth/backend';

const config = {
  issuer: 'https://bright-fox-42-fapi.atlasauth.net', // https:// + frontend_api_host
  clientId: process.env.ATLAS_CLIENT_ID!,
  redirectUri: 'https://app.example.com/auth/callback',
  secret: process.env.OIDC_COOKIE_SECRET!, // 32+ random characters; seals the flow cookie
};

// Start: set the flow cookie, redirect.
const { url, cookie } = await oidc.start({ ...config, scope: 'openid profile email' });

// Callback: one call does every check.
const identity = await oidc.callback({
  ...config,
  clientSecret: process.env.ATLAS_CLIENT_SECRET!,
  query: request.url, // or URLSearchParams, or req.query
  cookie: request.headers.get('cookie'),
});
// identity: { sub, namespacedSub, email, emailVerified, name, idToken, accessToken, refreshToken?, expiresAt, claims, clearCookie }

// Sign out: end your session, then end the Atlas one.
const logout = await oidc.logoutUrl({ ...config, postLogoutRedirectUri: 'https://app.example.com/', idTokenHint });
```

- The flow cookie is `httpOnly`, `SameSite=Lax`, `Secure` (except on a `http://localhost` callback), scoped to the callback path, and lasts 10 minutes. With `secret` it is encrypted (AES-GCM), so it can't be read or forged. Without `secret` it is only encoded. Always pass one in production.
- `namespacedSub` is `${issuer}#${sub}`. Key users on it if you accept more than one instance, so two instances' users never collide.
- `clientAuth` is `client_secret_basic` (default with a secret), `client_secret_post`, or `none` (public client, PKCE only).
- `new AtlasBackend({ issuer }).oidc` has the same methods with `issuer` filled in.
- Did your own code exchange? `oidc.verifyIdToken(idToken, { issuer, clientId, nonce })` runs just the token checks.

Failures throw `AtlasOidcError` with a stable `code`:

| `code` | Meaning |
|---|---|
| `state_mismatch` | No flow cookie, a different `state`, a cookie from another sign-in or secret, or a flow older than 10 minutes. Start again. |
| `access_denied` | Atlas redirected back with an OAuth `error`. The exact value is in `oauthError` (`access_denied`, `login_required`, …). |
| `issuer_mismatch` | The callback's `iss` parameter names a different server. |
| `invalid_request` | The callback has no `code`. |
| `token_exchange_failed` | The token endpoint refused the code or client (`oauthError`, `status`). |
| `invalid_token` | The ID token failed a check: algorithm, signature, `iss`, `aud`/`azp`, `nonce`, `exp`/`iat` or `at_hash`. |
| `discovery_failed` | The discovery document or the signing keys could not be fetched or don't match the issuer. |

Every error from `callback` carries `clearCookie`: send it with your error page too.

### Next.js (App Router)

```ts
// app/auth/login/route.ts
import { oidc } from '@atlasauth/backend';
import { config } from '@/lib/atlas';

export async function GET() {
  const { url, cookie } = await oidc.start(config);
  return new Response(null, { status: 302, headers: { location: url, 'set-cookie': cookie } });
}

// app/auth/callback/route.ts
import { oidc, AtlasOidcError } from '@atlasauth/backend';
import { config } from '@/lib/atlas';

export async function GET(request: Request) {
  try {
    const user = await oidc.callback({
      ...config,
      clientSecret: process.env.ATLAS_CLIENT_SECRET!,
      query: request.url,
      cookie: request.headers.get('cookie'),
    });
    const headers = new Headers({ location: '/' });
    headers.append('set-cookie', user.clearCookie);
    headers.append('set-cookie', await createAppSession(user)); // your own session cookie
    return new Response(null, { status: 302, headers });
  } catch (error) {
    if (!(error instanceof AtlasOidcError)) throw error;
    return new Response(`Sign-in failed (${error.code})`, {
      status: 400,
      headers: error.clearCookie ? { 'set-cookie': error.clearCookie } : {},
    });
  }
}
```

### Express

```ts
import express from 'express';
import { oidc, AtlasOidcError } from '@atlasauth/backend';

const app = express();

app.get('/auth/login', async (req, res) => {
  const { url, cookie } = await oidc.start(config);
  res.append('Set-Cookie', cookie).redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const user = await oidc.callback({
      ...config,
      clientSecret: process.env.ATLAS_CLIENT_SECRET!,
      query: req.originalUrl,
      cookie: req.headers.cookie,
    });
    res.append('Set-Cookie', user.clearCookie);
    await startYourSession(req, res, user.namespacedSub);
    res.redirect('/');
  } catch (error) {
    if (!(error instanceof AtlasOidcError)) throw error;
    if (error.clearCookie) res.append('Set-Cookie', error.clearCookie);
    res.status(400).send(`Sign-in failed (${error.code})`);
  }
});
```

## Test offline

`createTestIssuer()` mints session tokens and ID tokens with a throwaway key, and its `fetch` serves discovery, the JWKS and a token endpoint, so a full redirect sign-in runs in a unit test with no network.

```ts
import { createTestIssuer, oidc, TEST_TOKEN_TAMPERS } from '@atlasauth/backend';

const fx = await createTestIssuer({ clientSecret: 'test-secret' });
const config = { issuer: fx.issuer, clientId: fx.clientId, redirectUri: 'https://app.example.com/auth/callback', secret: '…32+ chars…', fetchImpl: fx.fetch };

const { url, cookie } = await oidc.start(config);
const { callbackUrl } = await fx.authorize(url, { sub: 'user_1', claims: { email: 'a@example.com', email_verified: true } });
const user = await oidc.callback({ ...config, clientSecret: 'test-secret', query: callbackUrl, cookie });

// Negative cases: wrong_aud, wrong_iss, foreign_key, expired, wrong_nonce, alg_none.
for (const tamper of TEST_TOKEN_TAMPERS) {
  const { url, cookie } = await oidc.start(config);
  const { callbackUrl } = await fx.authorize(url, { tamper });
  await expect(oidc.callback({ ...config, clientSecret: 'test-secret', query: callbackUrl, cookie })).rejects.toMatchObject({ code: 'invalid_token' });
}
```

`fx.mintIdToken(claims, { aud, nonce, tamper })` and `fx.mintSession(claims, { tamper })` mint single tokens. `@atlasauth/testing` re-exports `createTestIssuer`.

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

### Domain moves, logout fan-out and managed email

```ts
// Move every URL from the old origin to the new one. dry_run first shows the diff.
const preview = await atlas.instance.moveOrigin({ from: 'https://old.example.com', to: 'https://example.com', dry_run: true });
for (const c of preview.changes) console.log(c.object, c.field, c.before, '->', c.after);

// Send the same logout_token your OIDC apps get to another service.
await atlas.logoutNotifyEndpoints.create({ url: 'https://api.example.com/atlas/logout' });

// Send email from your own domain through Atlas, then publish the returned DNS records.
const managed = await atlas.messaging.managedEmail.create({ from_address: 'Acme <no-reply@example.com>' });
console.log(managed.records);
```

On the platform client, `atlasIdApps.findUsers(id, email)` answers a privacy request for one app,
`atlasIdApps.revokeGrant(id, grantId)` revokes one person's approval, and `atlasIdPublisher` claims and verifies
the publisher name shown on consent screens.

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
  if (!result.ok) {
    // retryable: our side failed for now (the issuer's keys could not be fetched).
    // 503 + Retry-After makes Atlas send it again; 400 is final and never retried.
    return result.retryable
      ? { status: 503, headers: { ...headers, 'Retry-After': '30' } }
      : { status: 400, headers };
  }

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

Atlas retries a delivery that gets a `5xx`, `408`, `429` or no answer, after 5 seconds, 5 minutes, 30 minutes, 2 hours, 5 hours and 10 hours. Any other `4xx` is final. Atlas never follows a redirect: a `3xx` answer is recorded as `backchannel_redirect_not_followed`, so after a domain move update `backchannel_logout_uri` to the final URL. Answer your own transient failures (a database that is down) with `503` too.

To check the route end to end, `oauthClients.testBackchannelLogout(id)` sends a signed test token (`sid` starting `sid_test_`, extra claim `atlas_test: true`) and returns what your route answered; `oauthClients.listBackchannelDeliveries(id)` lists every attempt.

## Webhooks

`verifyWebhook` checks the signature on events Atlas sends to your webhook endpoints. You manage endpoints with `atlas.webhooks.endpoints`: create, update, reveal or rotate a secret, send a test event, and redeliver a past delivery.

The `atlas-signature` header can carry more than one signature, separated by spaces (`v1,<sig> v1,<sig>`). While an endpoint secret rotates, Atlas may sign each delivery with the old and the new secret. `verifyWebhook` accepts the delivery when any one signature matches your secret.

## Referral attribution

With referral attribution on, Atlas reports every interactive sign-up to your referral platform before `user.created` is sent. The answer lands on the user: `referral` (who referred them, or null), `referral_code` and `referral_link` (the user's own code and link, when they are a referrer).

```ts
await atlas.referrals.update({
  enabled: true,
  provider: 'webhook', // the Atlas referral protocol; or a built-in vendor adapter
  endpoint_url: 'https://referrals.example.com/atlas',
  signing_secret: process.env.REFERRAL_SIGNING_SECRET,
  auto_enroll_users: true,
  link_template: 'https://app.example.com/join?ref={code}',
  security: { on_high_risk: 'hold' },
});
const test = await atlas.referrals.test(); // { ok, http_status, latency_ms, error? }
const failed = await atlas.referrals.listCalls({ status: 'failed', limit: 20 });
await atlas.referrals.retryCall(failed.data[0]!.id);

const user = await atlas.users.get('user_123');
user.referral?.referrer_user_id;
await atlas.users.update('user_123', { referral_code: 'ada-1' }); // 409 REFERRAL_CODE_TAKEN if held
await atlas.users.flagReferral('user_123', { reason: 'self-referral' });
```

Browser capture: `browser_sources` lists the referral programs whose script or cookie the browser reads (null on update goes back to the provider's default, reported by `browser_sources_default`), and `consent_provider` picks the consent manager that decides (`auto`, one manager, or `app`).

Enabling without what the provider needs is `422 REFERRALS_NOT_CONFIGURED`. When the platform answers late, Atlas sends the `user.referral_attributed` webhook (`UserReferralAttributedEvent`). Preflight may report `referrals_enabled_unverified` and `referrals_without_bot_protection`.

### Receive the referral protocol (referral platforms)

A referral platform that implements the Atlas referral protocol verifies Atlas's calls with `verifyReferralRequest`. Every call is a `POST` signed like a webhook, and its JSON body says which operation it is (`op`): `signup`, `erase`, `export`, `partner` or `signal`. Pass the path the call arrived on: a signed body whose `op` does not match the endpoint is refused (`op_mismatch`).

```ts
import { verifyReferralRequest } from '@atlasauth/backend';

app.post('/atlas/:endpoint', express.raw({ type: '*/*' }), async (req, res) => {
  const { verified, call } = verifyReferralRequest({
    body: req.body,
    headers: req.headers,
    secret: process.env.REFERRAL_SIGNING_SECRET!,
    path: req.path, // or expectedOp: 'signup' on a handler for one endpoint
  });
  if (!verified || !call) return res.sendStatus(401);
  switch (call.op) {
    case 'signup': // ReferralSignupPayload → answer ReferralSignupResponse
      return res.json({ referral: await match(call.payload), partner: await enroll(call.payload) });
    case 'export': // the connection test sends test: true
      return call.test ? res.sendStatus(404) : res.json(await exportFor(call.payload.customerRef));
    default: // erase, partner, signal
      await handle(call);
      return res.sendStatus(204);
  }
});
```

A retry of one call keeps its `atlas-id` (`deliveryId`). Sign-ups are idempotent on `customerRef`: answer a retry the same way.

### Two-way sync

A provider with the `inbound` capability can send referral changes made after sign-up back to Atlas. The settings report `inbound.url` (give it to the platform), `inbound.secret_set`, `inbound.endpoint_id` and `inbound.last_event` (`{ at, type, outcome }`). Store the platform's event secret with `inbound_secret` (write-only, 16-512 characters) and its subscription id with `inbound_endpoint_id`:

```ts
await atlas.referrals.update({ inbound_secret: process.env.REFERRAL_INBOUND_SECRET, inbound_endpoint_id: 'we_123' });
const { inbound } = await atlas.referrals.get(); // inbound.last_event?.outcome: 'applied', 'stale', …
```

A platform on the Atlas referral protocol sends a `referral.updated` event to `inbound.url`, signed like an Atlas webhook with the inbound secret (or the connection's signing secret when none is set). `signReferralUpdatedEvent` builds it:

```ts
import { signReferralUpdatedEvent } from '@atlasauth/backend';

const e = signReferralUpdatedEvent({
  inboundUrl: settings.inbound.url,
  secret: process.env.REFERRAL_SIGNING_SECRET!,
  event: { customerRef: 'user_123', referralId: 'ref_1', status: 'qualified' },
});
await fetch(e.request());
```

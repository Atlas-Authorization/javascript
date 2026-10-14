# @atlasauth/backend changelog

## 0.7.0
- **API key spend caps.** `apiKeys.create` and `apiKeys.update` accept `limits` (`ApiKeyLimit[]`: `{ unit, amount, period: 'request' | 'day' | 'month' | 'total' }`, or `null` to clear). `ApiKey` gains `limits` and `usage` (`ApiKeyLimitState[]`: `{ unit, period, amount, used, remaining, window_start, resets_at }`).
- **Usage metering.** `apiKeys.recordUsage(id, { amount, unit, idempotency_key? })` returns `ApiKeyUsageDebit` (`key_id`, `unit`, `amount`, `allowed`, `code`, `exceeded`, `usage`, `counters`, `idempotent_replay`); a refusal resolves with `allowed: false`. `apiKeys.getUsage(id)` returns `ApiKeyUsage` (`key_id`, `limits`, `usage`, `counters`). New types: `ApiKeyLimit`, `ApiKeyLimitPeriod`, `ApiKeyLimitState`, `ApiKeyUsageCounter`, `RecordApiKeyUsageBody`, `ApiKeyUsageDebit`, `ApiKeyUsage`.
- **Verify.** A valid `ApiKeyVerification` gains `name`, `scopes`, `constraints`, `limits`, `usage` and `expires_at`.
- **Session keep-alive.** `sessions.touch(id)` returns `TouchedSession` (the session plus `extended`). `Session` gains `idle_expires_at`.
- **Users.** `CreateUserBody` and `ImportUsersBody` accept `notify` (boolean; `false`, the default, sends nothing to the user).
- **Error codes.** `AtlasErrorCodes` adds `LIMIT_EXCEEDED`, `SESSION_REVOKED`, `SESSION_IDLE_EXPIRED` and `SESSION_EXPIRED`.
- **Docs.** `AtlasIdAppCopy.sign_in_title` / `sign_up_title` comments state the current defaults ("Sign in", "Create your Atlas Account"); no type change.
- **Compatible.** New fields are optional on existing types; no signatures changed.

## 0.6.0
- **Full Backend API and Platform API coverage.** Every secret-key and platform-key operation in the public API reference now has a typed method.
- **Platform client.** `createAtlasPlatformClient({ platformKey })` manages apps and their instances (create, update, archive, transfer, claim, rotate secrets, list secret keys), accountless apps, Sign in with Atlas apps (`atlasIdApps`, including logout URIs, branding and design preview), and platform design images.
- **Design.** `design` reads, replaces and patches the sign-in page design for the instance and for each organization, previews unsaved designs, uploads, lists and deletes design images, and reads the catalog. The design object is fully typed (`AtlasDesign`, `AtlasDesignPatch`).
- **Raw uploads.** Image uploads send the raw bytes with their content type (`Blob`, `ArrayBuffer` or typed array).
- **Strict request bodies.** `createAtlasClient({ strict: true })` sends `Atlas-Strict: true` on every write, so an unknown body field is refused with `422 UNKNOWN_FIELD`. Use `client.withOptions({ strict })` to override it for some calls. `onUnknownFields` reports fields Atlas ignored (the `Atlas-Unknown-Fields` header).
- **Back-channel logout.** `LogoutTokenVerifier` / `verifyLogoutToken` / `AtlasBackend#verifyLogoutToken` verify an OIDC back-channel `logout_token`, and `memoryLogoutReplayStore()` refuses a replayed `jti`.
- **Instance setup.** `instance.preflight()` lists configuration problems with fixes, and `instance.cookieConsent` reads, sets and removes the hosted pages' cookie-consent banner.
- **OAuth providers.** `list({ provider, configured })` filters the list. Upsert accepts `display_name`, `icon_url`, `mode`, wallet settings, and `null` setting values that clear a setting. Responses include `icon_url`, `mode` and `setting_values`.
- **OAuth clients.** `OAuthClient` includes the logout registration (`post_logout_redirect_uris`, `backchannel_logout_uri`, `backchannel_logout_session_required`, `frontchannel_logout_uri`, `frontchannel_logout_session_required`). `oauthClients.create` and `update` accept these fields; on update, `null` clears a URI and `[]` clears the post-logout list.
- **Webhooks.** Endpoints can be updated. You can reveal or rotate an endpoint's secret, send a test event, and redeliver a past delivery.
- **New namespaces.** `entitlementOverrides`, `orgLdapConnections`, `organizationSettingsSchema`, `emailAddresses`, `openfga`, `connectors`, `notifications`, `auditEvents`, `events`, `usage`, `configChangelog`, `pca`, `mcp`, `mcpConnector`, `legacyAuthConnection`, `redirectUrls`, `sessionExchangeApps`, `tickets`, `testMode`, `diagnostics`.
- **Organizations.** The policy is fully typed, with room for extra keys. Organizations gain `settings`, `auditStreams`, `branding`, `endUsers` and `readerDomain`.
- **Users.** Added `byEmails`, `resolved`, `state`, `signInHistory`, `listOrganizationMemberships`, `setPassword`, `deleteProfileImage`, `deletePasskey`, identity import and removal, erasure export and acknowledgements, graceful `deletion`, `directives`, `consents`, `approvalRequests`, `notificationPreferences`, `phoneNumbers` and `progression`.
- **Other additions.**
  - `sessions.getToken(id, template)`
  - Billing: `importSubscription`, `reportUsage`, `syncSeats`
  - `dataSubjectRequests.create` and `.cancel`
  - `invitations.bulkCreate`
  - Waitlist: `create`, `bulkCreate`, `delete`
  - `oauthClients.import`
  - `signInTokens.revoke` (deprecated)
- **Error codes.** `AtlasErrorCodes` names the stable codes worth branching on, such as `EMAIL_DELIVERY_NOT_CONFIGURED`, `UNKNOWN_FIELD`, `WRONG_KEY_SURFACE` and `INVALID_KEY`.
- **Compatible.** Existing methods keep their signatures. A few response types widen to match the server: `webhooks.endpoints.list` and `deliveries` now type `has_more` as `boolean`, and `oauthProviders.upsert` types `configured` as `boolean`. `AtlasClient` is now an interface, with the same members plus `withOptions`.

## 0.5.0
- **`jwksUrl` is optional.** `new AtlasBackend({ issuer })` now discovers the JWKS URL from `${issuer}/.well-known/openid-configuration`. The discovered URL is cached for the JWKS TTL (an hour), a failing discovery endpoint is retried at most once a minute, and the last good URL keeps serving through a discovery outage. The document's `issuer` must equal your configured `issuer` and its `jwks_uri` must be https, or nothing is fetched from it.
- **Instances on the shared host** (no frontend API domain of their own) carry the shared issuer in their tokens, and the shared host's root discovery document is not theirs. Pass `instanceId` (or `publishableKey`, from which the instance id is read) so discovery uses the per-instance document instead.
- When keys cannot be obtained, `verify()` returns `{ ok: false, reason: 'no_keys', detail }` with `detail` saying why (e.g. the discovery URL and HTTP status).
- **Compatible.** `jwksUrl` and `jwks` work exactly as before; passing both still throws. New exports: `JwksDiscovery`, `DiscoveryError`, `discoveryUrlFor`, `instanceIdFromPublishableKey`.

## 0.4.0
- **Typed messaging provider config.** `messaging.setEmail` / `messaging.setSms` now take a body discriminated by `transport` (`EmailProviderInput` / `SmsProviderInput`), with the exact `config` keys each provider accepts — Resend, SES, SMTP, Brevo, Mailgun; Twilio, Vonage, MessageBird, Plivo, Telnyx, Sinch, Infobip, ClickSend, Bandwidth, AWS SNS. A typo or another provider's key now fails to compile, matching the API, which refuses unknown keys with a 422.
- Required keys are documented per field ("Required on first setup"). `EmailProviderSetup` / `SmsProviderSetup` require them at the type level — use them with `satisfies` for a first setup. On an update of the same transport, every key is optional: an omitted key, including a stored secret, keeps its value.
- Responses are typed per transport (`EmailProvider` / `SmsProvider`). Secret keys never appear in `config`; `secrets_set` lists exactly that transport's secret keys.
- **Compatible.** The old untyped `MessagingProviderInput` (`transport: string`, `config: Record<string, unknown>`) still compiles through a `@deprecated` overload.


## 0.3.0
- **Machines.** New `machines` namespace: `list` (filter by owner, organization or metadata, cursor-paginated), `create` (returns the secret once), `get`, `rename`, `patchMetadata`, `approve`, `revoke`, `rotateSecret`, `rotateKey`, `delete` and `organizationMemberships`. Enrolment tokens: `createEnrolmentToken`, `listEnrolmentTokens`, `deleteEnrolmentToken`. `verifyM2mToken(token)` checks a machine token and resolves to `{ valid: false }` on any failure. New types include `Machine`, `MachineWithSecret`, `MachineEnrolmentToken` and `M2mTokenVerification`.
- **API keys.** `apiKeys.mintToken({ secret, ... })` exchanges an API key secret for a short-lived signed token (`ApiKeyToken`), and `apiKeys.listRevoked({ since, limit })` pages through revoked keys (`RevokedApiKeyRef`).

## 0.2.0
- **CAPTCHA verification.** New `captcha.verify(token, { action, remote_ip })` checks a CAPTCHA token server-side against the provider configured for the instance (or for the named action), so your server never holds the CAPTCHA secret. Returns a `CaptchaVerification` (`success`, `action`, `provider`).

## 0.1.7
- **Metadata.** Added `repository` (monorepo + package directory), `homepage`, and `bugs` so the npm page links back to source.

## 0.1.6
- **Optional `audience` verification.** `verifySessionToken(..., { audience })` now enforces the session token's `aud` claim when you pass an expected audience (string or array); omit it and verification is unchanged. Pairs with Atlas sessions now carrying `aud` (the instance id) and `azp`. Backwards compatible.

## 0.1.5
- **Fixed: default Backend API host.** `DEFAULT_API_URL` (the `apiUrl` used when you don't pass one) is now `https://api.atlasauth.net`. The previous default did not resolve, so clients without an explicit `apiUrl` could not reach the API.

## 0.1.4
- **OAuth callback forwarding.** `AtlasBackend#oauthCallbackForwardUrl(provider, incoming)` builds Atlas's OAuth callback URL from your configured issuer, so an app that keeps its own registered callback can forward to Atlas in one line (`res.redirect(302, atlas.oauthCallbackForwardUrl('github', req.url))`). It accepts `req.url`, a full URL, a query string, a parsed query object or `URLSearchParams`, keeps only the OAuth callback parameters (`code`, `state`, `error`, ...), and rejects provider keys that are not a plain slug.

## 0.1.3
- **Offline verification for tests and CI.** `AtlasBackend` accepts a static `jwks` instead of `jwksUrl` (pass exactly one); with `jwks` it never fetches keys. All other checks are unchanged.
- New `createTestIssuer()` returns `{ issuer, jwks, kid, mintSession(claims?) }`, so tests can mint session tokens and verify them with no network. New types `TestIssuer`, `CreateTestIssuerOptions`.

## 0.1.2
- **Webhook verification.** New `verifyWebhook({ body, headers, secret })` verifies an incoming Atlas webhook (HMAC-SHA256 signature over the raw body, constant-time compare, 5-minute replay window by default, override with `toleranceMs`). It never throws on a bad signature: it returns `{ verified, reason?, event? }`, with `reason` one of `missing_headers`, `malformed_signature`, `stale_timestamp` or `signature_mismatch`. Also exports `ATLAS_WEBHOOK_HEADERS` (`atlas-id`, `atlas-timestamp`, `atlas-signature`) and the `WebhookVerifyResult` / `VerifyWebhookInput` types.

## 0.1.1
- First published release.
- **Session verification.** `AtlasBackend` verifies Atlas session JWTs locally against a cached JWKS (`verify()`, `verifyOnline()`, `authenticateRequest()`), checking signature, issuer and expiry, with an optional `authorizedParties` allowlist for the `azp` claim. `SessionClaims` carries roles, permissions, active plan and features, and an `actor` claim on impersonation sessions.
- **Authorization helpers.** `has()`, `protect()`, `hasRole()` and `hasPermission()` check roles, permissions, `plan` and `feature` against verified claims.
- **Cross-domain sign-in handshake.** `redeemHandshake()`, `readHandshakeParams()` and `createPkcePair()` let a satellite domain exchange a PKCE-bound handshake nonce for a first-party session, without a token in the URL.
- **Backend API client.** `createAtlasClient({ secretKey, apiUrl? })` is a typed client for the secret-key Backend API, with namespaces for users, sessions (including minting a session with `sessions.create`), organizations, roles and permissions, invitations, OAuth clients and providers, SSO and SCIM, domains, allowlist / blocklist / waitlist, webhooks, API keys, JWT templates, fine-grained authorization (`fga`), attack protection, branding, email and SMS templates, billing, messaging, import / export, data subject requests, audit logs and instance settings.
- `users.connectExternalAccount()` links a new sign-in provider to an existing user from your server.
- Errors are thrown as `AtlasApiError`; `paginate()` and `collect()` walk paginated lists.

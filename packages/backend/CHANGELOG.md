# @atlasauth/backend changelog

## 0.10.0
- **Trusted reverse proxy secret.** `instanceSecurity.getProxySecret()` (`ProxySecret`: `set`, `created_at`, `previous_expires_at`, `secret_header`, `client_ip_header`), `instanceSecurity.createProxySecret({ overlap_seconds? })` (`ProxySecretCreated`: adds `secret`, shown once, and `rotated`; `CreateProxySecretBody`) and `instanceSecurity.deleteProxySecret()`. A proxy that serves the Frontend API from your own origin sends the secret in `X-Atlas-Proxy-Secret` and the browser's IP in `X-Atlas-Client-IP`; Atlas then uses that IP for rate limits, lockout, risk signals, geo, audit logs and session metadata.
- **Managed email feedback on Resend.** `ManagedEmail.feedback_webhook` is now also returned for Resend (on create and verify): Atlas registers a bounce / complaint webhook on your own Resend account, so `usage.bounces` / `usage.complaints` count for Resend domains too.
- **Webhook secret rotation with an overlap.** `webhooks.endpoints.rotateSecret(id, { overlap_seconds? })` (new type `RotateWebhookSecretBody`) can keep the previous signing secret signing every delivery for `overlap_seconds` (at most 604800, 7 days). The default is 0: the old secret stops at once, as before. Set an overlap only once every receiver verifies with a verifier that accepts several signatures. During the overlap the `atlas-signature` header carries two entries, `v1,<new> v1,<old>`; `verifyWebhook` (0.9.1 and later) passes with either secret. `WebhookSigningSecret` gains `overlap_seconds` and `previous_secret_expires_at` (epoch ms, or null when the old secret already stopped). `WebhookEndpoint` gains `previous_secret_expires_at` while an overlap is open.
- **Sign in with Atlas apps.** `atlasIdApps.rotateSecret(id, { overlap_seconds? })` (default 24 hours, `0` = now) and `atlasIdApps.rotateWebhookSecret(id, { overlap_seconds? })` (default 0, as for instance webhooks); new type `RotateAtlasIdAppSecretBody`. `AtlasIdApp` gains `previous_secret_expires_at`, `secret_issued_at` (the real time the current client secret was issued) and `webhook_previous_secret_expires_at`; `AtlasIdAppWithSecret` gains `overlap_seconds`.
- **Per-instance platform rotation with an overlap.** `apps.instances.rotateSecret(appId, instanceId, { overlap_seconds? }, idempotencyKey?)` keeps the prior keys valid like `apps.rotateSecret` (default 259200 = 72 hours, `0` = revoke now). The 0.9 call `rotateSecret(appId, instanceId, idempotencyKey)` still works. `PlatformInstanceSecretRotation` now types what the API returns: `app_id`, `instance_id`, `overlap_seconds`, `previous_keys_expire_at` (`id` is deprecated: it was never sent). New type `RotatePlatformSecretBody`, also used by `apps.rotateSecret`.
- **Behaviour change on the server.** A per-instance platform rotation without `overlap_seconds` now keeps the prior keys for 72 hours (they used to be revoked at once). Pass `overlap_seconds: 0` for the old behaviour. Webhook rotations without it behave as before.
- **Compatible.** New methods, optional parameters, fields and types only.

## 0.9.1
- **Allowed origins with an integration.** `UpdateInstanceBody.allowed_origins` and the platform app, instance and accountless-app bodies accept `AllowedOriginInput` entries: an origin string or `{ origin, integration }` (`OriginIntegration`: `redirect` | `embedded` | `auto`, or `null` to clear). `Instance`, `InstanceUpdateResult` and `PlatformApp` gain optional `allowed_origin_integrations`. New types: `AllowedOriginEntry`, `AllowedOriginInput`, `OriginIntegration`.
- **Login readiness.** `LoginReadiness` gains `integration` (`LoginReadinessIntegration`: `assumed`, `source`, `reason`); `LoginReadinessCheck` gains `applies`.
- **Branding audiences.** `Branding` accepts `audiences` (hint → `BrandingAudience` `{ heading, subheading, logoUrl, primaryColor }`, `null` deletes one); `ResolvedBranding` gains `audiences`. Start a hosted sign-in with `audienceHint` (or `audience_hint` on the URL) to use one.
- **Error codes.** `AtlasErrorCodes` adds `READ_ONLY_FIELD`, `DEVELOPMENT_EMAIL_NOT_ALLOWED`, `DEVELOPMENT_EMAIL_UNAVAILABLE`, `DEVELOPMENT_EMAIL_LIMIT_REACHED` and `DEVELOPMENT_EMAIL_TEMPLATE_NOT_ALLOWED`.
- **Webhooks, several signatures.** `verifyWebhook` accepts an `atlas-signature` header with several space-separated `v1,<signature>` entries and verifies when any one matches (each compared in constant time). This prepares for webhook secret rotation with an overlap. A header with a single signature works as before.
- **Compatible.** New types, optional fields and error codes only; a single-signature webhook header verifies as before.

## 0.9.0
- **OIDC relying party.** New `oidc` namespace and standalone functions for the hosted-redirect sign-in: `oidcStart` (`oidc.start`), `oidcCallback` (`oidc.callback`), `oidcLogoutUrl` (`oidc.logoutUrl`), `oidcVerifyIdToken` (`oidc.verifyIdToken`), `oidcClearCookie` (`oidc.clearCookie`). `start({ issuer, clientId, redirectUri, scope?, prompt?, loginHint?, audienceHint?, extraParams?, cookieName?, secret? })` returns `{ url, cookie, state, nonce }`: a PKCE (S256) authorize URL from discovery and a `Set-Cookie` for a 10-minute, httpOnly, `SameSite=Lax`, callback-path flow cookie, AES-GCM sealed when `secret` is set. `callback({ …, clientSecret?, clientAuth?: 'client_secret_basic' | 'client_secret_post' | 'none', query, cookie, secret?, clockToleranceSec? })` returns `OidcIdentity` (`sub`, `namespacedSub` = `${issuer}#${sub}`, `email`, `emailVerified`, `name`, `idToken`, `accessToken`, `refreshToken?`, `expiresAt` in epoch ms, `claims`, `clearCookie`). The ID token is verified with RS256 pinned, exact `iss`, `aud` containing the client id (and `azp` when present or when there are several audiences), `nonce`, `exp`/`iat` with tolerance, and `at_hash`. Discovery is cached per issuer for an hour.
- **Errors.** `AtlasOidcError` with `code` (`AtlasOidcErrorCode`: `state_mismatch`, `issuer_mismatch`, `invalid_request`, `invalid_token`, `token_exchange_failed`, `access_denied`, `discovery_failed`), `oauthError`, `description`, `status`, `clearCookie` and `cause`.
- **`AtlasBackend#oidc`.** The same helpers with the backend's `issuer`, `fetchImpl` and `now` filled in (`AtlasBackendOidc`).
- **Test issuer.** `createTestIssuer` accepts `clientId`, `clientSecret` and `idTokenTtlSeconds`, and the returned `TestIssuer` gains `clientId`, `mintIdToken(claims?, { aud?, nonce?, accessToken?, ttlSeconds?, tamper? })`, `authorize(authorizeUrl, { sub?, claims?, tamper?, error? })`, `fetch` (an offline discovery, JWKS and token endpoint) and `endpoints`. `mintSession(claims?, { tamper? })` accepts a tamper too. `TestTokenTamper` is `wrong_aud`, `wrong_iss`, `foreign_key`, `expired`, `wrong_nonce` or `alg_none`; `TEST_TOKEN_TAMPERS` lists all six. New types: `MintIdTokenOptions`, `TestAuthorizeOptions`, `TestAuthorizeResult`.
- **OAuth client secret rotation with overlap.** `oauthClients.rotateSecret(id, { overlap_seconds? }, idempotencyKey?)` takes how long the previous secret keeps working: default 86400 (24 hours), `0` revokes it now, at most 604800 (7 days). It returns `OAuthClientSecretRotation` (`client_secret`, `overlap_seconds`, `previous_secret_expires_at`: epoch ms, or null when the old secret already stopped working). New type `RotateOAuthClientSecretBody`. `OAuthClient` gains optional `previous_secret_expires_at`.
- **Issuer and verification endpoints.** `Instance` (`instance.get()`) and the platform client's `PlatformApp` gain `issuer`, `discovery_url` and `jwks_uri`; `PlatformApp` also gains `frontend_api_host`. They change when a custom domain goes active, so read them rather than hard-coding them.
- **Email verification.** `EmailAddress` gains optional `verification` (`{ status: 'verified' | 'unverified', strategy?: string | null }`). `verified` and `email_verified` are now true only for a proven address: one that signed up while `requireEmailVerification` was false reads `verified: false`, with `verification.strategy: 'skipped'`. Do not grant access on an unverified address.
- **Email templates.** `EmailTemplateName` adds `account_secured` (variable `when`): sent when the owner of an address proves it and the account is secured from whoever had set it up without proof.
- **Managed email uses your own provider account.** `messaging.managedEmail.create` now sets the domain up on YOUR Resend or Brevo account: `CreateManagedEmailBody` gains `transport` (`resend` | `brevo`) + `config.api_key`, or `provider_id`. `ManagedEmail` gains `backend`, `provider_id` and `feedback_webhook`; `limits` is now always `null` and `reputation` is `your_provider_account`. `DeletedManagedEmail` gains `provider_removed`. `ManagedEmailRecord.purpose` adds `ownership` and `dmarc`.
- **Development email sender.** New `messaging.developmentEmail.get / enable / disable` (`DevelopmentEmail`, `EnableDevelopmentEmailBody`): your own email provider in development mode, for a development instance without a verified domain. `MessagingProviders` gains `development_email`.
- **Provider mode.** Email provider bodies accept `mode` (`standard` | `development`); provider responses gain optional `id` and `mode` (`standard` | `development` | `managed_domain`).
- **Compatible** except `ManagedEmail.limits` (was `{ hourly, daily }`, now `null`) and `ManagedEmail.reputation` (new constant). Everything else is new exports, optional parameters and fields; `rotateSecret(id)` behaves as before.

## 0.8.0
- **Back-channel logout, retryable failures.** A failed `LogoutTokenResult` gains `retryable: boolean`. It is `true` for `no_keys` (the issuer's keys could not be fetched: a network error, a JWKS outage, or a just-rotated key whose refetch failed) and `false` for `malformed`, `invalid` and `replayed`. Answer `503` with `Retry-After` when it is true, so Atlas retries the delivery, and `400` otherwise. The README example does this.
- **Back-channel delivery log and test.** `oauthClients.listBackchannelDeliveries(id, { limit?, starting_after? })` returns `BackchannelLogoutDeliveryPage` (`BackchannelLogoutDelivery`: `status`, `http_status`, `latency_ms`, `attempt_number`, `error`, `location`, `test`, timestamps). `oauthClients.testBackchannelLogout(id)` returns `BackchannelLogoutTest` (`ok`, `status`, `latency_ms`, `error`, `location`, `blocked_reason`, `body_excerpt`, `sid`, `delivery_id`). The platform client's `atlasIdApps` gains the same two methods plus `preflight(id)` (`AtlasIdAppPreflight`).
- **Webhooks.** `verifyWebhook` returns `deliveryId` (the signed `atlas-id` header, the same on every retry of one event: deduplicate on it) and `timestamp` (the signed `atlas-timestamp`, epoch ms) on a verified delivery. `WebhookVerifyResult` gains both, optional.
- **Users.** `User` gains optional `version`: it strictly increases with every change to the user, and user webhook payloads carry the same value. Apply an update only if its version is newer.
- **Branding.** `ResolvedBranding` (`resolved` on `branding.get` / `branding.update`) gains every writable field under its input name (`theme`, `layout`, `fontFamily`, `legal`, `copy`, `providers`, `card`, `interaction`, `socialButtons`, …) plus the derived `fontStack`, `providerOrder`, `providerHidden`, `eyebrow`, `headline`, `subheadline`, `footer`. `Branding.copy` accepts `eyebrow`.
- **Domain moves.** `instance.moveOrigin({ from, to, dry_run? })` rewrites every URL on one origin to another across the instance, its OAuth clients, webhooks, redirect URLs and Sign in with Atlas apps, and returns `OriginMove` (`changes` before → after, `problems`, `applied`); the platform client's `atlasIdApps.moveOrigin(id, body)` does the same for one app.
- **Connections and integrations.** `instance.connections()` returns `InstanceConnections` (one `InstanceConnection` row per link to another platform, with `ok`, `severity`, `fix_hint`). `instance.integrations.chatly` and `instance.integrations.forumulate` get, set and delete the built-in connections (`ChatlyIntegration`, `ForumulateIntegration`).
- **Logout fan-out.** New `logoutNotifyEndpoints` namespace: `list`, `create`, `get`, `update`, `delete` and `listDeliveries` for services that receive the same `logout_token` as your OIDC apps (`LogoutNotifyEndpoint`, `LogoutNotifyDelivery`).
- **Managed email.** `messaging.managedEmail.get / create / verify / delete({ force? })` sends from your own domain through Atlas's email account (`ManagedEmail`, `ManagedEmailRecord`, `CreateManagedEmailBody` with optional write-only `dns`). `MessagingProviders` gains `managed_email`.
- **Sign in with Atlas apps.** `atlasIdApps.findUsers(id, email)` (privacy-request lookup, `AtlasIdAppUser`), `revokeGrant(id, grantId)` (`AtlasIdGrantRevocation`) and `rotateWebhookSecret(id)`. `AtlasIdApp` gains `webhook_url`, `webhook_events` and `webhook_active`; `AtlasIdAppWithSecret` gains `webhook_secret`; `UpdateAtlasIdAppBody` accepts `webhook_url`.
- **Publisher.** New platform namespace `atlasIdPublisher`: `get`, `set`, `update({ skip_consent })`, `delete`, `verify` (`AtlasIdPublisher`). The platform client's `configChangelog.list(params)` reads the account's config history.
- **More fields.** `CookieConsent` gains `culture` and `declared_cookies` (`DeclaredCookie`); `SetCookieConsentBody` accepts `culture`. `PreflightReport` gains `sdk_versions_seen` (`SdkVersionSeen`, `SdkAdvisory`). `WebhookDelivery` gains `error` and `location`; `WebhookEndpointList` gains `event_catalog` (`WebhookEventCatalogEntry`) and `event_audiences`. `CustomDomain` gains `dns`, and `domains.create` accepts `dns` (`CustomDomainDnsInput`). `ConfigChangelogEntry` gains `target`. `users.revokeSessions(id, { revoke_grants })` also revokes OAuth grants and returns `grants_revoked`.
- **Compatible.** New methods, types and optional fields only (`retryable` is a new field on the failure branch); no signatures changed.

## 0.7.3
- **Added** error code constants `CAPTCHA_KEYS_REQUIRED` (422: captcha can only be turned on once its own site key and secret are stored) and `CAPTCHA_IN_USE` (409: removing a key a live captcha flow uses; `meta.flows`).

## 0.7.2
- **OAuth clients.** `OAuthClient` gains `skip_logout_confirmation` (boolean), and `OAuthClientLogoutFields` (create and update bodies) accepts it. When true, RP-initiated logout with the client's `client_id` and an exactly registered `post_logout_redirect_uri` ends the session and redirects straight back, with no confirmation page. First-party clients only: the API answers `422` (`VALIDATION_FAILED`, `param: skip_logout_confirmation`) on a third-party client.
- **Cookie consent.** `CookieConsent` gains `settings_link` (`CookieSettingsLink | null`: `label`, `preset`, `attributes`, `rendered_attributes`), and `SetCookieConsentBody` accepts `settings_link` (`CookieSettingsLinkInput | null`: `label`, `preset?`, `attributes?`) for a footer "Cookie settings" link that reopens the consent preferences. New types: `CookieSettingsLink`, `CookieSettingsLinkInput`, `CookieSettingsLinkPreset` (`'cookiemunch' | 'cookiebot' | 'onetrust' | 'custom'`).
- **Sessions.** `UserSession` (from `users.listSessions`) gains optional `idle_expires_at`, `last_active_organization_id` and `impersonated_by`; every session read now returns `idle_expires_at`.
- **Compatible.** New fields are optional; no signatures changed.

## 0.7.1
- **Email provider removal.** `messaging.deleteChannel(channel, options?)` accepts `{ force?: boolean }` (sent as `?force=true`). Removing the email provider is refused with `409 EMAIL_PROVIDER_IN_USE` while email-dependent features are on and nothing else would deliver for the instance; `meta.features` names them.
- **Error codes.** `AtlasErrorCodes` adds `EMAIL_PROVIDER_IN_USE`.
- **Compatible.** The new argument is optional; no signatures changed.

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

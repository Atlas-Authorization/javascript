# @atlasauth/backend changelog

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


## 0.1.7
- **Metadata.** Added `repository` (monorepo + package directory), `homepage`, and `bugs` so the npm page links back to source.

## 0.1.6
- **Optional `audience` verification.** `verifySessionToken(..., { audience })` now enforces the session token's `aud` claim when you pass an expected audience (string or array); omit it and verification is unchanged. Pairs with Atlas sessions now carrying `aud` (the instance id) and `azp`. Backwards compatible.


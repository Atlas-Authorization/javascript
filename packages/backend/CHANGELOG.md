# @atlasauth/backend changelog

## 0.28.0 — 2026-10-30

### Added

- `createKeyMirror({ store, apiKeys })`: a local, authoritative mirror of end-user API keys. It mints and imports keys at Atlas, revokes locally first, verifies against sha256 with no network call, `sync()` reads the revocation feed and `applyWebhook()` handles `api_key.*` events. Also `memoryKeyMirrorStore()` and `hashApiKeySecret()`.
- `privacy.integration.connect()` / `.get()`: one call that wires a consent manager and orchestrator both ways (`/v1/instance/privacy_integrations`).
- Types: `second` / `minute` limit periods, `effective_scopes` on verification, and `scopes` / `import` on `ApiKey` and `CreateApiKeyBody`.
- `sessions.createBrowserTicket({ user_id, redirect_url?, expires_in_seconds? })`: a one-time ticket (and, with `redirect_url`, a ready URL) that signs a browser in as the user, through `POST /v1/sessions` with `mode: "browser_ticket"`. The successor of `signInTokens.create()`, now marked deprecated.
- `testMode.createSignInUrl({ user_id, redirect_url })`: `POST /v1/testing/sign_in_url` on development instances.

## 0.27.1 — 2026-10-28

### Fixed

- The package entry no longer imports `node:crypto`: webhook, policy-feed, bot-id and referral signing use @noble/hashes and Web Crypto, so it bundles for edge and worker runtimes (Next.js 15 edge middleware). Public API unchanged.

## 0.27.0 — 2026-10-28

- SAML IdP (service providers, artifacts, attribute queries), WS-Federation, outbound provisioning connectors, SCIM custom resources and cloud access targets
- OpenID provider: per-client signing/encryption, op key rotation, token-exchange profiles, refresh-token search and bulk revoke, federation resolve, verifiable-credential deferred issuance and presentation requests; `requireAcr`/`maxAge` step-up on access-token verification and `verifyTransactionToken`
- Conditional access depth: report-only and impact replay, device assurance policies and pull integrations, risky users, containment, temporary access passes, email risk, authenticator policies
- Workflows, chat integrations (Slack/Teams approvals), eligible access and activation, staged and recurring reviews, bundles, administrative units, organization application access and B2B connections
- MCP gateway v2 (upstreams, packs, pins, user auth), connection actions and triggers, agent lifecycle and reviews, telemetry export
- Authorization: tuple expiry, decision points, Cedar JSON and token authorization, FGA assertions/materializations/bulk import, customer-managed keys, coupons, credits, user merge, audit retention
- Device-bound SSO registrations; SMTP2GO email transport

## 0.26.0 — 2026-10-27

### Added

- `iga` client resource: identity governance (access catalog, access requests and approvals, grants, delegations, separation-of-duties rules, joiner/mover/leaver lifecycle, certification campaigns).
- `desktopMfa` client resource: the desktop login MFA policy, enrolment codes and enrolled devices (`getPolicy`, `updatePolicy`, `createEnrolmentCode`, `listDevices`, `getDevice`, `revokeDevice`, `revokeOfflineCache`, `deleteDevice`).
- `managedGrants` client resource (`list`, `get`, `narrow`, `revoke`): the OpenID Grant Management grants each OAuth client holds for each user.
- `leastPrivilege` client resource (`report`, `get`, `exportCsv`, and applying the narrower grants with a `dryRun` preview): what each secret key, OAuth client, MCP gateway and agent holds against what it used.
- `mcpGateways` gains `abac` (policy checks on every tool call) and `budgets` (`list`, `create`, `get`, `update`, `delete`, `usage`).
- `fga.settings.get` / `fga.settings.update`: the instance's FGA result-cache lifetime, default consistency mode and tuple change-log retention.

- `connections.token` now caches per client until shortly before `expires_at` and takes `minTtlSeconds`; new `connections.refreshToken` (force-refresh after a provider 401, with `staleAccessToken`), `connections.tokens` (batch read of up to 100), `connections.importConnections` and `connections.exportConnections` (sealed to your public key); `connections.delete(id, { revoke: true })`. `Connection` gains `refresh_failures`, `next_refresh_at` and a typed `last_error` with the provider's code and HTTP status.
- `connections.revoke` returns `provider_revoked`, `provider_status`, `provider_error` and `local_cleared`.
- Webhook event types `connection.refresh_failed`, `connection.reauthorization_required`, `connection.revoked`, `connection.scopes_changed`, `connection.recovered`.
- Connections: `setCredentials`, `rotateCredentials`, `secretVersions`, `secret` (scope `connections:secret_read`), `oauth1Sign`, `webhooks.verify` and `webhooks.*Endpoint`; `token()` takes `subject` for delegated tokens; `Connection` reports `secret_expires_at`, `previous_valid_until` and `allowed_methods`.
- `connections` client resource: `create`, `list`, `get`, `update` (including `owner` to transfer), `delete`, `connect`, `revoke`, `token` (needs the `connections:token` scope) and `oauthClients` (`set`, `list`, `get`, `delete`), with `host_params`, `environment` and the captured token fields typed.
- ABAC data filtering: `abac.partialEvaluate` (the policies as a filter over an unknown resource or principal, with relationship conditions resolved and optional SQL or Prisma output) and `abac.accessibleResources` (the resources a principal may act on, paged). The filter helpers `evalFilter`, `filterToSql`, `filterToPrisma` and `filterToDrizzle` are exported.
- AuthZEN 1.0 search: `abac.authzenSearchSubject`, `authzenSearchResource` and `authzenSearchAction`.
- ABAC authoring: `abac.templates`, `abac.links`, `abac.schema` (`get`, `set`, `delete`, `validate`), `abac.diff` and `abac.diffSources`; `abac.test` results carry `coverage`.
- `fga.listObjects` and the resource-role `accessible` call take `limit` and `starting_after`; `listObjects` returns `has_more` and `next_cursor`.
- `authzDecisions` client resource (`list`, `iterate`, `get`, `stats`, `settings.get/update`): the authorization decision log and its capture settings.
- `policyBundles` client resource (`export`, `list`, `current`, `get`, `verify`, `import` with `dry_run` / `prune`) and `verifyPolicyBundle`, which verifies a signed policy bundle offline against your instance JWKS and returns its policies and FGA models.
- `fga.listUsers` / `fga.listAllUsers` and `openfga.listUsers` / `openfga.listAllUsers`: who has a relation on an object (users, usersets, the `type:*` wildcard with `excluded_users`), paged.
- `fga.readChanges` and `openfga.readChanges`: the tuple change log, resumable with `continuation_token`.
- Tuple conditions: `condition` on tuple keys and `context` on `check`, `batchCheck` items, `listObjects` and `listUsers`.
- `consistency` / `consistency_token` on queries; writes and queries return a `consistency_token`.
- Desktop login MFA passkeys: `DesktopPasskey` and the policy fields `passkey_scope`, `passkey_rp_id` and `passkey_require_uv`.
- Connections: `token_family` on connections and `split_tenants` on connect, so one grant covering several accounts (Xero organisations) becomes one connection per account sharing one token set.
- Custom OAuth providers: `revocation_endpoint`, `host_params_schema` and `data_only` (connect-time host templates for data-only providers).
- OAuth clients: `claims_redirect_uris` for UMA 2.0 claims gathering.
- Shared Signals receivers: the `sync_posture` action records device posture without touching sessions.
- Verifiable credentials: mdoc issuer revocation checks (`revocation_policy`: off, best_effort or required).

## 0.25.0 — 2026-10-26

### Added

- `mfaFactors` client resource for the additional authentication factors: `setYubicoSecret` / `removeYubicoSecret`, `setDuoSecret` / `removeDuoSecret` / `duoHealthCheck`, `setSmartCardSecret` / `removeSmartCardSecret` (all write-only), `yubikeys` (`list`, `register`, `remove`), `smartCardMappings` (`list`, `add`, `remove`) and `resetSecurityQuestions`.
- `users.create({ mfa })` is typed (`ImportedMfa`): an authenticator (`totp`: SHA-1/256/512, 6 or 8 digits, 30 or 60 seconds) or a counter-based token (`hotp`), plus recovery codes.

## 0.24.0 — 2026-10-25

### Added

- Moving from any auth vendor without signing anyone out: `createMigrationBridge` / `exchangeMigrationSession` (the vendor-neutral session bridge, `POST /v1/migrations/{source}/exchange`), per-vendor bridge presets (`listMigrationBridgePresets`, `resolveMigrationBridgePreset`, `registerMigrationBridgePreset`) for Auth0, Clerk, Cognito, Firebase, Supabase, WorkOS, Okta, Stytch, Keycloak, FusionAuth, Kinde, Descope, Frontegg and session-table sources, and an `extractToken` hook for vendor cookies encrypted with your app's secret. `createBetterAuthBridge` / `exchangeBetterAuthSession` now run on it, unchanged.
- `migrations` client resource: `imports(source)` (`getPublicKey`, `rotatePublicKey`, `create`, `list`, `get`, `uploadPart`, `finalize`, `dryRun`, `apply`, `delete`, `upload`, `waitFor`), `bridge(source)` (`get`, `update`, `delete`) and `sources()`.

## 0.23.0 — 2026-10-25

### Added

- `jwtTemplates.create` and `jwtTemplates.update` take `settings` (`lifetime_seconds` 10–86400, `audience`, `algorithm`, `signing_secret`); `JwtTemplate` returns `settings`. `update` accepts claims, settings or both.
- `instance.integrations.rotateEventsSecret(id, { overlap_seconds })`: rotate an integration's event signing secret, with the old one still signing during the overlap.
- `startDeviceAuthorization({ issuer, clientId, clientSecret?, scope?, resource? })` and `pollDeviceAuthorization(start)`: the RFC 8628 device flow against any instance's OAuth server, for a CLI of your own. `startOperatorLogin` / `pollOperatorLogin` now use them.
- `authenticatedWithin(claims, maxAgeSeconds)` and `usedMultiFactor(claims)`: step-up checks on a verified token's `auth_time`, `acr` and `amr`.

## 0.22.0 — 2026-10-25

### Added

- `platform.atlasIdApps.provisionedAccounts` (`list`, `create`, `get`, `remove`, `rotatePassword`): test and review accounts for a Sign in with Atlas app (reviewer logins, CI, demos), confined to that app. Passwords come back once. Takes `platform:atlas_id_apps:provision` or the per-app `atlas_id_apps:<app id>:provision` scope.
- `platform.domains` (`list`, `claim`, `verify`, `remove`): the account's DNS-verified domains.
- `test_mode` and `provisioned_verified_domains_only` on Sign in with Atlas apps (`update` accepts them); `AtlasErrorCodes.TEST_ACCOUNT_RESTRICTED`, `PROVISIONED_ACCOUNT_LIMIT_REACHED`, `DOMAIN_NOT_VERIFIED`.

## 0.21.0 — 2026-10-24

- Per-call integration audiences (`getToken({ for, cbid })`), partner platforms, operator tokens for partner products.

## 0.20.0 — 2026-10-24

### Added

- `atlasIdGrants.preflight(appId)`: the setup check of a Sign in with Atlas app the instance manages (`GET /v1/atlas_id_apps/{id}/preflight`, `diagnostics:read`). `atlasIdGrants.listApps()` items carry `button_rendered_origins` and `managed_via`.
- `platform.atlasIdApps.setManagedBy(id, instanceId | null)`: hand an app's grant handling to an instance (or take it back); app types carry `managed_via`.
- `identity.sso.organizationId` / `identity.sso.type` (from the `sso_organization_id` / `sso_connection_type` claims) and the same claims on `SessionClaims`; the test issuer takes `sso: { organizationId, type }`.
- `users.list({ include_deleted: true })`: also list soft-deleted users in their scrub window. The server now leaves deleted users out by default. `AtlasErrorCodes.MANAGED_WAF_NOT_CONFIGURED` (422 from managed WAF provision/deprovision with no configuration saved).
- Sealed-secret fields (`sealed_secret`, `sealed_client_secret`, `sealed_webhook_secret`, `secrets_sealed`) on webhook endpoint, webhook secret, OAuth client and Sign in with Atlas app types.

### Changed

- `DryRunResult.mode` adds `rollback`; new optional `warnings`, `would_return_status`, `suppressed` and `validation_skipped`.

## 0.19.0 — 2026-10-24

### Added

- `createAtlasClientFromEnv()`, `atlasConfigFromEnv()` and `apiBaseFromEnv()`: configure from `ATLAS_SECRET_KEY` and `ATLAS_API_BASE` or `ATLAS_API_URL`.
- `fx.referalliCall` signs v1 and v2 and sends both header spellings; `requestId` option; `referalliSignatureV2`. `fx.referallyCall` stays as a deprecated alias.
- Referral settings: `context_cookie` accepts a name or a list, `context_cookies`, `provider_aliases`, `capabilities`, `one_click` / `one_click_presets`, `providers[].aliases`.
- `client.referrals` can start a one-click install: `POST /v1/instance/referrals/{preset}/install`.
- `GET /v1/entitlements` (the standard entitlements shape) and `internal` on entitlement overrides.

- Data rights: `privacy` — the data-rights executor protocol any DSAR orchestrator calls (`discover`, `preset`, `lookup`, `createRequest`, `getRequest`, `cancelRequest`) and the instance's orchestrator settings (`orchestrator.get/set/delete`).
- `dataSubjectRequests.create` accepts the canonical data-rights types (`access`, `deletion`, `closure`, `restriction`, `rectification`, and the alias `erase`); `DataSubjectRequest` carries `canonical_type`, `source`, `case_id`, `external_case`, `trace_id`, `steps`, `retention` and `deletion_effective_at`.
- `withOptions({ dryRun: true })`: every write is sent with `?dry_run=true` and resolves to a `DryRunResult` (`changes[{ section, before, after }]`) without changing anything.
- Provisioning fields: `external_ref` and `metadata` on app, instance, secret key, OAuth client, webhook endpoint and Sign in with Atlas app creates (a repeat with the same ref returns the existing object, `idempotent_replay: true`); `metadata` filters on `oauthClients.list`, `webhooks.endpoints.list`, platform `apps.list`, `apps.secretKeys`, `atlasIdApps.list`; `metadataQuery()`.
- Platform: `apps.sandboxTeardown()` (hard delete of sandbox-tagged resources, with a dry run), `apps.bulkDelete({ metadata, dry_run })`, `apps.cloneConfig()`, `apps.createSecretKey()`.
- `notices` (`list`, `acknowledge`), `securityAdvisories` (`list`, `acknowledge`, `catalog`), `subProcessors.get()`, and `auditExports` (`list`, `get`, `create`, `update`, `delete`, `test`, `rotateSecret`) with the `AuditCloudEvent` type.
- `AuditLog.actor` (`type`, `id`, `key_name`, `key_prefix`).
- Atlas service status: `status` (`service` for the public `GET /v1/status` with component groups, regions and open incidents; `getSubscription`, `updateSubscription`, `disableSubscription`, `rotateFeed` for the incident subscription; `listIncidents`; `listDependencies`, `createDependency`, `getDependency`, `updateDependency`, `deleteDependency`, `refreshDependency` for upstream status pages), with the `StatusSubscription`, `StatusIncident`, `StatusIncidentEventData` and `StatusDependency` types.
- Webhook events `status_incident.created`, `status_incident.updated` and `status_incident.resolved`.
- `instance.integrationHealth({ only?, probe? })`, `instance.integrationHealthProviders()`, `instance.embed({ instance, origin?, shape? })`, `design.importBrand({ brandUrl } | { brand })`. `DesignSettings` gains `brand`, `precedence`, `sources`, `ignored`; `AtlasIdAppPreflight` gains `button_rendered_origins`, `authorize_requests_7d`, `fallback_origins`, `homepage_includes_script`.
- Back-channel logout receivers: `handleBackchannelLogout()` (framework-agnostic), `expressBackchannelLogout()`, `fastifyBackchannelLogout()` / `fastifyBackchannelLogoutPlugin`, and `nextBackchannelLogout()` (also `fetchBackchannelLogout()` for any Fetch-API runtime). They verify the `logout_token`, call your `onLogout({ sub, sid })`, and answer 200, 400 (bad token, not retried) or 503 with `Retry-After` (retried).
- `instance.preflight({ min_severity, include_suppressed })`, with the `suppressed` and `integrations` fields and the `security_posture` finding group.
- `instance.unknownFieldsReport({ days })`: the unknown body fields your writes sent, per route, field and key.
- `instance.openapiDiff({ since })`: operations added, deprecated and removed since a date.
- `messaging.channel('email' | 'sms')`, and `NotConfigured`: unconfigured singletons now read as `{ configured: false }` instead of a 404 (`messaging.managedEmail.get()`, `messaging.developmentEmail.get()`).
- `require_pkce` on `oauthClients.create` (new clients default to true).
- `AtlasErrorCodes.ROUTE_NOT_FOUND`, and `docs_url`, `did_you_mean`, `allowed_methods` on `AtlasErrorItem`.

### Changed

- `ConfigChangelogEntry.changes` is always present (with `values_recorded`), plus `no_op` and `recorded`; `fields` is deprecated. `include_no_op` on `configChangelog.list`.

## 0.18.0 — 2026-10-24

### Added

- Policy acceptance: `policies` (`list`, `create`, `get`, `update`, `delete`, `versions.list/create/get/update/delete/publish/retire`, `listAcceptances`, `exportAcceptancesCsv`, `forUser`, `settings.get/update` for the `pol` session claim) and `policySource` (`get`, `update`, `delete`, `test`, `sync`, `listDeliveries`) for the external policy source.
- Policy source protocol v1 helpers for the system that serves policies: `verifyPolicyFeedRequest()` (Atlas's signed `GET {endpoint}/policies`) and `signPolicySourceEvent()` (`policy.published` / `policy.retired`), with the `PolicyFeed` types.
- `RecordUserConsentBody` / `UserConsent`: `policy_version_id`, `content_sha256`, `display`, `scrolled_to_end`, `view_ms`, `locale`.

## 0.17.0 — 2026-10-24

### Added

- Better Auth session bridge: `exchangeBetterAuthSession()` exchanges a Better Auth session for an Atlas session server to server with your secret key (forwarding the user's IP and user agent), plus `migrations.betterAuthBridge` to read and change the bridge settings.
- `legacyIssuers` on `AtlasBackend`: accept Better Auth-issued JWTs for a bounded window during a migration, mapping `sub` to the Atlas user through `external_id`.
- `betterAuthImports`: migrate from Better Auth with a sealed bundle (`getPublicKey`, `rotatePublicKey`, `create`, `uploadPart`, `finalize`, `upload` for all three, `dryRun`, `apply` to import or resume, `get`, `list`, `waitFor`, `delete`, `listJwks`, `deleteJwk`), with `BetterAuthImport`, `BetterAuthImportOptions`, the report types and `splitBundleParts`.

## 0.16.0 — 2026-10-24

### Added

- `actionGallery` (`list`, `get`, `install`, `installs`, `update`) and `actionTemplates` (`list`, `create`, `get`, `update`, `delete`, `addVersion`, `submitVersion`, `deleteVersion`, `publish`, `unlist`) for the Actions gallery.
- `ActionTestResult.http_requests` (what `api.http` queued in a dry run) and `organizations` / `country` on the sample event.
- DPoP server nonces (RFC 9449 §8) in `createAccessTokenVerifier`: `dpopNonces` requires every DPoP proof to carry a nonce the API issued, answering `use_dpop_nonce` with a fresh nonce otherwise; every result carries `dpopNonce` for the `DPoP-Nonce` response header. `memoryDpopNonceSource()` (one process) and `hmacDpopNonceSource(secret)` (stateless, shared by every process — and every Atlas server SDK — holding the same secret).
- Opaque access tokens: `createAccessTokenVerifier({ introspection: { clientId, clientSecret } })` validates a token that is not a JWT at the instance's introspection endpoint (RFC 7662), caching each answer (60 seconds by default, never past `exp`; inactive answers 10 seconds). `introspectJwts: true` checks JWTs live too, so a revoked grant is refused before the token expires. DPoP-bound opaque tokens keep their sender constraint (`cnf.jkt` from introspection). `createIntrospector` is the cache on its own.
- OAuth clients: `access_token_format` (`jwt` | `opaque`) and `token_lifetimes` (`OAuthTokenLifetimes`) on create, update and reads. Resource servers: `access_token_format`, `refresh_token_absolute_ttl_seconds`, `refresh_token_idle_ttl_seconds`, `introspection_client_ids`.
- `RotateSigningKeyBody.key` (`main` | `secondary`) and `SigningKeyRotation.secondary_kid` for KMS setups with one key per algorithm (`config.secondary`).
- KMS-backed signing keys: `instanceSecurity.getSigningKeyProvider()` / `setSigningKeyProvider({ provider, config, credentials })` / `removeSigningKeyProvider()` for AWS KMS, Google Cloud KMS and Azure Key Vault; `SigningKey.provider`.
- SSO connections: SAML Single Logout fields (`saml_single_logout`, `saml_idp_slo_url`, `saml_idp_slo_response_url`, `saml_idp_slo_binding`, `saml_idp_slo_soap_url` for back-channel logout) and `saml_require_encrypted_assertions`. Reads add `has_saml_encryption_key`, `has_previous_saml_encryption_key`, `saml_encryption_rotated_at`; `SamlMetadata.slo_url`. New `getSamlEncryptionKey()`, `createSamlEncryptionKey()` (generate or rotate), `retirePreviousSamlEncryptionKey()` and `deleteSamlEncryptionKey()` (`SamlEncryptionKey`).
- Custom OAuth 2.0 / OpenID Connect login providers: `customOAuthProviders` (`list`, `get`, `create`, `update`, `delete`, `discover`, `previewProfileMapping`, and `signingKeys(id)` with `list` / `rotate` / `retire` for `private_key_jwt`), with `ProfileMapping`, `TokenEndpointAuthMethod`, upstream (RP-initiated and front-channel) logout and third-party initiated login settings. Enterprise OIDC connections take the same `profile_mapping`, `token_endpoint_auth_method`, `client_assertion_audience`, `logout` and `idp_initiated_login`, and report `upstream_urls`.
- Attack protection: `dormant_accounts` (`DormantAccountsSettings`), readable and writable; `country_restrictions` / `device_accounts` typed. Risk-based MFA weights and signals gain `dormantAccount`. Email template key `account_reactivated`.
- Sessions: `custom_data` on reads and on create; `sessions.setCustomData(id, data)` (replace, `null` clears) and `sessions.updateCustomData(id, patch)` (merge).
- Billing: add-on plans (`kind: 'base' | 'addon'`) and several subscriptions per subject (`billing.getSubscription(id)`, and `changeSubscription` / `cancelSubscription` / `restoreSubscription` by subscription id); providers `chargebee`, `autumn` and `commet` (`BillingProviderName`); plan `limits` and Autumn `seat_feature_id`; `syncPlanEntitlements(id)`; `getSettings()` / `updateSettings()` for how limits merge across subscriptions (`max` | `sum`); `checkFeature({ subject_type, subject_id, feature, required })`; metered usage takes `feature` and `subscription_id`.
- Vercel BotID: `botIdAttestationHandler({ secret, checkBotId })` (a fetch-style route handler for your Vercel deployment) and `createBotIdAttestation()`, which sign a BotID verdict for Atlas's `vercel_botid` captcha provider.
- `instanceSecurity.setWalletRpcSecret({ chain_id, url })`: the wallet RPC endpoint for an EIP-155 chain (token gating and the Sign in with Ethereum ENS lookup); captcha secrets take `provider`.

## 0.15.0 — 2026-10-23

### Added

- `createAccessTokenVerifier` / `verifyAccessToken`: verify Atlas-issued OAuth access tokens in your own API or MCP server — signature against the instance JWKS, issuer, expiry, access-token type, audience (RFC 8707), required scopes (scope + permissions) and DPoP sender constraint (RFC 9449, with a replay store). Failures return the status and the RFC 6750 / RFC 9728 `WWW-Authenticate` challenge (`resource_metadata`, `insufficient_scope`).
- `protectedResourceMetadata` / `protectedResourceMetadataPath`: build and locate your API's RFC 9728 protected-resource metadata document.
- `buildWwwAuthenticate`, `memoryDpopReplayStore`.
- `createTestIssuer({ alg: 'ES256' })`: an ES256 test key, like an instance switched to ES256.
- Backend API client: `instanceSecurity.listSigningKeys()` / `rotateSigningKey({ alg, grace_period_seconds, emergency })`; `oauthClients.initialAccessTokens.list()` / `create()` / `revoke()` (RFC 7591 §3); OAuth client fields `subject_type`, `sector_identifier_uri`, `client_secret_expires_at`, `disabled`, `require_pkce` and `secret_expires_in_seconds` on create / rotate; resource server `publish_resource_metadata` and a typed `signing_alg`.
- `users.list({ external_id })`: find a user by the id it had in the system it was migrated from.
- User search: `users.list()` takes `query`, `email_address`, `username`, `phone_number`, `banned`, `email_verified`, `organization_id`, `created_after` / `created_before`, `order_by`, `offset` and `include_total_count` (the page then carries `total_count`).
- Timed bans: `users.ban(id, { reason, note, expires_in_seconds, expires_at })`; `User.ban_expires_at`.
- App roles (instance-wide, no active organization needed): `appRoles.list()` / `create()` / `get()` / `update()` / `delete()` / `listUsers()` / `getForUser()` / `setForUser()` / `removeFromUser()`; `SessionClaims.app_roles` / `app_permissions` with `hasAppRole()` / `hasAppPermission()`.
- `createAccessControl(statements)`: typed resource/action statements for app roles — `permission()`, `permissions()`, `allPermissions()`, `role()` (a definition ready for `appRoles.create`), and `can()` / `canAny()` against session claims.
- API key controls: create / update bodies take `enabled`, `rate_limit` (`ApiKeyRateLimit`), `remaining`, and create also `prefix` and `expires_in_seconds`; `apiKeys.verify(secret, { required_scopes })` and a coded refusal of a live key (`insufficient_scope`, `rate_limited`, `usage_exhausted`, with `missing_scopes`, `retry_after_ms`, `remaining`).
- SCIM tokens: `scopes` and `role_mappings` on create, and `scimTokens.update()`.
- SSO connections: `attribute_mapping` (`SsoAttributeMapping`) and `oidc_scopes`; `domain_warnings` on the connection.
- Email template keys `email_changed`, `verification_link`, `password_reset_link`; notification `email_changed`.

### Changed

- Every verifier (`AtlasBackend.verify`, the OIDC relying-party helpers, `verifyLogoutToken`, `createAccessTokenVerifier`) accepts ES256 as well as RS256, since an Atlas instance — or a single API — can now sign with ES256. Verification stays pinned to those two algorithms; `none`, HMAC and anything else are refused.

## 0.14.1

### Added

- `ReferralCall.request`: the last attempt's request as the referral platform received it (`method`, `url`, `body`, personal fields redacted).

## 0.14.0

### Added

- Referral settings carry browser capture: `browser_sources` (the referral programs whose script or cookie the browser reads; null on update resets to the provider's default), `browser_sources_default`, and `consent_provider` (`auto`, one consent manager, or `app`).

## 0.13.0

### Added

- **Two-way referral sync.** Referral settings carry two-way sync: `inbound` (`url`, `secret_set`, `endpoint_id`, `last_event`) on reads, write-only `inbound_secret` and `inbound_endpoint_id` on updates (null clears), and provider capability `inbound`.
- `signReferralUpdatedEvent(...)` (and `referralUpdatedEvent` on `createTestIssuer()`): builds and signs a `referral.updated` event for a referral platform reporting changes to `POST /v1/webhooks/referrals/{instance_id}`.

## 0.12.0
- **Referral attribution v2.** `referrals.retryFailed({ kind?, error_code? }, idempotencyKey?)` (`POST /v1/instance/referrals/calls/retry_failed`, `ReferralRetryFailedResult` with `requeued`), `referrals.simulate({ code? })` (`POST /v1/instance/referrals/simulate`, `ReferralSimulateResult`: `call_id`, `customer_ref`, `result`, `response`), `referrals.backfill({ since, codes?, code_metadata_path? }, idempotencyKey?)` and `referrals.getBackfill(id)` (`POST /v1/instance/referrals/backfill`, `GET /v1/instance/referrals/backfill/:id`, `ReferralBackfillJob`: `users_scanned`, `users_skipped`, `calls_queued`, `truncated`, `next_since`, `calls`), and `referrals.getForUser(userId)` (`GET /v1/users/:id/referral`, `UserReferralResult`).
- **Settings.** `ReferralSettings` and `UpdateReferralSettingsBody` gain `tracking_token`, `code_lookup_url`, `signup_code_field`, `forward_lifecycle`, `mirror_to_public_metadata` and `include_referral_claims`. `provider` can be `referally`. `ReferralProviderCapabilities` gains `alias`, `user` and `ping`; `needs` can list `tracking_token`. `ReferralConnectionStatus` gains `last_ping` (`ReferralPing`) and `alert` (`signature_rejected` or `connection_paused`). `ReferralConnectionTest` gains `ping`, `method` and `warnings`.
- **Call log.** `ReferralCallKind` adds `alias`, `user` and `ping`. `ReferralCall` gains `latency_ms`, `error_code`, `response`, `highlights`, `request_id` and `batch_id`. `ListReferralCallsParams` gains `error_code` and `starting_after`; `limit` goes up to 1000.
- **Users.** `users.setExternalId(id, externalId | null)` (`PATCH /v1/users/:id`); with referrals on, Atlas forwards the change to the platform as an alias. `UpdateUserBody` gains `external_id`. `UserReferral` gains `partner_external_ref`, `referral_status` and `notes`; `status` is now the attribution status (`pending`, `attributed`, `none`, `failed`, `held`, `flagged`), and the platform's own status moved to `referral_status`. New `UserReferralResolvedEvent` types the `data` of `user.referral_resolved`.
- **before_user_create hook.** New `userHooks` namespace: `getBeforeUserCreate()`, `updateBeforeUserCreate(body)` and `testBeforeUserCreate()` (`/v1/instance/hooks/before_user_create`; `BeforeUserCreateHook`, `UpdateBeforeUserCreateHookBody`, `BeforeUserCreateHookTest`).
- **Referral protocol receiver.** `verifyReferralRequest` accepts the new operations `alias` (`/aliases`, `ReferralAliasPayload`), `user` (`/users`, `ReferralUserPayload`) and `ping` (`/ping`, `ReferralPingPayload`; answer `ReferralPingResponse`), and returns `protocolVersion` (the `Atlas-Referrals-Version` header). `ReferralSignupResponse` gains optional `notes`. New constants `REFERRAL_PROTOCOL_VERSION` (`2026-10-21`) and `REFERRAL_PROTOCOL_VERSION_HEADER`.
- **Test calls.** `createTestIssuer()` gains `referralCall(options)` (an Atlas referral protocol call, signed as an instance signs it) and `referallyCall(options)` (a Referally connection call: `x-referally-signature` over the raw body, or the raw query string for `export`, with `referally-version`). Also standalone: `signAtlasReferralCall`, `signReferallyCall`, `referallySignature`, `referralEmailHash`, `REFERALLY_API_VERSION`; types `SignedReferralCall`, `AtlasReferralCallOptions`, `ReferallyCallOptions`, `ReferallyCallOp`.
- **Compatible.** New methods, types, optional fields and constants. One meaning changed on the server: `user.referral.status` is the attribution status; read the platform's status from `referral_status`.

## 0.11.0
- **Referral attribution settings.** New `referrals` namespace: `get()` and `update(body, idempotencyKey?)` (`GET`/`PATCH /v1/instance/referrals`; `ReferralSettings`, `UpdateReferralSettingsBody` with nested `security`: `ReferralSecuritySettings` `challenge_referred_signups`, `on_high_risk`, `hold_until_email_verified`, `max_referred_signups_per_ip_hour`), `test()` (`ReferralConnectionTest`), `listCalls({ limit?, status?, kind?, user_id? })` (`ReferralCall`, `ListReferralCallsParams`) and `retryCall(id, idempotencyKey?)`. Also `ReferralProviderInfo`, `ReferralProviderCapabilities`, `ReferralConnectionStatus`, `ReferralRisk`, `ReferralCallKind`, `ReferralCallStatus`.
- **Users.** `User` gains optional `referral` (`UserReferral`: `partner_id`, `referrer_external_id`, `referrer_user_id`, `matched_via`, `status`, `risk_level`, `flagged`), `referral_code` and `referral_link`. `CreateUserBody` accepts `referral` (`CreateUserReferralInput`: `code`, `click_id`, `anon_id`) and `referral_code`; `UpdateUserBody` accepts `referral_code` (`null` clears). New `users.flagReferral(id, { reason? }, idempotencyKey?)` (`POST /v1/users/:id/referral/flag`, `UserReferralFlag`).
- **Webhooks.** `UserReferralAttributedEvent` types the `data` of the new `user.referral_attributed` event (the referral platform answered after `user.created`).
- **Error codes.** `AtlasErrorCodes` adds `REFERRALS_NOT_CONFIGURED` (422) and `REFERRAL_CODE_TAKEN` (409). Preflight can report `referrals_enabled_unverified` and `referrals_without_bot_protection`.
- **Referral protocol receiver.** `verifyReferralRequest({ body, headers, secret, path?, expectedOp?, now?, toleranceMs? })` verifies a call from Atlas to a referral platform (the webhook signature scheme; every call is a `POST` whose signed body carries `op` and `customerRef`) and returns `call` by operation (`ReferralProtocolCall`: `signup`, `erase`, `export` with `test`, `partner`, `signal`), plus `deliveryId`, `timestamp` and `idempotencyKey`. It refuses (`ReferralVerifyFailure`) a body that is not an object (`malformed_body`), a missing or unknown `op` (`missing_op`, `unknown_op`), a path that is not a protocol endpoint (`unknown_endpoint`) and an `op` that does not match the path or `expectedOp` (`op_mismatch`). Payload types: `ReferralSignupPayload`, `ReferralSignupResponse`, `ReferralErasePayload`, `ReferralExportPayload`, `ReferralPartnerPayload`, `ReferralSignalPayload`, `ReferralSignalType`, `ReferralContext`, `ReferralRiskVerdict`, `ReferralOp`; `referralOpForPath`; constants `REFERRAL_OP_ENDPOINTS`, `REFERRAL_CONNECTION_TEST_REF`, `REFERRAL_PROTOCOL_USER_AGENT`.
- **Compatible.** New methods, types, optional fields and constants only.

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

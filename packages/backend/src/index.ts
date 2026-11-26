// §7.3 token verification — the original surface, unchanged.
export * from './jwks-cache';
// OIDC discovery of the JWKS URL when only `issuer` is configured.
export { DiscoveryError, JwksDiscovery, discoveryUrlFor, instanceIdFromPublishableKey } from './discovery';
export * from './verify';
export * from './request-auth';
export * from './auth-status';
export * from './refresh-session';
export * from './recent-auth';
// Named step-up policies: the guard for your own API and offline verification of the signed receipt.
export * from './step-up-gate';
export * from './txn-token';
export * from './access-control';
export * from './handshake';
// Sign in on a hub host, finish on a tenant's own domain with a single-use code.
export * from './domain-handoff';
// Moving from Better Auth: exchange its session cookie once, accept its JWTs for a window.
export * from './better-auth';
// Moving from any vendor: the generic zero-logout bridge and its per-vendor presets.
export * from './migration-presets';
export * from './migration-bridge';
export * from './auth0-session';
export { looksLikeMagicDidToken, magicDidTokenExtractor } from './magic-did';
export { workosSessionTokenExtractor } from './workos-session';
export { BETTER_AUTH_JWT_ALGS, peekIssuer } from './legacy-issuers';
export type { LegacyIssuer, LegacyIssuerKind } from './legacy-issuers';
export * from './legacy-issuer-presets';
// Moving from a self-hosted framework (Auth.js, Lucia, Passport, iron-session,
// Devise, Django): read the session it left in the browser.
export * from './framework-sessions';
// …and their bridge presets + token extractors (registers the presets on load).
export * from './framework-bridge';

// Verify a signed policy bundle offline (no call to Atlas).
export * from './policy-bundle';
// Verify machine and API-key tokens locally against the instance's published keys.
export * from './credential-verify';

// OIDC Back-Channel Logout: verify the logout_token Atlas POSTs to your app.
export {
  BACKCHANNEL_LOGOUT_EVENT,
  LOGOUT_TOKEN_CLOCK_SKEW_SECONDS,
  LOGOUT_TOKEN_MAX_AGE_SECONDS,
  LogoutTokenVerifier,
  memoryLogoutReplayStore,
  verifyLogoutToken,
} from './logout-token';
export type {
  LogoutReplayStore,
  LogoutTokenCheckOptions,
  LogoutTokenClaims,
  LogoutTokenResult,
  LogoutTokenVerifierOptions,
} from './logout-token';
// Ready-made back-channel logout receivers: Express, Fastify, Next.js / Fetch.
export {
  expressBackchannelLogout,
  fastifyBackchannelLogout,
  fastifyBackchannelLogoutPlugin,
  fetchBackchannelLogout,
  handleBackchannelLogout,
  nextBackchannelLogout,
  readLogoutToken,
} from './backchannel-handlers';
export type { BackchannelLogoutOptions, BackchannelLogoutResponse } from './backchannel-handlers';

// Server-side OIDC relying party for the hosted-redirect integration:
// state + nonce + PKCE flow cookie, code exchange, RS256-pinned ID-token checks.
export {
  AtlasOidcError,
  OIDC_FLOW_COOKIE,
  OIDC_FLOW_MAX_AGE_SECONDS,
  oidc,
  oidcCallback,
  oidcClearCookie,
  oidcLogoutUrl,
  oidcStart,
  oidcVerifyIdToken,
  oidcOrganizationOf,
  oidcOrganizationsOf,
  oidcSsoOf,
  resetOidcCaches,
} from './oidc';
export type {
  AtlasIdTokenClaims,
  AtlasOidc,
  AtlasOidcErrorCode,
  OidcOrganization,
  OidcOrganizationMembership,
  OidcSsoContext,
  OidcCallbackOptions,
  OidcClientAuth,
  OidcIdentity,
  OidcLogoutUrlOptions,
  OidcStartOptions,
  OidcStartResult,
  VerifyIdTokenOptions,
} from './oidc';

export * from './doctor';
// §12.2 inbound webhook verification for consumers.
export * from './webhooks';
export {
  MESSAGE_DELIVERY_EVENT_TYPES,
  verifyMessageDelivery,
  type MessageDeliveryData,
  type MessageDeliveryEvent,
  type MessageSuppressionData,
  type VerifyMessageDeliveryResult,
} from './message-delivery';
export * from './webhook-dedupe';
export * from './webhook-events';
// Framework-neutral Request -> Response handlers: path mount proxy, domain verify, webhook + hook routes.
export * from './mount';
export * from './fetch-handlers';
// Browser sign-in for your own CLI: device flow, stored session, refresh.

// Session helpers: mirror the Atlas user into your own table; CSRF tokens bound to the session.
export * from './sync-local-user';
export * from './csrf';
export * from './csrf-jws';
export * from './server-auth';

// The Atlas referral protocol, for a referral platform receiving Atlas's signed calls.
export * from './referrals';
export * from './policy-source';

// Vercel BotID: sign checkBotId() verdicts on your Vercel route for Atlas's captcha gate.
export * from './botid';

// The typed management client for the secret-key Backend API.
export { createAtlasClient } from './client';
export type { AtlasClient } from './client';
export * from './client';

// A local, authoritative mirror of end-user API keys (mint/import/revoke at
// Atlas, verify locally against sha256, sync from the revocation feed).
export { createKeyMirror, memoryKeyMirrorStore, hashApiKeySecret, intersectScopesWithPermissions, permissionCoversScope, ipInAllowlist } from './key-mirror';
export { signApiKeyAssertion } from './api-key-assertion';
export type { SignApiKeyAssertionOptions } from './api-key-assertion';
export type { MirrorAssertionVerification, KeyMirror, KeyMirrorOptions, KeyMirrorStore, MirroredApiKey, MirrorVerification, MirrorImportInput, MirrorImportResult } from './key-mirror';
export { createResourceRoleMirror, memoryResourceRoleMirrorStore, resolveMirrorGrants } from './resource-role-mirror';
export type {
  MirrorResourceRef,
  MirrorSubject,
  MirroredAssignment,
  MirroredResource,
  MirroredResourceType,
  ResourceRoleCheckOptions,
  ResourceRoleMirror,
  ResourceRoleMirrorCheck,
  ResourceRoleMirrorOptions,
  ResourceRoleMirrorStore,
} from './resource-role-mirror';

// §1.3(c) dev/test tooling — offline fixtures for verifying Atlas-minted
// session JWTs with no network call (Clerk's `@clerk/testing` equivalent).
// Its own module, so it never sits on the hot verification path.
export { createTestIssuer, TEST_TOKEN_TAMPERS, testTenantClaims } from './testing';
export type {
  TestIssuer,
  TestTenantContext,
  CreateTestIssuerOptions,
  MintIdTokenOptions,
  TestAuthorizeOptions,
  TestAuthorizeResult,
  TestTokenTamper,
} from './testing';
export {
  signAtlasReferralCall,
  signReferalliCall,
  signReferralUpdatedEvent,
  referalliSignature,
  referalliSignatureV2,
  referralEmailHash,
  REFERALLI_API_VERSION,
} from './referral-test-calls';
export type {
  AtlasReferralCallOptions,
  ReferalliCallOptions,
  ReferalliCallOp,
  ReferralUpdatedEvent,
  ReferralUpdatedEventOptions,
  SignedReferralCall,
} from './referral-test-calls';

// Proof-Carrying Authority (agentic auth) lives at `@atlasauth/backend/pca`, so this entry
// stays Edge-safe and installs no PCA code for apps that don't use it.


// Protecting your own API / MCP server with Atlas-issued OAuth access tokens:
// local verification (aud, scopes, DPoP) + RFC 6750/9728 challenges + metadata.
export {
  ACCESS_TOKEN_CLOCK_SKEW_SECONDS,
  DPOP_PROOF_MAX_AGE_SECONDS,
  buildWwwAuthenticate,
  createAccessTokenVerifier,
  createIntrospector,
  hmacDpopNonceSource,
  memoryDpopNonceSource,
  memoryDpopReplayStore,
  protectedResourceMetadata,
  protectedResourceMetadataPath,
  requireAcr,
  verifyAccessToken,
} from './oauth-resource';
export type {
  AccessTokenCallOptions,
  AccessTokenClaims,
  AccessTokenErrorCode,
  AccessTokenResult,
  AccessTokenVerifierOptions,
  DpopNonceSource,
  DpopReplayStore,
  IntrospectionOptions,
  ResourceRequestLike,
} from './oauth-resource';
export {
  authorizationDetailsOf,
  certificateThumbprint,
  forwardedClientCert,
  matchAuthorizationDetails,
  senderConstraintOf,
  thumbprintsEqual,
  tokenGrants,
} from './oauth-resource-sender';
export type {
  AuthorizationDetail,
  AuthorizationDetailRequirement,
  AuthorizationDetailsMatch,
  TokenGrant,
} from './oauth-resource-sender';
export * from './legacy-verify';
export * from './uma';
export type { SidListRevocation } from './sid-revocation';
export { revocationStream, memoryCursorStore, parseSseBlocks } from './revocation-stream';
export { listenEvents } from './listen-stream';
export type { ListenEvent, ListenEventsOptions } from './listen-stream';
export type { RevocationFrame, RevocationKind, RevocationCursorStore, RevocationStreamHandle, RevocationStreamOptions } from './revocation-stream';
export { createRevocationMirror, createSessionDenyList } from './revocation-mirror';
export type { RevocationMirror, RevocationMirrorOptions, SessionDenyList } from './revocation-mirror';
export { createMachineDenyList } from './machine-deny-list';
export type { MachineDenyList, MachineDenyListOptions } from './machine-deny-list';
export { verifyStatusListToken, createEdgeRevocationChecker, StatusListError } from './status-list';
export type { VerifiedStatusList, VerifyStatusListOptions, EdgeRevocationOptions, EdgeRevocationVerdict, StatusListKey } from './status-list';
export { sessionBindingOf, verifyBoundSession } from './session-binding';
export type { VerifyBoundSessionInput, VerifyBoundSessionResult } from './session-binding';
export { auditChainGenesis, auditLinkHash, auditRowHash, canonicalJson, verifyAuditChain, AUDIT_CHECKPOINT_TYP } from './audit-chain';
export type { AuditChainCheckpoint, AuditChainLink, AuditChainProblem, ChainedAuditRow, VerifyAuditChainInput, VerifyAuditChainResult } from './audit-chain';
export type { OAuthTokenRevocationOptions } from './oauth-token-revocation';

// Web Bot Auth (RFC 9421 signed bots): verify a request's signature against the bot's key directory, offline.
export {
  WEB_BOT_AUTH_TAG,
  WEB_BOT_AUTH_DIRECTORY_PATH,
  WEB_BOT_AUTH_DIRECTORY_MEDIA_TYPE,
  WebBotAuthDirectoryCache,
  buildSignatureBase,
  createWebBotAuthVerifier,
  decideWebBotAuth,
  directoryUrlFor,
  ed25519JwkThumbprint,
  normalizeDirectory,
  parseSignatureAgent,
  safeFetch,
  SafeFetchError,
  signWebBotAuthRequest,
  verifyWebBotAuth,
} from './web-bot-auth';
export type {
  SafeFetchOptions,
  SignWebBotAuthInput,
  WebBotAuthDecision,
  WebBotAuthDecisionKind,
  WebBotAuthFailure,
  WebBotAuthHeaders,
  WebBotAuthJwk,
  WebBotAuthListEntry,
  WebBotAuthPolicy,
  WebBotAuthRequest,
  WebBotAuthResult,
  WebBotAuthTier,
  WebBotAuthVerifierOptions,
  WebBotAuthVerifyOptions,
} from './web-bot-auth';
export { createRateLimiter, rateLimitRequest, createMemoryRateLimitStore, createRedisRateLimitStore } from './rate-limit';
export type {
  CreateRateLimiterOptions,
  RateLimitDecision,
  RateLimitPolicy,
  RateLimiter,
  RateLimitResult,
  RateLimitStore,
  RateLimitSubject,
  RateLimitSubjectKind,
  RedisEvalClient,
} from './rate-limit';

export * from './usage-gate';
export * from './entitlements';
export * from './approval-gate';
export * from './approval-receipt';

// Keep a local copy of Atlas resources in sync from the change feed (stores: memory, Redis, Postgres).
// The Drizzle and Prisma adapters are subpath exports: `@atlasauth/backend/mirror/drizzle`, `.../prisma`.
export * from './mirror';

// §7.3 token verification — the original surface, unchanged.
export * from './jwks-cache';
// OIDC discovery of the JWKS URL when only `issuer` is configured.
export { DiscoveryError, JwksDiscovery, discoveryUrlFor, instanceIdFromPublishableKey } from './discovery';
export * from './verify';
export * from './request-auth';
export * from './recent-auth';
export * from './txn-token';
export * from './access-control';
export * from './handshake';
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

// §12.2 inbound webhook verification for consumers.
export * from './webhooks';

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
export { createKeyMirror, memoryKeyMirrorStore, hashApiKeySecret } from './key-mirror';
export type { KeyMirror, KeyMirrorOptions, KeyMirrorStore, MirroredApiKey, MirrorVerification, MirrorImportInput } from './key-mirror';

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

// Proof-Carrying Authority (agentic auth): offline verifier + framework-agnostic guard,
// beside the session-token verifier above.
export { verifyPCActn } from './pca/verify';
export type { PcaVerdict, PcaContext, VerifyPCActnOptions } from './pca/verify';
export { requirePCA, defaultExtract, memoryPcaStore } from './pca/require-pca';
export type { RequirePcaOptions, PcaGuardResult, PcaRequestLike, PcaStateStore } from './pca/require-pca';

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
export * from './legacy-verify';
export * from './uma';

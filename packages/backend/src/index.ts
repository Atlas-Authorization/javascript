// §7.3 token verification — the original surface, unchanged.
export * from './jwks-cache';
// OIDC discovery of the JWKS URL when only `issuer` is configured.
export { DiscoveryError, JwksDiscovery, discoveryUrlFor, instanceIdFromPublishableKey } from './discovery';
export * from './verify';
export * from './handshake';

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
  resetOidcCaches,
} from './oidc';
export type {
  AtlasOidc,
  AtlasOidcErrorCode,
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

// The typed management client for the secret-key Backend API.
export { createAtlasClient } from './client';
export type { AtlasClient } from './client';
export * from './client';

// §1.3(c) dev/test tooling — offline fixtures for verifying Atlas-minted
// session JWTs with no network call (Clerk's `@clerk/testing` equivalent).
// Its own module, so it never sits on the hot verification path.
export { createTestIssuer, TEST_TOKEN_TAMPERS } from './testing';
export type {
  TestIssuer,
  CreateTestIssuerOptions,
  MintIdTokenOptions,
  TestAuthorizeOptions,
  TestAuthorizeResult,
  TestTokenTamper,
} from './testing';

// Proof-Carrying Authority (agentic auth): offline verifier + framework-agnostic guard,
// beside the session-token verifier above.
export { verifyPCActn } from './pca/verify';
export type { PcaVerdict, PcaContext, VerifyPCActnOptions } from './pca/verify';
export { requirePCA, defaultExtract, memoryPcaStore } from './pca/require-pca';
export type { RequirePcaOptions, PcaGuardResult, PcaRequestLike, PcaStateStore } from './pca/require-pca';

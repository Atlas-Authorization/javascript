// §7.3 token verification — the original surface, unchanged.
export * from './jwks-cache';
export * from './verify';
export * from './handshake';

// §12.2 inbound webhook verification for consumers.
export * from './webhooks';

// The typed management client for the secret-key Backend API.
export { createAtlasClient } from './client';
export type { AtlasClient } from './client';
export * from './client';

// §1.3(c) dev/test tooling — offline fixtures for verifying Atlas-minted
// session JWTs with no network call (Clerk's `@clerk/testing` equivalent).
// Its own module, so it never sits on the hot verification path.
export { createTestIssuer } from './testing';
export type { TestIssuer, CreateTestIssuerOptions } from './testing';

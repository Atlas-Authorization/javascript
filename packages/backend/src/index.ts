// §7.3 token verification — the original surface, unchanged.
export * from './jwks-cache';
export * from './verify';
export * from './handshake';

// The typed management client for the secret-key Backend API.
export { createAtlasClient } from './client';
export type { AtlasClient } from './client';
export * from './client';

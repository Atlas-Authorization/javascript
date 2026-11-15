import { atlasMiddleware } from '@atlasauth/astro';

// Verifies the session JWT locally (signing keys are cached) and fails closed: a bad or
// missing token is a signed-out request, never an error. Reads ATLAS_JWKS_URL and ATLAS_ISSUER.
export const onRequest = atlasMiddleware();

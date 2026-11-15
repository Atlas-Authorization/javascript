import { env } from '$env/dynamic/private';
import { handleAtlas } from '@atlasauth/svelte/server';

// Verifies the session JWT locally on every request (the signing keys are cached in-process)
// and stores the result on event.locals.auth. The values are server-only.
export const handle = handleAtlas({
  jwksUrl: env.ATLAS_JWKS_URL ?? '',
  issuer: env.ATLAS_ISSUER ?? '',
});

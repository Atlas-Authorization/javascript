import { AtlasBackend } from '@atlasauth/backend';
import { useRuntimeConfig } from '#imports';

/**
 * One `AtlasBackend` per Nitro process.
 *
 * The backend owns the in-process JWKS cache, so sharing a single instance
 * across requests is exactly what makes local verification free on the hot path
 * (§7.3) — a per-request instance would refetch the key set every time. It holds
 * no per-user state, only the immutable instance config and the shared cache, so
 * one process-wide instance is safe.
 */
let cached: AtlasBackend | null = null;

export function atlasBackend(): AtlasBackend {
  if (cached) return cached;

  const { atlas } = useRuntimeConfig();
  if (!atlas.jwksUrl || !atlas.issuer) {
    throw new Error(
      '@atlasauth/nuxt: server-side auth needs `runtimeConfig.atlas.jwksUrl` and `runtimeConfig.atlas.issuer` ' +
        '(set them via the module options or the NUXT_ATLAS_JWKS_URL / NUXT_ATLAS_ISSUER env vars).',
    );
  }

  cached = new AtlasBackend({
    jwksUrl: atlas.jwksUrl,
    issuer: atlas.issuer,
    authorizedParties: atlas.authorizedParties?.length ? atlas.authorizedParties : undefined,
  });
  return cached;
}

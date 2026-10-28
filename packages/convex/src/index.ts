/**
 * `@atlasauth/convex` — the Convex side of Atlas sign-in.
 *
 * Convex verifies the JWT your client hands it against the providers listed in
 * `convex/auth.config.ts`. An Atlas instance on its own custom frontend domain
 * is a plain OpenID Connect issuer, so Convex can discover its keys from the
 * issuer. An instance on the shared Atlas host signs with a per-instance key
 * that lives at a per-instance JWKS URL, so it is declared as a Convex
 * "custom JWT" provider pointing at that URL instead.
 *
 * ```ts
 * // convex/auth.config.ts
 * import { atlasAuthConfig } from '@atlasauth/convex';
 * export default atlasAuthConfig({ issuer: process.env.ATLAS_ISSUER!, instanceId: process.env.ATLAS_INSTANCE_ID });
 * ```
 *
 * This module has no runtime dependency (Convex loads the auth config in its
 * own runtime); the React provider lives in `@atlasauth/convex/react`.
 */

/** The JWT template the client asks Atlas for, and the `aud` it pins by default. */
export const DEFAULT_CONVEX_TEMPLATE = 'convex';
export const DEFAULT_APPLICATION_ID = 'convex';

/** The shared Atlas frontend host. Tokens issued there are verified per instance. */
export const SHARED_ATLAS_ISSUER = 'https://atlasauth.net';
/** Where the per-instance keys of a shared-host instance are published. */
export const SHARED_ATLAS_API = 'https://api.atlasauth.net';

/** A Convex OIDC provider: keys discovered from `<domain>/.well-known/openid-configuration`. */
export interface ConvexOidcProvider {
  domain: string;
  applicationID: string;
}

/** A Convex custom-JWT provider: the issuer and JWKS URL are given explicitly. */
export interface ConvexCustomJwtProvider {
  type: 'customJwt';
  issuer: string;
  jwks: string;
  algorithm: 'RS256';
  applicationID?: string;
}

export type ConvexAuthProvider = ConvexOidcProvider | ConvexCustomJwtProvider;

export interface AtlasConvexOptions {
  /**
   * The `iss` of your Atlas tokens: your custom frontend domain (for example
   * `https://auth.example.com`), or `https://atlasauth.net` on the shared host.
   */
  issuer: string;
  /**
   * Your instance id (`ins_…`). Required on the shared host, where the
   * per-instance JWKS URL is built from it. Ignored on a custom domain.
   */
  instanceId?: string;
  /**
   * The `aud` your Convex template pins (its `audience` setting). Convex
   * rejects a token whose `aud` differs. Default `convex`. Pass `null` for a
   * template with no audience (shared-host instances only: Convex's OIDC
   * provider type always checks `aud`).
   */
  applicationID?: string | null;
  /** Override the JWKS URL (rarely needed). */
  jwks?: string;
}

function normaliseIssuer(issuer: string): string {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error(`@atlasauth/convex: issuer must be an absolute URL, got "${issuer}".`);
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('@atlasauth/convex: issuer must use https.');
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/** Is this the shared Atlas host (whose keys are per instance)? */
export function isSharedAtlasIssuer(issuer: string): boolean {
  return normaliseIssuer(issuer) === SHARED_ATLAS_ISSUER;
}

/** The per-instance JWKS URL of a shared-host instance. */
export function sharedInstanceJwksUrl(instanceId: string): string {
  if (!/^ins_[A-Za-z0-9]+$/.test(instanceId)) {
    throw new Error(`@atlasauth/convex: instanceId must look like "ins_…", got "${instanceId}".`);
  }
  return `${SHARED_ATLAS_API}/instances/${instanceId}/.well-known/jwks.json`;
}

/** One Convex auth provider entry for an Atlas instance. */
export function atlasAuthProvider(options: AtlasConvexOptions): ConvexAuthProvider {
  const issuer = normaliseIssuer(options.issuer);
  const applicationID = options.applicationID === undefined ? DEFAULT_APPLICATION_ID : options.applicationID;

  if (issuer === SHARED_ATLAS_ISSUER || options.jwks) {
    let jwks = options.jwks;
    if (!jwks) {
      if (!options.instanceId) {
        throw new Error(
          '@atlasauth/convex: on the shared Atlas host, pass instanceId so Convex can find your instance\'s signing keys.',
        );
      }
      jwks = sharedInstanceJwksUrl(options.instanceId);
    }
    return {
      type: 'customJwt',
      issuer,
      jwks,
      algorithm: 'RS256',
      ...(applicationID ? { applicationID } : {}),
    };
  }

  if (!applicationID) {
    throw new Error(
      '@atlasauth/convex: an issuer on a custom domain is checked as an OIDC provider, which needs an applicationID (the template audience).',
    );
  }
  return { domain: issuer, applicationID };
}

/** The whole `convex/auth.config.ts` default export for one Atlas instance. */
export function atlasAuthConfig(options: AtlasConvexOptions): { providers: ConvexAuthProvider[] } {
  return { providers: [atlasAuthProvider(options)] };
}

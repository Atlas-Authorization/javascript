/**
 * Auth.js (NextAuth v5 / `@auth/core`) provider preset for Atlas. Atlas is a standards OpenID
 * Connect provider, so this is an `oidc` provider with Atlas defaults (scopes, PKCE + state,
 * profile mapping, button style). The same shape is the `providers/atlas` file proposed upstream
 * to Auth.js; no runtime import from Auth.js is needed, so it works with any v5 version.
 *
 * @example
 * import Atlas from '@atlasauth/authjs';
 * export const { handlers, auth } = NextAuth({
 *   providers: [Atlas({ issuer: process.env.AUTH_ATLAS_ISSUER, clientId: process.env.AUTH_ATLAS_ID, clientSecret: process.env.AUTH_ATLAS_SECRET })],
 * });
 */

export interface AtlasProfile {
  sub: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  preferred_username?: string;
  email?: string;
  email_verified?: boolean;
  picture?: string;
  [claim: string]: unknown;
}

export interface AtlasProviderOptions {
  /** Your instance's OpenID issuer URL (the origin that serves `/.well-known/openid-configuration`). */
  issuer: string;
  /** The OAuth application's client id (defaults are read by Auth.js from `AUTH_ATLAS_ID` when you omit the whole options object). */
  clientId?: string;
  clientSecret?: string;
  /** Extra scopes beyond `openid profile email`. */
  scope?: string;
  /** Override the provider id (the `/api/auth/signin/<id>` segment). Default `atlas`. */
  id?: string;
  name?: string;
}

export interface AtlasProviderConfig {
  id: string;
  name: string;
  type: 'oidc';
  issuer: string;
  clientId?: string;
  clientSecret?: string;
  authorization: { params: { scope: string } };
  checks: ('pkce' | 'state')[];
  style: { brandColor: string };
  profile(profile: AtlasProfile): { id: string; name: string | null; email: string | null; image: string | null };
  options?: unknown;
}

export default function Atlas(options: AtlasProviderOptions): AtlasProviderConfig {
  if (!options?.issuer) throw new Error('Atlas provider: `issuer` is required.');
  const issuer = options.issuer.replace(/\/+$/, '');
  return {
    id: options.id ?? 'atlas',
    name: options.name ?? 'Atlas',
    type: 'oidc',
    issuer,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    authorization: { params: { scope: ['openid profile email', options.scope].filter(Boolean).join(' ') } },
    checks: ['pkce', 'state'],
    style: { brandColor: '#4f46e5' },
    profile(profile) {
      const name = profile.name ?? ([profile.given_name, profile.family_name].filter(Boolean).join(' ') || profile.preferred_username);
      return { id: profile.sub, name: name || null, email: profile.email ?? null, image: profile.picture ?? null };
    },
  };
}

export { Atlas };

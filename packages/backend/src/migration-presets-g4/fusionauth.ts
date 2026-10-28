import type { MigrationBridgePreset } from '../migration-presets';

/**
 * FusionAuth. The access token (`app.at` cookie, or the Bearer token an API
 * client holds) is a JWT whose `iss` is the TENANT's issuer string: `acme.com`
 * by default (what `issuer_name` takes), or an https URL when the tenant was
 * set up that way (the `fusionauth_url_issuer` preset takes the base URL).
 * Keys come from `/.well-known/jwks.json` and publish only asymmetric keys:
 * a tenant still on the default HS256 signing key has to switch the
 * application's access-token key to an RSA or EC key before the bridge can
 * verify its tokens. `sub` is the FusionAuth user id the export keys users by,
 * `sid` the SSO session, `amr` lists `mfa` after a second factor.
 */
const WEEK = 7 * 24 * 3600;
const CLAIMS = { subject: 'sub', email: 'email', emailVerified: 'email_verified', name: 'name', sessionKey: 'sid', mfa: 'amr:mfa' };

export const FUSIONAUTH_BRIDGE_PRESETS: readonly MigrationBridgePreset[] = [
  {
    id: 'fusionauth',
    label: 'FusionAuth (access token, tenant issuer such as acme.com)',
    mode: 'jwt',
    vars: { base_url: 'FusionAuth URL (https://auth.example.com)', issuer_name: 'The tenant issuer (Tenants → General → Issuer, `acme.com` by default)' },
    jwt: {
      issuer: '{issuer_name}',
      keysUrl: '{base_url}/.well-known/jwks.json',
      algorithms: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'],
      claims: CLAIMS,
      expiredGraceSeconds: WEEK,
    },
    cookies: ['app.at'],
    clearCookies: ['app.at', 'app.rt', 'app.idt', 'app.match_hint', 'app.locale', 'app.ssoToken'],
    bearer: true,
    notes: 'The application must sign access tokens with an RSA or EC key (a default HS256 key has no public JWKS entry).',
  },
  {
    id: 'fusionauth_url_issuer',
    label: 'FusionAuth (access token, tenant issuer is the https URL)',
    mode: 'jwt',
    vars: { base_url: 'FusionAuth URL, also the tenant issuer (https://auth.example.com)' },
    jwt: {
      issuer: '{base_url}',
      keysUrl: '{base_url}/.well-known/jwks.json',
      algorithms: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'],
      claims: CLAIMS,
      expiredGraceSeconds: WEEK,
    },
    cookies: ['app.at'],
    clearCookies: ['app.at', 'app.rt', 'app.idt', 'app.match_hint', 'app.locale', 'app.ssoToken'],
    bearer: true,
  },
];

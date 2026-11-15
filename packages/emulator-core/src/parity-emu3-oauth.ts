import type { ParityRequest } from './parity';

/**
 * Parity requests for the advanced OAuth provider routes: initial access tokens, dynamic client registration and its
 * management endpoint, RP-initiated logout, grant management and UMA. They need dynamic registration (and, for UMA, UMA)
 * switched on in the reference instance, so every request carries the `oauth_flows` group. The grant and UMA routes are
 * called with an invalid bearer token (a real one needs the grant-management or protection scope), which both sides answer 401.
 */
const CB = 'https://app.example/callback';
const q = (id: string, method: ParityRequest['method'], path: string, rest: Partial<ParityRequest> = {}): ParityRequest => ({ id, method, path, group: 'oauth_flows', ...rest });
const nope = { authorization: 'Bearer not-a-real-token' };
const REG_TOLERATE = ['id', 'client_id', 'client_secret', 'client_id_issued_at', 'client_secret_expires_at', 'registration_access_token', 'registration_client_uri', 'owner', 'status', 'client_secret_expires_at'];

export const emu3OauthParityRequests: ParityRequest[] = [
  q('o3 iat create', 'POST', '/v1/oauth_initial_access_tokens', { body: { description: 'Parity {{rand}}', max_uses: 5 }, capture: { o3iat: 'token', o3iatid: 'id' }, tolerate: ['id', 'token', 'token_prefix', 'created_at', 'expires_at', 'note'] }),
  q('o3 iat list', 'GET', '/v1/oauth_initial_access_tokens', { tolerate: ['data'] }),
  q('o3 register', 'POST', '/oauth2/register', { anonymous: true, headers: { authorization: 'Bearer {{o3iat}}' }, body: { redirect_uris: [CB], client_name: 'Registered {{rand}}', grant_types: ['authorization_code', 'refresh_token'], scope: 'openid email', post_logout_redirect_uris: ['https://app.example/bye'] }, capture: { o3c: 'client_id', o3rat: 'registration_access_token', o3cs: 'client_secret' }, tolerate: REG_TOLERATE }),
  q('o3 register bad redirect', 'POST', '/oauth2/register', { anonymous: true, headers: { authorization: 'Bearer {{o3iat}}' }, body: { redirect_uris: ['http://evil.example/cb'] } }),
  q('o3 register get', 'GET', '/oauth2/register/{{o3c}}', { anonymous: true, headers: { authorization: 'Bearer {{o3rat}}' }, tolerate: REG_TOLERATE }),
  q('o3 register unauthorised', 'GET', '/oauth2/register/{{o3c}}', { anonymous: true, headers: nope }),
  q('o3 register put', 'PUT', '/oauth2/register/{{o3c}}', { anonymous: true, headers: { authorization: 'Bearer {{o3rat}}' }, body: { client_name: 'Renamed {{rand}}' }, tolerate: REG_TOLERATE }),
  q('o3 register secret', 'POST', '/oauth2/register/{{o3c}}/secret', { anonymous: true, headers: { authorization: 'Bearer {{o3rat}}' }, tolerate: ['client_id', 'client_secret', 'client_secret_expires_at'] }),
  q('o3 register delete', 'DELETE', '/oauth2/register/{{o3c}}', { anonymous: true, headers: { authorization: 'Bearer {{o3rat}}' } }),
  q('o3 iat revoke', 'DELETE', '/v1/oauth_initial_access_tokens/{{o3iatid}}', { tolerate: ['id', 'token_prefix', 'created_at', 'expires_at', 'revoked_at'] }),
  q('o3 logout get', 'GET', '/oauth2/logout?post_logout_redirect_uri=https%3A%2F%2Fapp.example%2Fbye&state=s1', { anonymous: true }),
  q('o3 logout post', 'POST', '/oauth2/logout', { anonymous: true, body: { state: 's1' } }),
  q('o3 grant get', 'GET', '/oauth2/grants/gnt_unknown', { anonymous: true, headers: nope }),
  q('o3 grant patch', 'PATCH', '/oauth2/grants/gnt_unknown', { anonymous: true, headers: nope, body: { scopes: ['openid'] } }),
  q('o3 grant delete', 'DELETE', '/oauth2/grants/gnt_unknown', { anonymous: true, headers: nope }),
  q('o3 uma config', 'GET', '/.well-known/uma2-configuration', { anonymous: true, tolerate: ['registration_endpoint'] }),
  q('o3 uma resource create', 'POST', '/oauth2/uma/resource_set', { anonymous: true, headers: nope, body: { name: 'Doc {{rand}}', resource_scopes: ['read'] } }),
  q('o3 uma resource list', 'GET', '/oauth2/uma/resource_set', { anonymous: true, headers: nope }),
  q('o3 uma resource get', 'GET', '/oauth2/uma/resource_set/umar_unknown', { anonymous: true, headers: nope }),
  q('o3 uma resource put', 'PUT', '/oauth2/uma/resource_set/umar_unknown', { anonymous: true, headers: nope, body: { name: 'Doc', resource_scopes: ['read'] } }),
  q('o3 uma resource delete', 'DELETE', '/oauth2/uma/resource_set/umar_unknown', { anonymous: true, headers: nope }),
  q('o3 uma permission', 'POST', '/oauth2/uma/permission', { anonymous: true, headers: nope, body: { resource_id: 'umar_unknown', resource_scopes: ['read'] } }),
  q('o3 uma claims', 'GET', '/oauth2/uma/claims?client_id=client_unknown&ticket=none', { anonymous: true }),
];

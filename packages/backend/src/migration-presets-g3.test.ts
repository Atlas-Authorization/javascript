import { describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { cookieNameMatches, getMigrationBridgePreset, resolveMigrationBridgePreset } from './migration-presets';
import { readPocketBaseCookieToken, readSupabaseAccessToken, readSupabaseRefreshToken } from './migration-bridge';

/**
 * The g3 bridge presets against FIXTURE TOKENS shaped like each vendor's real
 * ones (claims and header as the vendors document them): the resolved
 * issuer / audience / algorithms accept the vendor's token, the subject claim
 * is the id the export keys users by, and the cookie patterns match the names
 * the vendor SDKs write.
 */

async function signed(claims: Record<string, unknown>, opts: { iss: string; aud?: string; alg?: 'RS256' | 'ES256' }) {
  const alg = opts.alg ?? 'RS256';
  const { publicKey, privateKey } = await generateKeyPair(alg);
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg };
  let jwt = new SignJWT(claims).setProtectedHeader({ alg, kid: 'k1', typ: 'JWT' }).setIssuer(opts.iss).setIssuedAt().setExpirationTime('1h');
  if (opts.aud) jwt = jwt.setAudience(opts.aud);
  return { token: await jwt.sign(privateKey), keys: createLocalJWKSet({ keys: [jwk] }) };
}

async function accepts(presetId: string, vars: Record<string, string>, token: string, keys: ReturnType<typeof createLocalJWKSet>) {
  const r = resolveMigrationBridgePreset(presetId, vars);
  const { payload } = await jwtVerify(token, keys, {
    issuer: r.issuer!,
    ...(r.audience ? { audience: r.audience } : {}),
    algorithms: r.algorithms,
  });
  return { r, payload };
}

describe('g3 bridge presets', () => {
  it('replaced the starters', () => {
    expect(getMigrationBridgePreset('firebase')?.label).toMatch(/Identity Platform/);
    expect(getMigrationBridgePreset('cognito')?.jwt?.expiredGraceSeconds).toBe(7 * 24 * 3600);
    for (const id of ['supabase_self_hosted', 'supabase_refresh_token', 'azure_ad_b2c', 'entra_external_id', 'nhost', 'nhost_jwt']) expect(getMigrationBridgePreset(id), id).toBeDefined();
  });

  it('firebase: a securetoken ID token (sub = uid, no jti)', async () => {
    const { token, keys } = await signed(
      { sub: 'uid-1', user_id: 'uid-1', email: 'ada@example.com', email_verified: true, auth_time: 1, firebase: { identities: {}, sign_in_provider: 'password' } },
      { iss: 'https://securetoken.google.com/my-proj', aud: 'my-proj' },
    );
    const { r, payload } = await accepts('firebase', { project_id: 'my-proj' }, token, keys);
    expect(payload[r.claims.subject]).toBe('uid-1');
    expect(r.claims.sessionKey).toBeUndefined();
    expect(r.keysUrl).toBe('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    const cookie = resolveMigrationBridgePreset('firebase_session_cookie', { project_id: 'my-proj' });
    expect(cookie).toMatchObject({ issuer: 'https://session.firebase.google.com/my-proj', keysFormat: 'x509', cookies: ['session', '__session'] });
  });

  it('supabase: an ES256 access token with session_id, read from the chunked SSR cookie', async () => {
    const { token, keys } = await signed(
      { sub: 'b7d1-uuid', role: 'authenticated', aal: 'aal1', session_id: 'sess-1', is_anonymous: false, email: 'ada@example.com' },
      { iss: 'https://abcdefghijklmnop.supabase.co/auth/v1', aud: 'authenticated', alg: 'ES256' },
    );
    const { r, payload } = await accepts('supabase', { project_ref: 'abcdefghijklmnop' }, token, keys);
    expect(payload[r.claims.sessionKey!]).toBe('sess-1');
    expect(r.cookies).toEqual(['sb-abcdefghijklmnop-auth-token']);
    // @supabase/ssr: "base64-" + base64url(JSON), split into .0 / .1 chunks.
    const value = `base64-${Buffer.from(JSON.stringify({ access_token: token, refresh_token: 'r' })).toString('base64url')}`;
    const cookies = { 'sb-abcdefghijklmnop-auth-token.0': value.slice(0, 100), 'sb-abcdefghijklmnop-auth-token.1': value.slice(100) };
    expect(readSupabaseAccessToken(cookies, 'sb-abcdefghijklmnop-auth-token')).toBe(token);
    expect(resolveMigrationBridgePreset('supabase_self_hosted', { auth_url: 'https://db.example.com/auth/v1/', cookie_name: 'sb-db-auth-token' }).issuer).toBe(
      'https://db.example.com/auth/v1',
    );
  });

  it('supabase_refresh_token: the refresh token in the same SSR cookie, looked up among imported sessions', () => {
    const r = resolveMigrationBridgePreset('supabase_refresh_token', { project_ref: 'abcdefghijklmnop' });
    expect(r).toMatchObject({ mode: 'session_table', tokenFormat: 'supabase_refresh', cookies: ['sb-abcdefghijklmnop-auth-token'] });
    // Legacy GoTrue refresh tokens: 12 random characters, stored as is in auth.refresh_tokens.token.
    const value = `base64-${Buffer.from(JSON.stringify({ access_token: 'a.b.c', refresh_token: 'v9zKq3xYw2Lp' })).toString('base64url')}`;
    expect(readSupabaseRefreshToken({ 'sb-abcdefghijklmnop-auth-token': value }, 'sb-abcdefghijklmnop-auth-token')).toBe('v9zKq3xYw2Lp');
    // @supabase/auth-helpers kept an array: [access, refresh, provider token, provider refresh token, factors].
    expect(readSupabaseRefreshToken({ x: encodeURIComponent(JSON.stringify(['a.b.c', 'v9zKq3xYw2Lp', null, null, null])) }, 'x')).toBe('v9zKq3xYw2Lp');
    expect(readSupabaseRefreshToken({ x: JSON.stringify({ access_token: 'a.b.c' }) }, 'x')).toBeUndefined();
  });

  it('cognito: an ID token (aud = client id), Amplify cookie names', async () => {
    const iss = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbC123';
    const { token, keys } = await signed({ sub: 'c0g-uuid', token_use: 'id', 'cognito:username': 'ada', origin_jti: 'o-1', email: 'ada@example.com' }, { iss, aud: 'clientid123' });
    const vars = { region: 'us-east-1', user_pool_id: 'us-east-1_AbC123', client_id: 'clientid123' };
    const { r, payload } = await accepts('cognito', vars, token, keys);
    expect(payload[r.claims.sessionKey!]).toBe('o-1');
    expect(r.cookies.some((p) => cookieNameMatches(p, 'CognitoIdentityServiceProvider.clientid123.ada.idToken'))).toBe(true);
    expect(r.clearCookies.some((p) => cookieNameMatches(p, 'CognitoIdentityServiceProvider.clientid123.LastAuthUser'))).toBe(true);
  });

  it('azure ad b2c: a policy-issued ID token (sub = object id)', async () => {
    const tid = '775527ff-9a37-4307-8b3d-cc311f58d925';
    const { token, keys } = await signed({ sub: 'oid-1', tfp: 'B2C_1_signin', emails: ['ada@example.com'], ver: '1.0' }, { iss: `https://contoso.b2clogin.com/${tid}/v2.0/`, aud: 'app-guid' });
    const { r, payload } = await accepts('azure_ad_b2c', { tenant: 'contoso', tenant_id: tid, policy: 'B2C_1_signin', client_id: 'app-guid' }, token, keys);
    expect(payload[r.claims.subject]).toBe('oid-1');
    expect(r.keysUrl).toBe('https://contoso.b2clogin.com/contoso.onmicrosoft.com/B2C_1_signin/discovery/v2.0/keys');
  });

  it('entra external id: keyed on oid, spent on uti', async () => {
    const tid = '11111111-2222-3333-4444-555555555555';
    const { token, keys } = await signed({ sub: 'per-app', oid: 'oid-9', uti: 'u-1', tid }, { iss: `https://${tid}.ciamlogin.com/${tid}/v2.0`, aud: 'app-guid' });
    const { r, payload } = await accepts('entra_external_id', { tenant: 'contoso', tenant_id: tid, client_id: 'app-guid' }, token, keys);
    expect(payload[r.claims.subject]).toBe('oid-9');
    expect(payload[r.claims.sessionKey!]).toBe('u-1');
  });

  it('nhost: refresh-token session table, and the access-token preset with the legacy issuer', async () => {
    expect(resolveMigrationBridgePreset('nhost')).toMatchObject({ mode: 'session_table', cookies: ['nhostRefreshToken'] });
    const { token, keys } = await signed(
      { sub: 'u-uuid', 'https://hasura.io/jwt/claims': { 'x-hasura-user-id': 'u-uuid', 'x-hasura-default-role': 'user', 'x-hasura-allowed-roles': ['user', 'me'] } },
      { iss: 'hasura-auth' },
    );
    const { r } = await accepts('nhost_jwt', { auth_url: 'https://abc.auth.eu-central-1.nhost.run/v1' }, token, keys);
    expect(r.keysUrl).toBe('https://abc.auth.eu-central-1.nhost.run/v1/.well-known/jwks.json');
  });

  it('appwrite: remote check of the session cookie against GET /account', () => {
    const r = resolveMigrationBridgePreset('appwrite', { endpoint_url: 'https://cloud.appwrite.io/v1/', project_id: 'proj1' });
    expect(r.remote).toMatchObject({
      url: 'https://cloud.appwrite.io/v1/account',
      method: 'GET',
      headers: { 'x-appwrite-project': 'proj1', 'x-appwrite-session': '{token}' },
      subjectPath: '$id',
    });
    expect(r.cookies.some((c) => cookieNameMatches(c, 'a_session_proj1'))).toBe(true);
    expect(() => resolveMigrationBridgePreset('appwrite', { endpoint_url: 'http://appwrite.local/v1', project_id: 'p' })).toThrow();
  });

  it('pocketbase: remote auth-refresh, token read from the pb_auth cookie', () => {
    const r = resolveMigrationBridgePreset('pocketbase', { url: 'https://pb.example.com' });
    expect(r.remote).toMatchObject({ url: 'https://pb.example.com/api/collections/users/auth-refresh', method: 'POST', headers: { authorization: '{token}' }, subjectPath: 'record.id' });
    expect(resolveMigrationBridgePreset('pocketbase', { url: 'https://pb.example.com', collection: 'members' }).remote?.url).toContain('/collections/members/');
    const cookie = JSON.stringify({ token: 'pb.jwt', record: { id: 'abc' } });
    expect(readPocketBaseCookieToken(cookie)).toBe('pb.jwt');
    expect(readPocketBaseCookieToken(encodeURIComponent(cookie))).toBe('pb.jwt');
    expect(readPocketBaseCookieToken('not json')).toBeUndefined();
  });
});

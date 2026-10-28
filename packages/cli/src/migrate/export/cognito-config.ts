import type { TranslationResult } from '../framework/plugin';
import type { Json } from '../../serialize';
import type { CognitoApi } from './cognito';
import { isObj, objs, str, strs, type Obj } from './record-set';
import { ConfigBuilder, clampSessionMs, keyOf } from './translate-kit';
import { VendorApiError } from './vendor-http';

/**
 * `atlas migrate cognito config` — a user pool's settings → Atlas config,
 * read with the owner's AWS credentials on this machine: DescribeUserPool
 * (password policy, MFA, sign-in identifiers, verification, self sign-up,
 * Lambda triggers), every app client (callback URLs, OAuth scopes, token
 * lifetimes, auth flows), identity providers (social → Atlas providers,
 * SAML / OIDC → SSO connections), resource servers (APIs and scopes) and
 * groups (roles).
 */
export interface CognitoConfigSnapshot {
  poolId: string;
  region: string;
  pool: Obj;
  clients: Obj[];
  idps: Obj[];
  resourceServers: Obj[];
  groups: Obj[];
}

export async function fetchCognitoConfig(api: CognitoApi, poolId: string, region: string): Promise<CognitoConfigSnapshot> {
  const soft = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof VendorApiError && (err.status === 400 || err.status === 403) && !/ResourceNotFound/.test(err.message)) return fallback;
      throw err;
    }
  };
  const described = await api.call<Obj>('DescribeUserPool', { UserPoolId: poolId });
  const pool = isObj(described.UserPool) ? described.UserPool : {};
  const clients: Obj[] = [];
  for (const c of await soft(() => api.all('ListUserPoolClients', { UserPoolId: poolId, MaxResults: 60 }, 'UserPoolClients', 'NextToken'), [])) {
    const id = str(c.ClientId);
    if (!id) continue;
    const res = await api.call<Obj>('DescribeUserPoolClient', { UserPoolId: poolId, ClientId: id });
    if (isObj(res.UserPoolClient)) clients.push(res.UserPoolClient);
  }
  const idps: Obj[] = [];
  for (const p of await soft(() => api.all('ListIdentityProviders', { UserPoolId: poolId, MaxResults: 60 }, 'Providers', 'NextToken'), [])) {
    const name = str(p.ProviderName);
    if (!name) continue;
    const res = await api.call<Obj>('DescribeIdentityProvider', { UserPoolId: poolId, ProviderName: name });
    if (isObj(res.IdentityProvider)) idps.push(res.IdentityProvider);
  }
  return {
    poolId,
    region,
    pool,
    clients,
    idps,
    resourceServers: await soft(() => api.all('ListResourceServers', { UserPoolId: poolId, MaxResults: 50 }, 'ResourceServers', 'NextToken'), []),
    groups: await soft(() => api.all('ListGroups', { UserPoolId: poolId, Limit: 60 }, 'Groups', 'NextToken'), []),
  };
}

/** Cognito social provider types → Atlas built-in provider keys. */
const SOCIAL: Record<string, string> = { Google: 'google', Facebook: 'facebook', SignInWithApple: 'apple', LoginWithAmazon: 'amazon' };

const UNIT_MS: Record<string, number> = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

/** A client's token validity in ms (`RefreshTokenValidity` with `TokenValidityUnits.RefreshToken`). */
export function validityMs(client: Obj, field: 'AccessToken' | 'IdToken' | 'RefreshToken'): number | undefined {
  const value = client[`${field}Validity`];
  if (typeof value !== 'number' || value <= 0) return undefined;
  const units = isObj(client.TokenValidityUnits) ? str(client.TokenValidityUnits[field]) : undefined;
  return value * (UNIT_MS[units ?? (field === 'RefreshToken' ? 'days' : 'hours')] ?? UNIT_MS.hours!);
}

/** Lambda trigger → the Atlas place its logic moves to. */
const TRIGGERS: Record<string, string> = {
  PreSignUp: 'the pre_user_registration action',
  PostConfirmation: 'the post_user_registration action',
  PreAuthentication: 'a post_login action (deny there)',
  PostAuthentication: 'a post_login action',
  PreTokenGeneration: 'session claims / a JWT template',
  PreTokenGenerationConfig: 'session claims / a JWT template',
  UserMigration: 'nothing: Atlas lazy migration replaces it (it checks passwords against Cognito itself)',
  CustomMessage: 'Atlas email and SMS templates',
  DefineAuthChallenge: 'Atlas sign-in strategies (custom challenges have no counterpart)',
  CreateAuthChallenge: 'Atlas sign-in strategies (custom challenges have no counterpart)',
  VerifyAuthChallengeResponse: 'Atlas sign-in strategies (custom challenges have no counterpart)',
  CustomEmailSender: 'Atlas email delivery settings (your own SMTP / provider)',
  CustomSMSSender: 'Atlas SMS delivery settings',
  InboundFederation: 'an SSO connection attribute mapping / a post_login action',
};

export function translateCognitoConfig(snap: CognitoConfigSnapshot): TranslationResult {
  const b = new ConfigBuilder();
  const pool = snap.pool;
  const area = `user pool ${snap.poolId}`;

  // ── sign-in identifiers ──
  const usernameAttrs = strs(pool.UsernameAttributes);
  const aliasAttrs = strs(pool.AliasAttributes);
  const signInAttrs = new Set([...usernameAttrs, ...aliasAttrs]);
  const firstFactors = isObj(pool.Policies) && isObj(pool.Policies.SignInPolicy) ? strs(pool.Policies.SignInPolicy.AllowedFirstAuthFactors) : [];
  const passwordOn = !firstFactors.length || firstFactors.includes('PASSWORD');
  if (passwordOn) {
    b.set('strategies.password', true);
    b.add('differs', area, 'Policies.SignInPolicy (PASSWORD)', 'Password sign-in. Cognito never exports password hashes: the cognito lazy-migration preset checks each password against Cognito on first sign-in.', 'auth_config.strategies.password');
  }
  if (!usernameAttrs.length || aliasAttrs.includes('preferred_username')) {
    b.set('strategies.username', true);
    b.add(
      usernameAttrs.length ? 'mapped' : 'differs',
      area,
      usernameAttrs.length ? 'AliasAttributes preferred_username' : 'UsernameAttributes (none: username pool)',
      usernameAttrs.length ? 'Sign-in with a preferred username.' : 'Users sign in with a username. Cognito usernames that are not the generated id move as Atlas usernames.',
      'auth_config.strategies.username',
    );
  }
  if (signInAttrs.has('email')) b.add('mapped', area, usernameAttrs.includes('email') ? 'UsernameAttributes email' : 'AliasAttributes email', 'Sign-in with an email address.', 'auth_config.strategies.password');
  if (signInAttrs.has('phone_number')) b.add('differs', area, usernameAttrs.includes('phone_number') ? 'UsernameAttributes phone_number' : 'AliasAttributes phone_number', 'Phone numbers are a sign-in identifier: enable phone sign-in in Atlas (SMS code); a password with a phone number signs in through lazy migration.', 'auth_config.strategies.phoneCode');
  if (firstFactors.includes('EMAIL_OTP')) {
    b.set('strategies.emailCode', true);
    b.add('mapped', area, 'Policies.SignInPolicy.AllowedFirstAuthFactors EMAIL_OTP', 'Passwordless email code.', 'auth_config.strategies.emailCode');
  }
  if (firstFactors.includes('SMS_OTP')) {
    b.set('strategies.phoneCode', true);
    b.add('mapped', area, 'Policies.SignInPolicy.AllowedFirstAuthFactors SMS_OTP', 'Passwordless SMS code.', 'auth_config.strategies.phoneCode');
  }
  if (firstFactors.includes('WEB_AUTHN')) {
    b.set('strategies.passkey', true);
    b.add('differs', area, 'Policies.SignInPolicy.AllowedFirstAuthFactors WEB_AUTHN', 'Passkeys. Cognito does not export credentials (and they are bound to the Cognito domain): users register a passkey again.', 'auth_config.strategies.passkey');
  }
  const caseSensitive = isObj(pool.UsernameConfiguration) ? pool.UsernameConfiguration.CaseSensitive : undefined;
  if (caseSensitive === true) b.add('differs', area, 'UsernameConfiguration.CaseSensitive', 'Cognito usernames are case sensitive; Atlas usernames and emails are case insensitive (two usernames differing only in case would collide).');

  // ── verification ──
  const autoVerified = strs(pool.AutoVerifiedAttributes);
  if (autoVerified.includes('email')) {
    b.set('requireEmailVerification', true);
    b.add('mapped', area, 'AutoVerifiedAttributes email', 'Emails are verified by code at sign-up.', 'auth_config.requireEmailVerification');
  }
  if (autoVerified.includes('phone_number')) b.add('mapped', area, 'AutoVerifiedAttributes phone_number', 'Phone numbers are verified by SMS code.', 'auth_config.strategies.phoneCode');

  // ── self sign-up ──
  const adminOnly = isObj(pool.AdminCreateUserConfig) && pool.AdminCreateUserConfig.AllowAdminCreateUserOnly === true;
  if (adminOnly) {
    b.set('signUpMode', 'restricted');
    b.add('mapped', area, 'AdminCreateUserConfig.AllowAdminCreateUserOnly', 'Self sign-up is closed: users are created by an admin or invited.', 'auth_config.signUpMode');
  }

  // ── password policy ──
  const pw = isObj(pool.Policies) && isObj(pool.Policies.PasswordPolicy) ? pool.Policies.PasswordPolicy : undefined;
  if (pw) {
    const min = typeof pw.MinimumLength === 'number' ? pw.MinimumLength : 8;
    b.set('passwordPolicy.minLength', Math.max(8, min));
    b.add(min < 8 ? 'differs' : 'mapped', area, 'Policies.PasswordPolicy.MinimumLength', `${min}${min < 8 ? ' (Atlas requires at least 8; existing passwords still sign in)' : ''}.`, 'auth_config.passwordPolicy.minLength');
    if (['RequireUppercase', 'RequireLowercase', 'RequireNumbers', 'RequireSymbols'].some((k) => pw[k] === true)) {
      b.set('passwordPolicy.checkBreaches', true);
      b.add('differs', area, 'Policies.PasswordPolicy (character classes)', 'Atlas follows NIST 800-63B: length and breached-password checks instead of character-class rules.', 'auth_config.passwordPolicy');
    }
    if (typeof pw.TemporaryPasswordValidityDays === 'number') b.add('manual', area, 'Policies.PasswordPolicy.TemporaryPasswordValidityDays', 'Atlas does not issue temporary passwords: invite users instead (invitations expire on their own).', 'invitations');
    if (typeof pw.PasswordHistorySize === 'number' && pw.PasswordHistorySize > 0) b.add('manual', area, 'Policies.PasswordPolicy.PasswordHistorySize', 'Atlas does not keep a password history.');
  }

  // ── MFA ──
  const mfa = str(pool.MfaConfiguration);
  const smsMfa = isObj(pool.SmsConfiguration);
  if (mfa === 'ON') {
    b.set('mfaPolicy', 'required');
    b.add('mapped', area, 'MfaConfiguration ON', 'A second factor on every sign-in.', 'auth_config.mfaPolicy');
  } else if (mfa === 'OPTIONAL') {
    b.set('mfaPolicy', 'optional');
    b.add('mapped', area, 'MfaConfiguration OPTIONAL', 'Users may enrol a second factor.', 'auth_config.mfaPolicy');
  }
  if (mfa === 'ON' || mfa === 'OPTIONAL') {
    b.set('mfa.factors.totp', true);
    b.add('differs', area, 'SoftwareTokenMfaConfiguration', 'Authenticator apps. Cognito never exports TOTP secrets: users with one enrol again.', 'auth_config.mfa.factors.totp');
    if (smsMfa) b.add('differs', area, 'SmsMfaConfiguration', 'SMS second factors move with the export (the verified phone number); Atlas recommends TOTP or passkeys.', 'auth_config.mfa');
  }

  // ── advanced security ──
  const security = isObj(pool.UserPoolAddOns) ? str(pool.UserPoolAddOns.AdvancedSecurityMode) : undefined;
  if (security && security !== 'OFF') b.add('differs', area, `UserPoolAddOns.AdvancedSecurityMode ${security}`, 'Cognito threat protection (compromised credentials, adaptive authentication): Atlas checks breached passwords and rate-limits sign-ins; review risk rules by hand.', 'auth_config.passwordPolicy.checkBreaches');
  if (str(pool.DeletionProtection) === 'ACTIVE') b.add('manual', area, 'DeletionProtection', 'Turn deletion protection off before you delete the pool after the cutover.');

  // ── custom attributes ──
  const custom = objs(pool.SchemaAttributes).filter((a) => str(a.Name)?.startsWith('custom:'));
  if (custom.length) b.add('differs', area, 'SchemaAttributes custom:*', `${custom.length} custom attribute(s) (${custom.map((a) => str(a.Name)).join(', ')}) move to each user's public_metadata without the custom: prefix. Atlas does not enforce their types; mutability per app client is not translated.`, 'users public_metadata');

  // ── Lambda triggers ──
  const lambdas = isObj(pool.LambdaConfig) ? pool.LambdaConfig : {};
  for (const [trigger, value] of Object.entries(lambdas)) {
    if (trigger === 'KMSKeyID' || (!str(value) && !isObj(value))) continue;
    const target = TRIGGERS[trigger];
    b.add(trigger === 'UserMigration' ? 'differs' : 'manual', area, `LambdaConfig.${trigger}`, `Lambda trigger: port its logic to ${target ?? 'an Atlas action or webhook'}.`, trigger === 'UserMigration' ? 'legacy_auth_connection' : 'actions');
  }

  // ── app clients ──
  const redirects = new Set<string>();
  let refreshMs: number | undefined;
  let lazyClient: string | undefined;
  let bridgeClient: string | undefined;
  for (const c of snap.clients) {
    const name = str(c.ClientName) ?? str(c.ClientId) ?? '?';
    const carea = `app client ${name}`;
    for (const u of strs(c.CallbackURLs)) redirects.add(u);
    for (const u of strs(c.LogoutURLs)) redirects.add(u);
    const r = validityMs(c, 'RefreshToken');
    if (r !== undefined) refreshMs = Math.max(refreshMs ?? 0, r);
    const flows = strs(c.ExplicitAuthFlows);
    const secret = !!str(c.ClientSecret);
    // The bridge audience: the first public (browser / mobile) client, else the first one.
    if (!secret) bridgeClient ??= str(c.ClientId);
    if (!secret && (flows.includes('ALLOW_USER_PASSWORD_AUTH') || flows.includes('USER_PASSWORD_AUTH'))) lazyClient ??= str(c.ClientId);
    if (strs(c.AllowedOAuthFlows).includes('client_credentials')) b.add('manual', carea, 'AllowedOAuthFlows client_credentials', 'A machine-to-machine client: create an Atlas M2M client for it.', 'oauth_clients');
    if (flows.includes('ALLOW_CUSTOM_AUTH') || flows.includes('CUSTOM_AUTH_FLOW_ONLY')) b.add('manual', carea, 'ExplicitAuthFlows ALLOW_CUSTOM_AUTH', 'Custom auth challenges (Lambda) have no Atlas counterpart: use passwordless email / SMS codes or passkeys.');
    const idTtl = validityMs(c, 'IdToken');
    if (idTtl !== undefined && idTtl !== 3_600_000) b.add('differs', carea, 'IdTokenValidity', `ID tokens lived ${Math.round(idTtl / 60_000)} minutes. Atlas session tokens are short-lived (refreshed by the SDK) and the session lifetime is set instance-wide.`, 'auth_config.session');
    for (const p of strs(c.SupportedIdentityProviders)) if (p !== 'COGNITO' && !snap.idps.some((i) => str(i.ProviderName) === p)) b.add('manual', carea, `SupportedIdentityProviders ${p}`, 'An identity provider the client allows that the pool does not describe.');
  }
  bridgeClient ??= str(snap.clients[0]?.ClientId);
  if (snap.clients.length > 1) b.add('differs', 'app clients', `${snap.clients.length} app clients`, `The bridge accepts ID tokens for one audience (${bridgeClient}); run it once per client whose users must move silently.`, 'migration bridge');
  if (refreshMs !== undefined) {
    b.set('session.absoluteMs', clampSessionMs(refreshMs));
    b.add(refreshMs > 90 * 86_400_000 ? 'differs' : 'mapped', 'app clients', 'RefreshTokenValidity', `Users stayed signed in ${Math.round(refreshMs / 86_400_000)} day(s) (the longest client)${refreshMs > 90 * 86_400_000 ? '; Atlas sessions last at most 90 days' : ''}.`, 'auth_config.session.absoluteMs');
  }
  for (const url of redirects) {
    if (url.includes('*')) b.add('differs', 'app clients', `CallbackURLs ${url}`, 'Atlas redirect URLs are exact (no wildcards).', 'redirect_urls');
    else b.push('redirect_urls', { url });
  }
  if (redirects.size) b.add('mapped', 'app clients', 'CallbackURLs / LogoutURLs', `${redirects.size} callback / sign-out URL(s).`, 'redirect_urls');
  if (snap.clients.length && !lazyClient) {
    b.add('manual', 'app clients', 'ExplicitAuthFlows ALLOW_USER_PASSWORD_AUTH', 'Lazy migration needs an app client WITHOUT a client secret that allows ALLOW_USER_PASSWORD_AUTH: create one (it is only used to check passwords) and pass its id to the lazy step.', 'legacy_auth_connection');
  }

  // ── identity providers ──
  for (const idp of snap.idps) {
    const name = str(idp.ProviderName) ?? '?';
    const type = str(idp.ProviderType) ?? '';
    const details = isObj(idp.ProviderDetails) ? idp.ProviderDetails : {};
    if (type === 'SAML' || type === 'OIDC') {
      b.add('mapped', 'identity providers', `${name} (${type})`, `Enterprise IdP: moves with the data export as an Atlas SSO connection; give the IdP Atlas's ${type === 'SAML' ? 'ACS URL and entity id' : 'redirect URI'}, and map its IdpIdentifiers to the connection's domains.`, 'sso_connections');
      continue;
    }
    const key = SOCIAL[type];
    if (!key) {
      b.add('manual', 'identity providers', `${name} (${type})`, 'No built-in Atlas provider: add it as a custom OAuth provider.', 'custom_oauth_providers');
      continue;
    }
    b.socialProvider({ atlasKey: key, vendorName: name, area: 'identity providers', setting: `${name} (${type})`, clientId: str(details.client_id), scopes: str(details.authorize_scopes)?.split(/[\s,]+/).filter(Boolean) });
  }

  // ── resource servers → APIs ──
  for (const rs of snap.resourceServers) {
    const identifier = str(rs.Identifier);
    if (!identifier) continue;
    const scopes = objs(rs.Scopes).map((s) => str(s.ScopeName)).filter((s): s is string => !!s);
    b.push('resource_servers', { identifier, name: str(rs.Name) ?? identifier, scopes } as Json);
    b.add('differs', `resource servers ${str(rs.Name) ?? identifier}`, `Identifier ${identifier}`, `An API with ${scopes.length} scope(s). Cognito scopes are "${identifier}/<scope>"; Atlas tokens carry the bare scope with "aud": "${identifier}".`, `resource_servers ${identifier}`);
  }

  // ── groups → roles ──
  for (const g of snap.groups) {
    const name = str(g.GroupName);
    if (!name) continue;
    const key = keyOf(name);
    b.roles[name] = key;
    b.push('roles', { key, name, description: str(g.Description) ?? '', permissions: [] } as Json);
    if (str(g.RoleArn)) b.add('manual', `groups ${name}`, 'RoleArn', 'The group grants an IAM role through an identity pool: Atlas does not issue AWS credentials; keep the identity pool with Atlas as an OIDC provider, or call STS from your backend.');
  }
  if (snap.groups.length) b.add('differs', 'groups', 'groups', `${snap.groups.length} group(s) become Atlas app roles (memberships move with the data export); cognito:groups becomes the roles claim. Precedence is not translated.`, 'roles');

  return b.result(`Cognito user pool ${snap.poolId}`, {
    bridge: { preset: 'cognito', vars: { region: snap.region, user_pool_id: snap.poolId, ...(bridgeClient ? { client_id: bridgeClient } : {}) } },
    lazy: { preset: 'cognito', config: { region: snap.region, user_pool_id: snap.poolId, ...(lazyClient ? { client_id: lazyClient } : {}) } },
  });
}

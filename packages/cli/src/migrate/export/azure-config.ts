import type { TranslationReportEntry, TranslationResult } from '../framework/plugin';
import type { Json } from '../../serialize';
import { azureTenantInfo, graphAll, type AzureKind } from './azure';
import { isObj, objs, str, strs, type Obj } from './record-set';
import { ConfigBuilder, clampSessionMs, keyOf } from './translate-kit';
import { VendorApiError, type VendorHttp } from './vendor-http';

/**
 * `atlas migrate azure-ad-b2c | entra-external-id config` — the tenant's
 * sign-in setup → Atlas config, read through Microsoft Graph with the
 * owner's app registration: identity providers (local email / username /
 * phone, email OTP, social, OIDC / SAML federation), user flows (B2C
 * `b2cUserFlows` on Graph beta, External ID `authenticationEventsFlows`),
 * custom user attributes, app registrations (redirect URIs) and groups.
 *
 * B2C custom policies (Identity Experience Framework) are read from the
 * policy XML files when given: every claims provider technical profile is
 * reported with its file and line (social / OIDC / SAML IdPs, REST API
 * calls, JWT issuer lifetimes, the relying party's subject claim).
 */
export interface AzureConfigSnapshot {
  kind: AzureKind;
  tenant: string;
  tenantId?: string;
  tenantName?: string;
  identityProviders: Obj[];
  /** B2C user flows (with `identityProviders` and `userAttributeAssignments` expanded when Graph allows). */
  userFlows: Obj[];
  /** External ID sign-up / sign-in flows. */
  eventsFlows: Obj[];
  userFlowAttributes: Obj[];
  applications: Obj[];
  groups: Obj[];
  /** B2C custom policy files: name and XML text. */
  policies: Array<{ file: string; text: string }>;
}

const BETA = 'https://graph.microsoft.com/beta';

export async function fetchAzureConfig(http: VendorHttp, kind: AzureKind, tenant: string, policies: AzureConfigSnapshot['policies'] = []): Promise<AzureConfigSnapshot> {
  const soft = async (path: string): Promise<Obj[]> => {
    try {
      return await graphAll(http, path);
    } catch (err) {
      if (err instanceof VendorApiError && [400, 401, 403, 404].includes(err.status)) return [];
      throw err;
    }
  };
  const info = await azureTenantInfo(http);
  const userFlows = kind === 'b2c' ? await soft(`${BETA}/identity/b2cUserFlows`) : [];
  for (const f of userFlows) {
    const id = str(f.id);
    if (!id) continue;
    f.identityProviders = await soft(`${BETA}/identity/b2cUserFlows/${encodeURIComponent(id)}/userFlowIdentityProviders`);
    f.userAttributeAssignments = await soft(`${BETA}/identity/b2cUserFlows/${encodeURIComponent(id)}/userAttributeAssignments`);
  }
  return {
    kind,
    tenant,
    tenantId: info.tenantId,
    tenantName: info.tenantName,
    identityProviders: await soft('/identity/identityProviders'),
    userFlows,
    eventsFlows: kind === 'entra' ? await soft('/identity/authenticationEventsFlows') : [],
    userFlowAttributes: await soft('/identity/userFlowAttributes'),
    applications: await soft('/applications?$select=id,appId,displayName,web,spa,publicClient,isFallbackPublicClient,signInAudience&$top=999'),
    groups: await soft('/groups?$select=id,displayName,description&$top=999'),
    policies,
  };
}

/** Graph social identityProviderType → Atlas built-in provider key. */
const SOCIAL: Record<string, string> = {
  google: 'google',
  facebook: 'facebook',
  microsoftaccount: 'microsoft',
  microsoft: 'microsoft',
  amazon: 'amazon',
  linkedin: 'linkedin',
  twitter: 'x',
  github: 'github',
  apple: 'apple',
};

const typeOf = (o: Obj) => (str(o['@odata.type']) ?? '').replace('#microsoft.graph.', '');

// ── B2C custom policies ─────────────────────────────────────────────────────

export interface PolicyTechnicalProfile {
  file: string;
  line: number;
  id: string;
  displayName?: string;
  protocol?: string;
  handler?: string;
  metadata: Record<string, string>;
  /** The `<Domain>` of the claims provider the profile belongs to. */
  domain?: string;
  /** Inside `<RelyingParty>` (the policy's own token profile, not a federation). */
  relyingParty: boolean;
}

const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;
const decodeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** The technical profiles of one policy file (regex-level: IEF policies are regular, attribute-quoted XML). */
export function parsePolicyProfiles(file: string, text: string): PolicyTechnicalProfile[] {
  const out: PolicyTechnicalProfile[] = [];
  const rpStart = text.indexOf('<RelyingParty');
  const re = /<TechnicalProfile\s+Id="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/TechnicalProfile>)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const body = m[3] ?? '';
    const metadata: Record<string, string> = {};
    const meta = /<Metadata>([\s\S]*?)<\/Metadata>/.exec(body);
    if (meta) for (const item of meta[1]!.matchAll(/<Item\s+Key="([^"]+)"\s*>([\s\S]*?)<\/Item>/g)) metadata[item[1]!] = decodeXml(item[2]!.trim());
    const protocol = /<Protocol\s+Name="([^"]+)"(?:\s+Handler="([^"]+)")?/.exec(body);
    out.push({
      file,
      line: lineAt(text, m.index),
      id: m[1]!,
      displayName: /<DisplayName>([\s\S]*?)<\/DisplayName>/.exec(body)?.[1]?.trim(),
      protocol: protocol?.[1],
      handler: protocol?.[2],
      metadata,
      domain: domainBefore(text, m.index),
      relyingParty: rpStart >= 0 && m.index > rpStart,
    });
  }
  return out;
}

/** The `<Domain>` of the `<ClaimsProvider>` enclosing a position, if any. */
function domainBefore(text: string, index: number): string | undefined {
  const start = text.lastIndexOf('<ClaimsProvider>', index);
  if (start < 0) return undefined;
  return /<Domain>([\s\S]*?)<\/Domain>/.exec(text.slice(start, index))?.[1]?.trim();
}

/** The relying party's `sub` output claim, with its location (`objectId` keeps the bridge working). */
export function relyingPartySubject(file: string, text: string): { claim: string; line: number } | undefined {
  const rp = text.indexOf('<RelyingParty');
  if (rp < 0) return undefined;
  const m = /<OutputClaim\s+ClaimTypeReferenceId="([^"]+)"[^>]*PartnerClaimType="sub"/.exec(text.slice(rp));
  return m ? { claim: m[1]!, line: lineAt(text, rp + m.index) } : undefined;
}

function translatePolicies(b: ConfigBuilder, files: AzureConfigSnapshot['policies']): void {
  const at = (p: { file: string; line: number }, status: TranslationReportEntry['status'], setting: string, note: string, atlas?: string) =>
    b.report.push({ status, area: `custom policy ${p.file}`, setting, note, file: p.file, line: p.line, ...(atlas ? { atlas } : {}) });
  for (const { file, text } of files) {
    for (const tp of parsePolicyProfiles(file, text)) {
      if (tp.relyingParty) continue;
      const protocol = tp.protocol ?? '';
      const handler = tp.handler ?? '';
      const name = `TechnicalProfile ${tp.id}`;
      if (protocol === 'OAuth2' || protocol === 'OpenIdConnect') {
        const provider = (tp.metadata.ProviderName ?? tp.domain ?? '').toLowerCase();
        const key = Object.entries(SOCIAL).find(([k]) => provider.includes(k))?.[1];
        if (key) {
          const before = b.report.length;
          b.socialProvider({ atlasKey: key, vendorName: tp.displayName ?? tp.id, area: `custom policy ${file}`, setting: name, clientId: tp.metadata.client_id, scopes: tp.metadata.scope?.split(/\s+/).filter(Boolean) });
          if (b.report.length > before) Object.assign(b.report[b.report.length - 1]!, { file, line: tp.line });
        } else {
          at(tp, 'mapped', name, `${protocol} federation${tp.metadata.METADATA ? ` (${tp.metadata.METADATA})` : ''}: an Atlas OIDC SSO connection; register Atlas's redirect URI with the IdP and reuse its client id.`, 'sso_connections');
        }
      } else if (protocol === 'SAML2' && !/Saml2AssertionIssuer|SamlIssuer/i.test(handler + tp.id)) {
        at(tp, 'mapped', name, `SAML federation${tp.metadata.PartnerEntity ? ` (${tp.metadata.PartnerEntity})` : ''}: an Atlas SAML SSO connection; give the IdP Atlas's ACS URL and entity id.`, 'sso_connections');
      } else if (/RestfulProvider/i.test(handler)) {
        at(tp, 'manual', name, `REST API call${tp.metadata.ServiceUrl ? ` to ${tp.metadata.ServiceUrl}` : ''} during the journey: port it to an Atlas action (pre_user_registration / post_login) or webhook.`, 'actions');
      } else if (/JwtIssuer/i.test(handler) || (protocol === 'None' && /JwtIssuer/i.test(tp.id))) {
        const refresh = Number(tp.metadata.rolling_refresh_token_lifetime_secs ?? tp.metadata.refresh_token_lifetime_secs);
        if (Number.isFinite(refresh) && refresh > 0) {
          b.set('session.absoluteMs', clampSessionMs(refresh * 1000));
          at(tp, 'mapped', `${name} refresh_token_lifetime_secs`, `Users stayed signed in up to ${Math.round(refresh / 86_400)} day(s).`, 'auth_config.session.absoluteMs');
        }
        if (tp.metadata.token_lifetime_secs) at(tp, 'differs', `${name} token_lifetime_secs`, 'Atlas session tokens are short-lived and refreshed by the SDK; the lifetime is not configurable per policy.', 'auth_config.session');
      } else if (/PhoneFactor/i.test(handler)) {
        at(tp, 'differs', name, 'Phone MFA: SMS second factors move with the export (with authentication methods); Atlas recommends TOTP or passkeys.', 'auth_config.mfa');
      } else if (/AzureMfa/i.test(handler) || /totp|authenticator/i.test(tp.id)) {
        b.set('mfa.factors.totp', true);
        at(tp, 'differs', name, 'Authenticator-app MFA: the secrets do not move, users enrol again.', 'auth_config.mfa.factors.totp');
      } else if (/ClaimsTransformationProtocolProvider|AzureActiveDirectoryProvider|SelfAssertedAttributeProvider|SSOSessionProvider|NoopSSO|DefaultSSO|ExternalLoginSSO|OAuthSSO/i.test(handler + protocol + tp.id)) {
        continue; // directory reads/writes, self-asserted pages and session managers: built into Atlas
      } else if (protocol === 'Proprietary' || protocol === 'None') {
        at(tp, 'manual', name, `${handler.split(',')[0] || protocol} technical profile: review whether your journey depends on it.`);
      }
    }
    const sub = relyingPartySubject(file, text);
    if (sub && sub.claim !== 'objectId') {
      at({ file, line: sub.line }, 'differs', `RelyingParty OutputClaim ${sub.claim} → sub`, `This policy issues ${sub.claim} as sub, not the object id the export keys users by: set the bridge subject claim to one carrying the object id (add an oid output claim), or the bridge cannot find users.`, 'migration bridge');
    }
  }
}

// ── the translation ─────────────────────────────────────────────────────────

export function translateAzureConfig(snap: AzureConfigSnapshot): TranslationResult {
  const b = new ConfigBuilder();
  const label = snap.kind === 'b2c' ? 'Azure AD B2C' : 'Entra External ID';

  // ── identity providers ──
  let localPassword = snap.kind === 'b2c'; // B2C local accounts are always available to user flows
  for (const idp of snap.identityProviders) {
    const t = typeOf(idp);
    const name = str(idp.displayName) ?? str(idp.id) ?? t;
    const setting = `${name} (${t || 'identityProvider'})`;
    if (t === 'builtInIdentityProvider') {
      const kind = str(idp.identityProviderType) ?? str(idp.id) ?? '';
      if (/EmailPassword/i.test(kind)) localPassword = true;
      else if (/EmailOTP/i.test(kind)) {
        b.set('strategies.emailCode', true);
        b.add('mapped', 'identity providers', setting, 'Email one-time passcode sign-in.', 'auth_config.strategies.emailCode');
      } else if (/AADSignup|MSASignup/i.test(kind)) b.add('manual', 'identity providers', setting, 'Sign-in with a Microsoft work / personal account: add Atlas\'s Microsoft provider (or an Entra ID SSO connection) and point it at your app registration.', 'oauth_providers microsoft');
      continue;
    }
    if (t === 'appleManagedIdentityProvider') {
      b.socialProvider({ atlasKey: 'apple', vendorName: name, area: 'identity providers', setting, clientId: str(idp.serviceId) });
      continue;
    }
    if (t === 'socialIdentityProvider' || t === 'identityProvider') {
      const kind = (str(idp.identityProviderType) ?? str(idp.type) ?? '').toLowerCase();
      const key = SOCIAL[kind];
      if (key) b.socialProvider({ atlasKey: key, vendorName: name, area: 'identity providers', setting, clientId: str(idp.clientId) });
      else b.add('manual', 'identity providers', setting, 'No built-in Atlas provider: add it as a custom OAuth provider.', 'custom_oauth_providers');
      continue;
    }
    if (t === 'openIdConnectIdentityProvider' || t === 'oidcIdentityProvider') {
      b.add('mapped', 'identity providers', setting, `OIDC federation${str(idp.metadataUrl) ?? str(idp.issuer) ? ` (${str(idp.metadataUrl) ?? str(idp.issuer)})` : ''}: an Atlas OIDC SSO connection; register Atlas's redirect URI with the IdP and reuse its client id.`, 'sso_connections');
      continue;
    }
    if (/saml|wsFed|Federation/i.test(t)) {
      b.add('mapped', 'identity providers', setting, 'SAML / WS-Fed federation: an Atlas SAML SSO connection; give the IdP Atlas\'s ACS URL and entity id (WS-Fed IdPs need their SAML endpoint).', 'sso_connections');
      continue;
    }
    b.add('manual', 'identity providers', setting, 'Unrecognised identity provider type: review it by hand.');
  }
  if (localPassword) {
    b.set('strategies.password', true);
    b.add('differs', 'identity providers', snap.kind === 'b2c' ? 'Local accounts' : 'EmailPassword', `Password sign-in. ${label} never exports passwords: the ${snap.kind === 'b2c' ? 'azure_ad_b2c' : 'entra_external_id'} lazy-migration preset checks each one on first sign-in.`, 'auth_config.strategies.password');
  }

  // ── B2C user flows ──
  let ropcFlow: string | undefined;
  let signInFlow: string | undefined;
  for (const f of snap.userFlows) {
    const id = str(f.id) ?? '?';
    const type = str(f.userFlowType) ?? '';
    const area = `user flow ${id}`;
    if (type === 'resourceOwner') {
      ropcFlow ??= id;
      b.add('mapped', area, 'userFlowType resourceOwner', 'The ROPC user flow lazy migration checks passwords with.', 'legacy_auth_connection');
      continue;
    }
    if (type === 'signUpOrSignIn' || type === 'signIn') signInFlow ??= id;
    if (type === 'signUp' || type === 'signUpOrSignIn' || type === 'signIn') {
      b.add('mapped', area, `userFlowType ${type}`, 'Atlas\'s sign-in / sign-up pages (or components) replace this flow.', 'auth_config.strategies');
      if (Number(f.userFlowTypeVersion) === 1) b.add('differs', area, 'userFlowTypeVersion 1', 'A legacy (v1) user flow: check that its tokens carry the object id as sub before relying on the bridge.', 'migration bridge');
    } else if (type === 'passwordReset') b.add('mapped', area, 'userFlowType passwordReset', 'Atlas\'s built-in password reset.', 'auth_config.strategies.password');
    else if (type === 'profileUpdate') b.add('mapped', area, 'userFlowType profileUpdate', 'Atlas\'s user profile component.', 'user profile');
    for (const a of objs(f.userAttributeAssignments)) {
      const attr = str(a.id) ?? str(a.displayName);
      if (attr && /^extension_/i.test(attr)) b.add('differs', area, `userAttributeAssignments ${attr}`, 'A custom attribute collected at sign-up: collect it with an Atlas sign-up field (unsafe_metadata) or after sign-in; existing values move to public_metadata.', 'sign-up fields');
    }
    if (isObj(f.apiConnectorConfiguration) && Object.values(f.apiConnectorConfiguration).some((v) => v !== null)) {
      b.add('manual', area, 'apiConnectorConfiguration', 'API connectors run during sign-up: port them to Atlas actions (pre_user_registration).', 'actions');
    }
  }

  // ── External ID sign-up / sign-in flows ──
  for (const f of snap.eventsFlows) {
    const name = str(f.displayName) ?? str(f.id) ?? '?';
    const area = `user flow ${name}`;
    b.add('mapped', area, typeOf(f) || 'authenticationEventsFlow', 'Atlas\'s sign-in / sign-up pages (or components) replace this flow.', 'auth_config.strategies');
    const start = isObj(f.onAuthenticationMethodLoadStart) ? f.onAuthenticationMethodLoadStart : {};
    for (const idp of objs(start.identityProviders)) {
      const id = str(idp.id) ?? '';
      if (/EmailPassword/i.test(id)) {
        b.set('strategies.password', true);
      } else if (/EmailOtp/i.test(id)) {
        b.set('strategies.emailCode', true);
      }
    }
    const collect = isObj(f.onAttributeCollection) ? f.onAttributeCollection : {};
    for (const a of objs(collect.attributes)) {
      const attr = str(a.id) ?? str(a.displayName);
      if (!attr || ['email', 'displayName', 'givenName', 'surname'].includes(attr)) continue;
      b.add('differs', area, `onAttributeCollection ${attr}`, 'Collected at sign-up: use an Atlas sign-up field (unsafe_metadata) or collect it after sign-in; existing values move to metadata.', 'sign-up fields');
    }
    if (strs(isObj(f.conditions) && isObj(f.conditions.applications) ? objs(f.conditions.applications.includeApplications).map((x) => x.appId) : []).length > 1) {
      b.add('differs', area, 'conditions.applications', 'One flow per set of apps: Atlas has one sign-in configuration per instance.', 'auth_config');
    }
  }

  // ── custom user attributes ──
  const custom = snap.userFlowAttributes.filter((a) => str(a.userFlowAttributeType) === 'custom');
  if (custom.length) b.add('differs', 'user attributes', 'userFlowAttributes (custom)', `${custom.length} custom attribute(s) (${custom.map((a) => str(a.displayName) ?? str(a.id)).join(', ')}) move to each user's public_metadata under their bare name; Atlas does not enforce their types.`, 'users public_metadata');

  // ── app registrations → redirect URLs ──
  const redirects = new Set<string>();
  let publicClient: string | undefined;
  for (const app of snap.applications) {
    const name = str(app.displayName) ?? '';
    if (/^b2c-extensions-app/i.test(name)) continue;
    const uris = [
      ...strs(isObj(app.web) ? app.web.redirectUris : undefined),
      ...strs(isObj(app.spa) ? app.spa.redirectUris : undefined),
      ...strs(isObj(app.publicClient) ? app.publicClient.redirectUris : undefined),
    ].filter((u) => !/^(msal[0-9a-f-]+|ms-appx-web|urn:ietf):/i.test(u));
    for (const u of uris) redirects.add(u);
    if (app.isFallbackPublicClient === true) publicClient ??= str(app.appId);
  }
  for (const url of redirects) {
    if (url.includes('*')) b.add('differs', 'app registrations', `redirectUris ${url}`, 'Atlas redirect URLs are exact (no wildcards).', 'redirect_urls');
    else b.push('redirect_urls', { url });
  }
  if (redirects.size) b.add('mapped', 'app registrations', 'web / spa / publicClient redirectUris', `${redirects.size} redirect URI(s).`, 'redirect_urls');

  // ── groups → roles ──
  for (const g of snap.groups) {
    const name = str(g.displayName);
    if (!name) continue;
    const key = keyOf(name);
    b.roles[name] = key;
    b.push('roles', { key, name, description: str(g.description) ?? '', permissions: [] } as Json);
  }
  if (snap.groups.length) b.add('differs', 'groups', 'groups', `${snap.groups.length} group(s) become Atlas app roles (memberships move with the data export).`, 'roles');

  // ── always manual ──
  b.add('manual', 'tenant', 'company branding / page layouts', 'Recreate your branding with Atlas appearance settings (custom HTML page layouts do not translate).', 'appearance');
  if (snap.kind === 'b2c') b.add('manual', 'tenant', 'MFA, password complexity and session settings of user flows', 'Graph does not expose these user-flow properties: read them in the portal (user flow → Properties) and set the Atlas equivalents.', 'auth_config.mfaPolicy');
  else b.add('manual', 'tenant', 'conditional access / MFA policies', 'Conditional Access and the MFA authentication-methods policy are not translated: set the Atlas MFA policy by hand.', 'auth_config.mfaPolicy');

  translatePolicies(b, snap.policies);

  const tenantName = snap.tenantName ?? (/^[a-z0-9-]+\.onmicrosoft\.com$/i.test(snap.tenant) ? snap.tenant.split('.')[0]!.toLowerCase() : undefined);
  const bridgeVars: Record<string, string> = {};
  if (tenantName) bridgeVars.tenant = tenantName;
  if (snap.tenantId) bridgeVars.tenant_id = snap.tenantId;
  if (publicClient) bridgeVars.client_id = publicClient;
  const lazyConfig: Record<string, string> = {};
  if (tenantName) lazyConfig.tenant = tenantName;
  if (publicClient) lazyConfig.client_id = publicClient;
  if (snap.kind === 'b2c') {
    if (signInFlow) bridgeVars.policy = signInFlow;
    if (ropcFlow) lazyConfig.policy = ropcFlow;
    else b.add('manual', 'user flows', 'resourceOwner user flow', 'Lazy migration needs a ROPC user flow (User flows → New → Sign in using resource owner password credentials) and a public client app registration allowed to use it.', 'legacy_auth_connection');
  } else {
    b.add('manual', 'app registrations', 'native authentication', 'Lazy migration uses the native authentication API: on a public client app registration, turn on "Allow native authentication" and add it to the sign-up / sign-in flow.', 'legacy_auth_connection');
  }
  const preset = snap.kind === 'b2c' ? 'azure_ad_b2c' : 'entra_external_id';
  return b.result(`${label} tenant ${tenantName ? `${tenantName}.onmicrosoft.com` : snap.tenant}`, {
    bridge: { preset, vars: bridgeVars },
    lazy: { preset, config: lazyConfig },
  });
}

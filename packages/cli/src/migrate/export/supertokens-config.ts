import type { TranslationResult } from '../framework/plugin';
import { corePrefix, listTenants } from './supertokens';
import { isObj, objs, str, strs, type Obj } from './record-set';
import { ConfigBuilder, clampSessionMs, socialKey } from './translate-kit';
import { VendorApiError, type VendorHttp } from './vendor-http';

/**
 * `atlas migrate supertokens config` — the core's multitenancy settings →
 * Atlas config, read from the core API with its API key on this machine: which
 * recipes the public tenant enables (email/password, third-party, passwordless),
 * its first and required secondary factors, third-party providers (client ids
 * only; secrets become placeholders), and the core configuration (token and
 * code lifetimes). Everything that lives in your backend's `supertokens.init`
 * (override functions, custom claims, email delivery) is reported as manual:
 * the core never sees it.
 */
export interface SupertokensConfigSnapshot {
  origin: string;
  appId: string;
  tenants: Obj[];
}

export async function fetchSupertokensConfig(http: VendorHttp, origin: string, appId: string): Promise<SupertokensConfigSnapshot> {
  let tenants: Obj[] = [];
  try {
    tenants = await listTenants(http, appId);
  } catch (err) {
    if (!(err instanceof VendorApiError) || ![401, 403, 404, 501].includes(err.status)) throw err;
  }
  // A core without the multitenancy listing still has the public tenant's single-tenant view.
  if (!tenants.length) {
    try {
      const { body } = await http.get<Obj>(`${corePrefix(appId, 'public')}/recipe/multitenancy/tenant?tenantId=public`);
      if (isObj(body)) tenants = [body];
    } catch (err) {
      if (!(err instanceof VendorApiError) || ![401, 403, 404, 501].includes(err.status)) throw err;
    }
  }
  return { origin, appId, tenants };
}

const enabled = (v: unknown): boolean => isObj(v) && v.enabled === true;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Core defaults when the tenant's config does not override them. */
const DEFAULT_REFRESH_MINUTES = 144_000;

export function translateSupertokensConfig(snap: SupertokensConfigSnapshot): TranslationResult {
  const b = new ConfigBuilder();
  const pub = snap.tenants.find((t) => str(t.tenantId) === 'public') ?? snap.tenants[0];
  if (!pub) {
    b.add('manual', 'core', 'tenant list', 'The core did not return its tenants (check the API key): nothing to translate. Your recipes live in supertokens.init in your backend; list them by hand.');
  } else {
    const first = strs(pub.firstFactors);
    const hasFirst = (...f: string[]) => f.some((x) => first.includes(x));
    // firstFactors is absent on older cores: fall back to the recipes' enabled flags.
    const legacy = first.length === 0;

    // ── recipes and first factors ──
    if (enabled(pub.emailPassword) && (legacy || hasFirst('emailpassword'))) {
      b.set('strategies.password', true);
      b.add('differs', 'recipes emailpassword', 'emailPassword.enabled', 'Password sign-in. The core API never returns password hashes: export from the core database (bcrypt and Argon2 verify as they are) or use the supertokens lazy-migration preset.', 'auth_config.strategies.password');
    }
    if (enabled(pub.passwordless)) {
      if (legacy || hasFirst('otp-email')) {
        b.set('strategies.emailCode', true);
        b.add('mapped', 'recipes passwordless', 'firstFactors otp-email', 'Email one-time codes.', 'auth_config.strategies.emailCode');
      }
      if (legacy || hasFirst('link-email')) {
        b.set('strategies.emailLink', true);
        b.add('mapped', 'recipes passwordless', 'firstFactors link-email', 'Email magic links.', 'auth_config.strategies.emailLink');
      }
      if (legacy || hasFirst('otp-phone')) {
        b.set('strategies.phoneCode', true);
        b.add('mapped', 'recipes passwordless', 'firstFactors otp-phone', 'SMS codes (bring your own SMS provider).', 'auth_config.strategies.phoneCode');
      }
      if (hasFirst('link-phone')) b.add('differs', 'recipes passwordless', 'firstFactors link-phone', 'SMS magic links have no Atlas counterpart: use SMS codes.', 'auth_config.strategies.phoneCode');
    }

    // ── third-party providers ──
    const providers = isObj(pub.thirdParty) ? objs(pub.thirdParty.providers) : [];
    if (enabled(pub.thirdParty) || providers.length) {
      for (const p of providers) {
        const id = str(p.thirdPartyId) ?? '';
        const name = str(p.name) ?? id;
        const clients = objs(p.clients);
        const client = clients[0];
        const key = socialKey(id);
        if (!key) {
          b.add('manual', 'recipes thirdparty', `${name} (${id})`, 'No built-in Atlas provider: add it as a custom OAuth provider (or an SSO connection for SAML via Boxy).', 'custom_oauth_providers');
          continue;
        }
        b.socialProvider({ atlasKey: key, vendorName: name, area: 'recipes thirdparty', setting: `${name} (${id})`, clientId: str(client?.clientId), scopes: strs(client?.scope) });
        if (clients.length > 1) b.add('differs', 'recipes thirdparty', `${name} clients`, `${clients.length} OAuth clients (web, mobile…): Atlas keeps one per provider; add the others as native-app credentials.`, `oauth_providers ${key}`);
      }
    }

    // ── multi-factor ──
    const second = strs(pub.requiredSecondaryFactors);
    if (second.includes('totp')) {
      b.set('mfa.factors.totp', true);
      b.add('mapped', 'recipes multifactorauth', 'requiredSecondaryFactors totp', 'Authenticator apps; verified TOTP devices move with a database export.', 'auth_config.mfa.factors.totp');
    }
    for (const f of second.filter((x) => x !== 'totp')) {
      const channel = f === 'otp-email' ? 'emailCode' : null;
      if (channel) {
        b.set('mfa.factors.emailCode', true);
        b.add('mapped', 'recipes multifactorauth', `requiredSecondaryFactors ${f}`, 'Email code as a second factor.', 'auth_config.mfa.factors.emailCode');
      } else {
        b.add('differs', 'recipes multifactorauth', `requiredSecondaryFactors ${f}`, 'Atlas recommends authenticator apps or passkeys as the second factor; enable the factors you want in auth_config.mfa.', 'auth_config.mfa');
      }
    }
    if (second.length) {
      b.set('mfaPolicy', 'required');
      b.add('differs', 'recipes multifactorauth', 'requiredSecondaryFactors', 'A second factor on every sign-in. If your backend decides per user (the MFA recipe\'s getMFARequirementsForAuth override), set the policy to optional and use step-up for the sensitive routes.', 'auth_config.mfaPolicy');
    } else if (strs(pub.firstFactors).length) {
      b.add('manual', 'recipes multifactorauth', 'getMFARequirementsForAuth override', 'MFA requirements set in code (supertokens.init) are not visible to the core: port them to the Atlas MFA policy or step-up rules.', 'auth_config.mfaPolicy');
    }

    // ── core configuration ──
    const core = isObj(pub.coreConfig) ? pub.coreConfig : {};
    const refresh = num(core.refresh_token_validity) ?? DEFAULT_REFRESH_MINUTES;
    b.set('session.absoluteMs', clampSessionMs(refresh * 60_000));
    b.add('mapped', 'core config', 'refresh_token_validity', `${refresh} minutes (the session lives as long as its refresh token); Atlas caps a session at 90 days.`, 'auth_config.session.absoluteMs');
    const access = num(core.access_token_validity);
    if (access !== undefined) b.add('differs', 'core config', 'access_token_validity', `SuperTokens access tokens lived ${access}s. Atlas session tokens are short-lived and refreshed by its SDKs (auth_config.session.jwtTtlSeconds).`, 'auth_config.session.jwtTtlSeconds');
    const codeLife = num(core.passwordless_code_lifetime);
    if (codeLife !== undefined) {
      const minutes = Math.max(1, Math.round(codeLife / 60_000));
      b.set('verification.emailCode.ttlMinutes', minutes);
      b.add('mapped', 'core config', 'passwordless_code_lifetime', `Codes live ${minutes} minute(s).`, 'auth_config.verification.emailCode.ttlMinutes');
    }
    const attempts = num(core.passwordless_max_code_input_attempts);
    if (attempts !== undefined) {
      b.set('verification.emailCode.maxAttempts', attempts);
      b.add('mapped', 'core config', 'passwordless_max_code_input_attempts', `${attempts} attempts per code.`, 'auth_config.verification.emailCode.maxAttempts');
    }
    for (const k of ['password_reset_token_lifetime', 'email_verification_token_lifetime']) {
      if (num(core[k]) !== undefined) b.add('differs', 'core config', k, 'Atlas link and code lifetimes are instance settings; review auth_config.verification.', 'auth_config.verification');
    }
    if (core.totp_max_attempts !== undefined || core.totp_rate_limit_cooldown_sec !== undefined) {
      b.add('differs', 'core config', 'totp_max_attempts / totp_rate_limit_cooldown_sec', 'Atlas throttles failed second-factor attempts per account and IP.', 'auth_config.rateLimit');
    }
    // ── other tenants ──
    const others = snap.tenants.filter((t) => t !== pub);
    for (const t of others) {
      b.add('differs', `tenants ${str(t.tenantId) ?? '?'}`, 'tenant', 'A tenant becomes an organization with the data export; its own enabled recipes and providers are not translated: configure per-organization SSO connections for them.', 'organizations');
    }
  }

  // ── what the core never sees ──
  b.add('manual', 'backend config', 'supertokens.init override functions', 'Recipe overrides (custom sign-up rules, claims, email and SMS delivery) live in your backend: port sign-up rules to Atlas actions, claims to a JWT template, and delivery to your own email / SMS provider.', 'actions');
  b.add('manual', 'backend config', 'EmailVerification mode (REQUIRED / OPTIONAL)', 'The mode is set in supertokens.init, not in the core: set auth_config.requireEmailVerification to match it.', 'auth_config.requireEmailVerification');
  b.add('manual', 'backend config', 'appInfo (apiDomain, websiteDomain, cookieDomain)', 'Add your website origin to the instance allowed origins; set the cross-subdomain cookie setting if you used cookieDomain.', 'instance.allowed_origins');

  // The bridge needs the app's API domain (apiDomain), not the core's address: the plugin asks for it.
  return b.result(`SuperTokens core ${snap.origin} (app ${snap.appId})`, {
    lazy: { preset: 'supertokens', config: { base_url: snap.origin } },
  });
}

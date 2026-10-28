import type { TranslationResult } from '../framework/plugin';
import type { Json } from '../../serialize';
import { parseYaml } from './mini-yaml';
import { isObj, objs, str, strs, type Obj } from './record-set';
import { ConfigBuilder, clampSessionMs, keyOf, socialKey } from './translate-kit';
import { VendorHttp, nextLink } from './vendor-http';

/**
 * `atlas migrate ory config` — Ory Kratos and Hydra settings → Atlas config.
 *
 * Three readers, one translation:
 *   - a Kratos config file (`kratos.yml`, or the JSON `ory get identity-config
 *     --format json` prints), every report line carrying file:line for YAML;
 *   - an Ory Network project (`ory get project <id> --format json`: the Kratos
 *     config under `services.identity.config`, Hydra's under
 *     `services.oauth2.config`);
 *   - a Hydra config (`hydra.yml`) and the live Hydra Admin API, whose OAuth 2.0
 *     clients become Atlas OAuth clients (Hydra keeps only hashed client
 *     secrets: every secret is reissued).
 * The identity schemas (`identity.schemas`: inline `base64://`, local `file://`,
 * or the public `GET /schemas` of a running Kratos) say which traits are the
 * email, username, phone and name and which are custom.
 */

/** One config file: its parsed value, with the source line of any dotted path. */
export interface OryConfigFile {
  value: Obj;
  file: string;
  line(path: string): number | undefined;
}

export interface OryIdentitySchema {
  id: string;
  schema: Obj;
}

export interface OryConfigSnapshot {
  origin: string;
  /** Kratos configuration (kratos.yml / `services.identity.config`). */
  kratos?: OryConfigFile;
  /** Hydra configuration (hydra.yml / `services.oauth2.config`). */
  hydra?: OryConfigFile;
  schemas: OryIdentitySchema[];
  /** Hydra OAuth 2.0 clients (`GET /admin/clients`). */
  clients: Obj[];
  /** Kratos' public URL (the bridge and the lazy preset call it). */
  publicUrl?: string;
}

// ── reading ─────────────────────────────────────────────────────────────────

/** A config file's text: JSON when it starts with `{`, otherwise YAML. */
export function parseOryConfig(text: string, file: string): OryConfigFile {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const value = JSON.parse(trimmed) as unknown;
    if (!isObj(value)) throw new Error(`${file} is not a configuration object.`);
    return { value, file, line: () => undefined };
  }
  const doc = parseYaml(text);
  if (!isObj(doc.value)) throw new Error(`${file} is not a configuration (a YAML mapping was expected).`);
  return { value: doc.value, file, line: (path) => doc.line(path) };
}

/** An `ory get project --format json` document split into its Kratos and Hydra configs; null when it is not one. */
export function splitOryProject(file: OryConfigFile): { kratos: OryConfigFile; hydra?: OryConfigFile; slug?: string } | null {
  const services = file.value.services;
  if (!isObj(services) || !isObj(services.identity) || !isObj(services.identity.config)) return null;
  const wrap = (value: Obj, name: string): OryConfigFile => ({ value, file: `${file.file} (${name})`, line: () => undefined });
  return {
    kratos: wrap(services.identity.config, 'services.identity.config'),
    hydra: isObj(services.oauth2) && isObj(services.oauth2.config) ? wrap(services.oauth2.config, 'services.oauth2.config') : undefined,
    slug: str(file.value.slug),
  };
}

/** Identity schemas a Kratos config names that can be read without the network: `base64://` and `file://` (through `readFile`). */
export function resolveOrySchemas(kratos: OryConfigFile | undefined, readFile: (path: string) => string, warn: (m: string) => void = () => undefined): OryIdentitySchema[] {
  const identity = kratos?.value.identity;
  const out: OryIdentitySchema[] = [];
  for (const s of isObj(identity) ? objs(identity.schemas) : []) {
    const id = str(s.id);
    const url = str(s.url);
    if (!id || !url) continue;
    try {
      let text: string | undefined;
      if (url.startsWith('base64://')) text = Buffer.from(url.slice('base64://'.length), 'base64').toString('utf8');
      else if (url.startsWith('file://')) text = readFile(decodeURIComponent(url.slice('file://'.length)));
      if (text === undefined) {
        warn(`Identity schema "${id}" is at ${url}: pass its file, or give Kratos' public URL so it is read from /schemas.`);
        continue;
      }
      const schema = JSON.parse(text) as unknown;
      if (isObj(schema)) out.push({ id, schema });
    } catch (err) {
      warn(`Identity schema "${id}" could not be read (${(err as Error).message}).`);
    }
  }
  return out;
}

/** Kratos' public `GET /schemas`: `[{ id, schema }]`. */
export async function fetchOrySchemas(http: VendorHttp): Promise<OryIdentitySchema[]> {
  const { body } = await http.get<unknown>('/schemas');
  return (Array.isArray(body) ? body : []).flatMap((s: unknown) => (isObj(s) && str(s.id) && isObj(s.schema) ? [{ id: str(s.id)!, schema: s.schema }] : []));
}

/** Hydra's `GET /admin/clients`, following the Link header's page_token. */
export async function fetchOryClients(http: VendorHttp, pageSize = 250): Promise<Obj[]> {
  const out: Obj[] = [];
  const seen = new Set<string>();
  let path = `/admin/clients?page_size=${pageSize}`;
  for (;;) {
    const res = await http.get<unknown>(path);
    out.push(...objs(res.body));
    const next = nextLink(res.headers.get('link'));
    const token = next ? new URL(next, 'https://hydra.invalid').searchParams.get('page_token') : null;
    if (!token || seen.has(token)) break;
    seen.add(token);
    path = `/admin/clients?page_size=${pageSize}&page_token=${encodeURIComponent(token)}`;
  }
  return out;
}

// ── translation ─────────────────────────────────────────────────────────────

/** Go durations (`24h`, `720h`, `1h30m`) → ms. */
export function goDurationMs(v: unknown): number | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const text = v.trim();
  let total = 0;
  let matched = '';
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(h|m|s|ms)/g)) {
    matched += m[0];
    total += Number(m[1]) * { h: 3_600_000, m: 60_000, s: 1000, ms: 1 }[m[2] as 'h' | 'm' | 's' | 'ms'];
  }
  return matched === text && total > 0 ? total : undefined;
}

/** Traits Atlas has a column for. */
const KNOWN_TRAITS: Array<{ keys: string[]; atlas: string }> = [
  { keys: ['email', 'email_address', 'mail'], atlas: 'user email address' },
  { keys: ['username', 'user_name', 'login', 'handle'], atlas: 'user username' },
  { keys: ['phone', 'phone_number', 'mobile', 'tel'], atlas: 'user phone number' },
  { keys: ['name', 'full_name', 'first_name', 'last_name', 'given_name', 'family_name'], atlas: 'user first / last name' },
  { keys: ['picture', 'avatar', 'avatar_url', 'image'], atlas: 'user image' },
];

export function translateOryConfig(snap: OryConfigSnapshot): TranslationResult {
  const b = new ConfigBuilder();
  const k = snap.kratos;
  const h = snap.hydra;
  const at = (cfg: OryConfigFile | undefined, path: string): unknown => path.split('.').reduce<unknown>((v, key) => (isObj(v) ? v[key] : undefined), cfg?.value);
  const kv = (path: string) => at(k, path);
  const hv = (path: string) => at(h, path);
  const note = (cfg: OryConfigFile | undefined, status: 'mapped' | 'differs' | 'manual', area: string, path: string, text: string, atlas?: string) => {
    const line = cfg?.line(path);
    b.report.push({ status, area, setting: path, note: text, ...(atlas ? { atlas } : {}), ...(cfg && line ? { file: cfg.file, line } : {}) });
  };
  const add = (status: 'mapped' | 'differs' | 'manual', area: string, path: string, text: string, atlas?: string) => note(k, status, area, path, text, atlas);
  const bool = (path: string, fallback: boolean): boolean => (typeof kv(path) === 'boolean' ? (kv(path) as boolean) : fallback);
  const has = (path: string) => kv(path) !== undefined;

  // ── flows ──
  if (k) {
    const signUp = bool('selfservice.flows.registration.enabled', true);
    b.set('signUpMode', signUp ? 'public' : 'restricted');
    add('mapped', 'flows', 'selfservice.flows.registration.enabled', signUp ? 'Public sign-up.' : 'Sign-up closed (invitations and the allowlist still work).', 'auth_config.signUpMode');
    if (bool('selfservice.flows.verification.enabled', false)) {
      const use = str(kv('selfservice.flows.verification.use')) ?? 'code';
      add('mapped', 'flows', 'selfservice.flows.verification.enabled', `Email verification (${use === 'link' ? 'by link' : 'by code'}): Atlas verifies addresses with a code or link.`, 'auth_config.strategies.emailCode');
    }
    if (bool('selfservice.flows.recovery.enabled', false)) add('mapped', 'flows', 'selfservice.flows.recovery.enabled', 'Account recovery becomes Atlas password reset (a code or link by email).', 'auth_config.strategies.password');
    if (has('selfservice.flows.settings.privileged_session_max_age')) {
      add('differs', 'flows', 'selfservice.flows.settings.privileged_session_max_age', `Kratos asks for a fresh sign-in after ${String(kv('selfservice.flows.settings.privileged_session_max_age'))} before settings changes; Atlas re-verifies sensitive changes with its own window (auth_config.stepUp).`, 'auth_config.stepUp');
    }
    for (const flow of ['login', 'registration', 'settings', 'recovery', 'verification', 'error'] as const) {
      const ui = str(kv(`selfservice.flows.${flow}.ui_url`));
      if (ui) add('manual', 'flows', `selfservice.flows.${flow}.ui_url`, `Your ${flow} page (${ui}) is replaced by Atlas's hosted page or its components; update links to /sign-in and /sign-up.`);
    }
  }

  // ── hooks ──
  if (k) {
    const flows = isObj(kv('selfservice.flows')) ? (kv('selfservice.flows') as Obj) : {};
    for (const [flow, def] of Object.entries(flows)) {
      if (!isObj(def)) continue;
      for (const when of ['before', 'after'] as const) {
        const section = def[when];
        if (!isObj(section)) continue;
        // `after.hooks` (every method) and `after.<method>.hooks` (one of them).
        const groups: Array<[string, unknown]> = [[`${when}.hooks`, section.hooks]];
        for (const [method, v] of Object.entries(section)) if (isObj(v)) groups.push([`${when}.${method}.hooks`, v.hooks]);
        for (const [where, hooks] of groups) {
          for (const [n, hook] of objs(hooks).entries()) {
            const name = str(hook.hook);
            const path = `selfservice.flows.${flow}.${where}.${n}`;
            if (name === 'web_hook') add('manual', 'hooks', path, `A web hook (${str(isObj(hook.config) ? hook.config.url : undefined) ?? 'url'}) moves to an Atlas webhook endpoint or a before-sign-up action; its Jsonnet body is rebuilt as the event payload.`);
            else if (name === 'require_verified_address') {
              b.set('requireEmailVerification', true);
              add('mapped', 'hooks', path, 'Unverified addresses cannot sign in.', 'auth_config.requireEmailVerification');
            } else if (name === 'session') add('mapped', 'hooks', path, 'Atlas signs the user in after registration.');
            else if (name === 'revoke_active_sessions') add('differs', 'hooks', path, 'Atlas revokes sessions on password change and on the user\'s request; a blanket revoke after sign-in has no switch.');
            else if (name === 'verify' || name === 'show_verification_ui') add('mapped', 'hooks', path, 'Atlas starts address verification after sign-up when verification is required.');
            else if (name) add('manual', 'hooks', path, `The "${name}" hook has no Atlas counterpart.`);
          }
        }
      }
    }
  }

  // ── methods ──
  if (k) {
    const password = bool('selfservice.methods.password.enabled', true);
    b.set('strategies.password', password);
    add('mapped', 'methods', 'selfservice.methods.password.enabled', password ? 'Password sign-in on.' : 'Password sign-in off.', 'auth_config.strategies.password');
    if (password) {
      const min = typeof kv('selfservice.methods.password.config.min_password_length') === 'number' ? (kv('selfservice.methods.password.config.min_password_length') as number) : 8;
      b.set('passwordPolicy.minLength', Math.max(min, 6));
      add('mapped', 'methods', 'selfservice.methods.password.config.min_password_length', `Minimum ${min} characters.`, 'auth_config.passwordPolicy.minLength');
      const pwned = bool('selfservice.methods.password.config.haveibeenpwned_enabled', true);
      b.set('passwordPolicy.checkBreaches', pwned);
      add('mapped', 'methods', 'selfservice.methods.password.config.haveibeenpwned_enabled', pwned ? 'Breached passwords are refused.' : 'Breached-password check off.', 'auth_config.passwordPolicy.checkBreaches');
      if (has('selfservice.methods.password.config.max_breaches')) add('differs', 'methods', 'selfservice.methods.password.config.max_breaches', 'Atlas refuses any breached password; there is no breach-count threshold.');
      if (bool('selfservice.methods.password.config.identifier_similarity_check_enabled', true)) add('differs', 'methods', 'selfservice.methods.password.config.identifier_similarity_check_enabled', 'Atlas does not compare the password with the identifier.');
    }
    if (bool('selfservice.methods.code.enabled', false) || bool('selfservice.methods.code.passwordless_enabled', false) || bool('selfservice.methods.code.config.passwordless_enabled', false)) {
      b.set('strategies.emailCode', true);
      add('mapped', 'methods', 'selfservice.methods.code.enabled', 'One-time code sign-in (and the code second factor).', 'auth_config.strategies.emailCode');
    }
    if (bool('selfservice.methods.link.enabled', false)) {
      b.set('strategies.emailLink', true);
      add('mapped', 'methods', 'selfservice.methods.link.enabled', 'Magic-link sign-in.', 'auth_config.strategies.emailLink');
    }
    if (bool('selfservice.methods.totp.enabled', false)) {
      b.set('mfa.factors.totp', true);
      add('mapped', 'methods', 'selfservice.methods.totp.enabled', 'Authenticator apps as a second factor. Seeds move with a database export; an Admin API export has none, so users enrol again.', 'auth_config.mfa.factors.totp');
    }
    if (bool('selfservice.methods.lookup_secret.enabled', false)) add('mapped', 'methods', 'selfservice.methods.lookup_secret.enabled', 'Backup codes accompany an authenticator in Atlas (unused codes move with a database export).', 'auth_config.mfa.backupCodes');
    const webauthn = bool('selfservice.methods.webauthn.enabled', false);
    const passkey = bool('selfservice.methods.passkey.enabled', false);
    if (webauthn) {
      const passwordless = bool('selfservice.methods.webauthn.config.passwordless', false);
      b.set(passwordless ? 'strategies.passkey' : 'mfa.factors.passkey', true);
      add('mapped', 'methods', 'selfservice.methods.webauthn.enabled', passwordless ? 'Passwordless WebAuthn becomes passkey sign-in.' : 'Security keys as a second factor.', passwordless ? 'auth_config.strategies.passkey' : 'auth_config.mfa.factors.passkey');
    }
    if (passkey) {
      b.set('strategies.passkey', true);
      add('mapped', 'methods', 'selfservice.methods.passkey.enabled', 'Passkey sign-in on.', 'auth_config.strategies.passkey');
    }
    if (webauthn || passkey) {
      const rp = webauthn && has('selfservice.methods.webauthn.config.rp.id') ? 'selfservice.methods.webauthn.config.rp.id' : 'selfservice.methods.passkey.config.rp.id';
      const rpId = str(kv(rp));
      if (rpId) add('differs', 'methods', rp, `Passkeys were registered for "${rpId}": they keep working only when Atlas serves sign-in on that domain (export with --set ory-rp-id=${rpId}).`);
    }

    // ── social and enterprise sign-in ──
    const providers = objs(kv('selfservice.methods.oidc.config.providers'));
    if (bool('selfservice.methods.oidc.enabled', false) || providers.length) {
      for (const [n, p] of providers.entries()) {
        const path = `selfservice.methods.oidc.config.providers.${n}`;
        const id = str(p.id);
        const kind = (str(p.provider) ?? 'generic').toLowerCase();
        if (!id) continue;
        const atlasKey = kind === 'github-app' ? 'github' : socialKey(kind);
        const clientId = str(p.client_id);
        if (atlasKey) {
          b.socialProvider({ atlasKey, vendorName: id, area: 'sign-in with', setting: path, clientId, scopes: strs(p.scope).length ? strs(p.scope) : undefined });
          const last = b.report[b.report.length - 1]!;
          const line = k.line(path);
          if (line) Object.assign(last, { file: k.file, line });
          if (id !== atlasKey) last.note += ` Imported identities keep the Kratos provider id "${id}": map it with provider_map ${id}=${atlasKey}.`;
        } else {
          const providerKey = keyOf(id).replace(/:/g, '_').slice(0, 48) || 'oidc';
          const upper = providerKey.toUpperCase();
          const issuer = str(p.issuer_url);
          const doc: Record<string, Json> = {
            provider_key: providerKey,
            display_name: str(p.label) ?? id,
            protocol: 'oidc',
            client_id: clientId ?? b.placeholder(`${upper}_CLIENT_ID`, `${id} client id`),
            client_secret: b.placeholder(`${upper}_CLIENT_SECRET`, `${id} client secret`),
            enabled: true,
            allow_sign_in: true,
            allow_sign_up: true,
          };
          if (issuer) {
            doc.issuer = issuer;
            doc.discovery_url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
          }
          if (strs(p.scope).length) doc.scopes = strs(p.scope);
          b.push('custom_oauth_providers', doc);
          b.providers[id] = providerKey;
          note(k, 'differs', 'sign-in with', path, `"${id}" (${kind}) becomes the custom OIDC provider "${providerKey}"${issuer ? ` (issuer ${issuer})` : ''}. Add Atlas's redirect URI at the provider and set ${upper}_CLIENT_SECRET. Imported identities keep provider "${id}": map it with provider_map ${id}=${providerKey}.`, `custom_oauth_providers ${providerKey}`);
        }
        if (str(p.mapper_url)) note(k, 'manual', 'sign-in with', `${path}.mapper_url`, `The Jsonnet claims mapper (${str(p.mapper_url)}) has no direct counterpart: Atlas copies name, email and picture from the provider; rebuild any trait mapping as a claim mapping or user metadata.`);
        if (str(p.requested_claims) || isObj(p.requested_claims)) note(k, 'manual', 'sign-in with', `${path}.requested_claims`, 'Requested OIDC claims are not translated: set the scopes on the Atlas provider.');
      }
    }
  }

  // ── sessions ──
  if (k) {
    const lifespan = goDurationMs(kv('session.lifespan')) ?? 24 * 3_600_000;
    b.set('session.absoluteMs', clampSessionMs(lifespan));
    add(clampSessionMs(lifespan) === lifespan ? 'mapped' : 'differs', 'sessions', 'session.lifespan', `Session lifespan ${String(kv('session.lifespan') ?? '24h')} becomes the absolute session lifetime.`, 'auth_config.session.absoluteMs');
    if (has('session.earliest_possible_extend')) add('differs', 'sessions', 'session.earliest_possible_extend', 'Atlas sessions refresh on use; there is no extension window.');
    if (kv('session.cookie.persistent') === false) add('differs', 'sessions', 'session.cookie.persistent', 'Kratos used a browser-session cookie; Atlas sessions are persistent up to their lifetime.');
    for (const p of ['session.cookie.domain', 'session.cookie.name', 'session.cookie.same_site', 'session.cookie.path']) {
      if (has(p)) add('differs', 'sessions', p, 'Atlas names and scopes its own session cookie (cross-subdomain on custom domains); the old cookie is cleared by the session bridge.');
    }
    const aal = str(kv('session.whoami.required_aal'));
    if (aal === 'aal2') {
      b.set('mfaPolicy', 'required');
      add('mapped', 'sessions', 'session.whoami.required_aal', 'Every session needs a second factor.', 'auth_config.mfaPolicy');
    } else if (aal === 'highest_available' || aal === undefined) {
      if (aal) add('mapped', 'sessions', 'session.whoami.required_aal', 'A second factor is required exactly when the user has enrolled one: the Atlas default.', 'auth_config.mfaPolicy');
    }
  }

  // ── URLs and origins ──
  if (k) {
    const urls = [str(kv('selfservice.default_browser_return_url')), ...strs(kv('selfservice.allowed_return_urls'))].filter((u): u is string => !!u);
    let exact = 0;
    for (const url of new Set(urls)) {
      if (url.includes('*')) {
        add('differs', 'URLs', 'selfservice.allowed_return_urls', `${url}: Atlas redirect URLs are exact (no wildcards); list each URL.`, 'redirect_urls');
        continue;
      }
      b.push('redirect_urls', { url });
      exact++;
    }
    if (exact) add('mapped', 'URLs', has('selfservice.allowed_return_urls') ? 'selfservice.allowed_return_urls' : 'selfservice.default_browser_return_url', `${exact} return URL(s) become redirect URLs.`, 'redirect_urls');
    const origins = strs(kv('serve.public.cors.allowed_origins')).filter((o) => !o.includes('*'));
    if (origins.length) {
      b.instance.allowed_origins = origins;
      add('mapped', 'URLs', 'serve.public.cors.allowed_origins', 'Allowed origins for the browser SDK.', 'instance.allowed_origins');
    }
    if (strs(kv('serve.public.cors.allowed_origins')).some((o) => o.includes('*'))) add('differs', 'URLs', 'serve.public.cors.allowed_origins', 'Wildcard origins are not allowed in Atlas: list each origin.');
  }

  // ── email, SMS, hashing, schemas ──
  if (k) {
    if (has('courier.smtp.connection_uri')) add('manual', 'email', 'courier.smtp.connection_uri', 'Configure your SMTP server (or email provider) in Atlas; the connection URI carries credentials and is not copied.');
    for (const p of ['courier.smtp.from_address', 'courier.smtp.from_name']) if (has(p)) add('manual', 'email', p, `Set the sender (${String(kv(p))}) on the Atlas email provider.`);
    if (has('courier.templates')) add('manual', 'email', 'courier.templates', 'Recreate your courier templates in Atlas (Kratos uses Go templates; Atlas has its own template variables).');
    if (objs(kv('courier.channels')).some((c) => str(c.id) === 'sms')) add('manual', 'phone', 'courier.channels', 'The SMS channel (HTTP request config) is replaced by an Atlas SMS provider: connect Twilio or another one (credentials are not copied).');
    if (str(kv('hashers.algorithm'))) add('mapped', 'passwords', 'hashers.algorithm', `Passwords hashed with ${String(kv('hashers.algorithm'))} import in that algorithm and are re-hashed to Argon2id on each user's first sign-in.`);
    if (str(kv('oauth2_provider.url'))) add('differs', 'OAuth', 'oauth2_provider.url', 'Kratos delegated login to Hydra. Atlas is its own OAuth 2.0 / OIDC provider: your login and consent apps are no longer needed.');
    if (bool('security.account_enumeration.mitigate', false)) add('differs', 'security', 'security.account_enumeration.mitigate', 'Atlas gives uniform responses on sign-in and reset by default.');
    const schemaPaths = Array.isArray(kv('identity.schemas')) ? (kv('identity.schemas') as unknown[]) : [];
    if (schemaPaths.length && !snap.schemas.length) add('manual', 'identity schema', 'identity.schemas', 'The identity schemas could not be read: pass them with --set ory-schema=<file>, or give the public URL of Kratos.');
  }

  for (const { id, schema } of snap.schemas) schemaReport(b, id, schema);

  // ── Hydra ──
  if (h) {
    const hnote = (status: 'mapped' | 'differs' | 'manual', path: string, text: string, atlas?: string) => note(h, status, 'OAuth 2.0 server', path, text, atlas);
    if (str(hv('urls.self.issuer'))) hnote('differs', 'urls.self.issuer', `Tokens were issued by ${String(hv('urls.self.issuer'))}. Atlas issues under its own issuer: add Hydra's issuer as a legacy issuer so existing tokens stay valid during the move, and point resource servers at Atlas's JWKS.`, 'auth_config.legacyIssuers');
    for (const p of ['urls.login', 'urls.consent', 'urls.logout']) if (hv(p) !== undefined) hnote('manual', p, 'Atlas hosts login, consent and logout itself: this app is no longer needed.');
    for (const [p, what] of [['ttl.access_token', 'access token'], ['ttl.refresh_token', 'refresh token'], ['ttl.id_token', 'ID token'], ['ttl.auth_code', 'authorization code']] as const) {
      if (hv(p) !== undefined) hnote('differs', p, `${what} lifetime ${String(hv(p))}: set the lifetimes on each Atlas OAuth client or resource server.`);
    }
    if (str(hv('strategies.access_token')) === 'jwt') hnote('mapped', 'strategies.access_token', 'JWT access tokens: Atlas access tokens are JWTs verified with the instance JWKS.');
    else if (hv('strategies.access_token') !== undefined) hnote('differs', 'strategies.access_token', 'Opaque access tokens: Atlas access tokens are JWTs; resource servers verify them with the instance JWKS instead of introspecting.');
    if (strs(hv('oidc.subject_identifiers.supported_types')).includes('pairwise')) hnote('manual', 'oidc.subject_identifiers.supported_types', 'Pairwise subject identifiers are not supported: Atlas issues public subjects (the user id), so clients that stored pairwise subjects must re-link.');
    if (hv('oidc.dynamic_client_registration.enabled') === true) hnote('manual', 'oidc.dynamic_client_registration.enabled', 'Open dynamic client registration is not enabled in Atlas: register clients through the dashboard or API.');
    if (hv('oauth2.pkce.enforced') === true) hnote('mapped', 'oauth2.pkce.enforced', 'Atlas requires PKCE for public clients.');
  }

  // ── Hydra clients ──
  let secrets = 0;
  for (const c of snap.clients) {
    const id = str(c.client_id);
    if (!id) continue;
    const name = str(c.client_name) ?? id;
    const grants = strs(c.grant_types);
    const redirects = strs(c.redirect_uris);
    const method = str(c.token_endpoint_auth_method) ?? 'client_secret_basic';
    const doc: Record<string, Json> = { name };
    if (redirects.length) doc.redirect_uris = redirects;
    const scopes = typeof c.scope === 'string' ? c.scope.split(/\s+/).filter(Boolean) : strs(c.scope);
    if (scopes.length) doc.allowed_scopes = scopes;
    if (grants.length) doc.grant_types = grants;
    doc.token_endpoint_auth_method = method;
    if (str(c.logo_uri)) doc.logo_url = str(c.logo_uri)!;
    if (c.skip_consent === true) doc.first_party = true;
    b.push('oauth_clients', doc);
    const where = `clients ${id}`;
    b.add('mapped', 'OAuth clients', where, `"${name}" becomes an Atlas OAuth client (${grants.join(', ') || 'no grant types'}; ${redirects.length} redirect URI(s)${c.skip_consent === true ? '; consent skipped = first party' : ''}).`, 'oauth_clients');
    if (method !== 'none') secrets++;
    if (method === 'private_key_jwt') b.add('manual', 'OAuth clients', `${where} token_endpoint_auth_method`, 'private_key_jwt: register the client\'s public key (jwks / jwks_uri) on the Atlas client again.');
    if (str(c.subject_type) === 'pairwise') b.add('manual', 'OAuth clients', `${where} subject_type`, 'Pairwise subjects are not supported: this client receives the user id as sub.');
    if (strs(c.audience).length) b.add('manual', 'OAuth clients', `${where} audience`, `Audience ${strs(c.audience).join(', ')}: register each as an API (resource server) in Atlas and grant this client access.`, 'resource_servers');
    if (str(c.backchannel_logout_uri) || str(c.frontchannel_logout_uri)) b.add('manual', 'OAuth clients', `${where} logout uris`, 'Front- and back-channel logout URIs are set on the Atlas client after import.');
  }
  if (secrets) b.add('manual', 'OAuth clients', 'client_secret', `${secrets} client(s) authenticate with a secret. Hydra keeps only hashes, so Atlas issues new secrets: give each client its new secret.`);

  const publicUrl = snap.publicUrl ?? str(kv('serve.public.base_url'));
  const slug = publicUrl ? /^https:\/\/([a-z0-9-]+)\.projects\.oryapis\.com/i.exec(publicUrl)?.[1] : undefined;
  const cookie = str(kv('session.cookie.name')) ?? (slug ? `ory_session_${slug}` : 'ory_kratos_session');
  const vars: Record<string, string> = { cookie_name: cookie };
  if (publicUrl) vars.base_url = publicUrl.replace(/\/+$/, '');
  return b.result(snap.origin, {
    bridge: { preset: 'ory_whoami', vars },
    ...(publicUrl ? { lazy: { preset: 'ory', config: { base_url: publicUrl.replace(/\/+$/, '') } } } : {}),
  });
}

/** One identity schema's traits → report lines (what Atlas stores where, what stays in metadata). */
function schemaReport(b: ConfigBuilder, id: string, schema: Obj): void {
  const traits = isObj(schema.properties) && isObj(schema.properties.traits) ? schema.properties.traits : undefined;
  const props = traits && isObj(traits.properties) ? traits.properties : {};
  const required = new Set(traits ? strs(traits.required) : []);
  for (const [name, def] of Object.entries(props)) {
    if (!isObj(def)) continue;
    const ory = isObj(def['ory.sh/kratos']) ? def['ory.sh/kratos'] : {};
    const creds = isObj(ory.credentials) ? ory.credentials : {};
    const identifierFor = Object.entries(creds).filter(([, v]) => isObj(v) && v.identifier === true).map(([c]) => c);
    const known = KNOWN_TRAITS.find((t) => t.keys.includes(name.toLowerCase()));
    const where = `identity schema ${id} traits.${name}`;
    const via = isObj(ory.verification) ? str(ory.verification.via) : undefined;
    if (known) {
      b.add('mapped', 'identity schema', where, `Becomes the ${known.atlas}${identifierFor.length ? ` and signs in via ${identifierFor.join(', ')}` : ''}${via ? `; verified by ${via}` : ''}.`);
    } else if (isObj(def.properties) && ['first', 'last'].some((n) => n in (def.properties as Obj))) {
      b.add('mapped', 'identity schema', where, 'Its first / last fields become the user\'s first and last name.');
    } else {
      b.add('differs', 'identity schema', where, `A custom trait${required.has(name) ? ' (required at sign-up)' : ''}: it is kept on the user as unsafe_metadata.ory_traits.${name}; add it as an Atlas sign-up field to keep collecting it.`);
    }
  }
}

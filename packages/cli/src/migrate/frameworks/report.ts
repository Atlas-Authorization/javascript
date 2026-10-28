import type { Json } from '../../serialize';
import type { ReportStatus, TranslationReportEntry, TranslationResult } from '../framework/plugin';

/**
 * The builder every self-hosted-framework translator (Auth.js, Lucia,
 * Passport, iron-session, Devise, Django) fills: Atlas config-as-code
 * (`instance.auth_config`, `oauth_providers`, `custom_oauth_providers`,
 * `redirect_urls`) plus the mapped / differs / manual report with the file and
 * line each setting came from. Secrets are never copied: a value read from an
 * environment variable becomes a `${NAME}` placeholder, and a secret
 * hard-coded in source becomes a placeholder plus a manual entry.
 */

export const DAY = 86_400;
/** Atlas session bounds (seconds). */
export const MIN_IDLE_S = 300;
export const MAX_ABSOLUTE_S = 90 * DAY;

export interface Where {
  file: string;
  line: number;
}

/** A configuration value as a translator read it: literal, env var, or something only a human can read. */
export type ConfigValue =
  | { kind: 'literal'; value: string | number | boolean; at: Where }
  | { kind: 'env'; name: string; at: Where }
  | { kind: 'opaque'; text: string; at: Where };

export class TranslationBuilder {
  readonly authConfig: Record<string, Json> = {};
  readonly oauthProviders: Json[] = [];
  readonly customOauthProviders: Json[] = [];
  readonly redirectUrls: Json[] = [];
  readonly allowedOrigins = new Set<string>();
  readonly report: TranslationReportEntry[] = [];
  readonly env = new Map<string, string>();
  readonly providers: Record<string, string> = {};
  readonly roles: Record<string, string> = {};
  bridge?: { preset: string; vars: Record<string, string> };
  lazy?: { preset: string; config: Record<string, string> };

  constructor(readonly origin: string, readonly fallback: Where) {}

  set(path: string, value: Json): void {
    const parts = path.split('.');
    let node: Record<string, Json> = this.authConfig;
    for (const part of parts.slice(0, -1)) {
      const next = node[part];
      if (!next || typeof next !== 'object' || Array.isArray(next)) node[part] = {};
      node = node[part] as Record<string, Json>;
    }
    node[parts[parts.length - 1]!] = value;
  }

  get(path: string): Json | undefined {
    let node: Json | undefined = this.authConfig;
    for (const part of path.split('.')) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
      node = (node as Record<string, Json>)[part];
    }
    return node;
  }

  add(status: ReportStatus, area: string, setting: string, note: string, at?: Where, atlas?: string): void {
    const where = at ?? this.fallback;
    this.report.push({ status, area, setting, ...(atlas ? { atlas } : {}), note, file: where.file, line: where.line });
  }

  /** A config string: a literal stays, an env var becomes `${NAME}`, anything else a `${fallback}` placeholder + manual entry. */
  configString(v: ConfigValue | undefined, purpose: string, fallback: string, opts: { secret?: boolean; area: string; setting: string }): string {
    if (v?.kind === 'literal') {
      if (opts.secret) {
        this.add('manual', opts.area, opts.setting, `A secret is hard-coded in source. It was not copied: set ${fallback} in the environment before applying, and move the secret out of the code.`, v.at);
        this.env.set(fallback, purpose);
        return `\${${fallback}}`;
      }
      return String(v.value);
    }
    if (v?.kind === 'env') {
      this.env.set(v.name, purpose);
      return `\${${v.name}}`;
    }
    if (v) this.add('manual', opts.area, opts.setting, `Cannot read this value statically (${v.text}); set ${fallback} in the environment before applying.`, v.at);
    this.env.set(fallback, purpose);
    return `\${${fallback}}`;
  }

  /**
   * An enabled social provider (`oauth_providers`). Keeps the same OAuth app so
   * imported identities relink by provider user id.
   */
  oauthProvider(input: {
    sourceId: string;
    atlasKey: string;
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
    values?: Record<string, Json>;
    area: string;
    setting: string;
    at?: Where;
  }): void {
    this.providers[input.sourceId] = input.atlasKey;
    const entry: Record<string, Json> = { provider: input.atlasKey, enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: input.clientId };
    if (input.clientSecret !== undefined) entry.client_secret = input.clientSecret;
    if (input.scopes?.length) entry.scopes = input.scopes;
    if (input.values && Object.keys(input.values).length) entry.values = input.values;
    if (!this.oauthProviders.some((p) => (p as { provider?: string }).provider === input.atlasKey)) this.oauthProviders.push(entry);
    const list = (this.get('strategies.oauthProviders') as string[] | undefined) ?? [];
    if (!list.includes(input.atlasKey)) this.set('strategies.oauthProviders', [...list, input.atlasKey]);
    this.add(
      'mapped',
      input.area,
      input.setting,
      "Keep the same OAuth app so imported accounts relink by provider user id. Add Atlas's callback URL (redirect_uri on the provider) to the app's allowed redirect URLs.",
      input.at,
      `oauth_providers ${input.atlasKey}`,
    );
  }

  /** Session lifetime: `idle` true = activity extends it (rolling), false = fixed. */
  session(seconds: number, rolling: boolean, area: string, setting: string, at: Where | undefined, sourceWords: string): void {
    const s = clamp(seconds, MIN_IDLE_S, MAX_ABSOLUTE_S);
    if (rolling) {
      this.set('session.idleMs', s * 1000);
      this.set('session.idleTimeout', true);
      this.set('session.absoluteMs', MAX_ABSOLUTE_S * 1000);
    } else {
      this.set('session.absoluteMs', s * 1000);
      this.set('session.idleMs', s * 1000);
      this.set('session.idleTimeout', false);
    }
    const exact = s === seconds;
    this.add(
      exact ? 'mapped' : 'differs',
      area,
      setting,
      `${rolling ? 'Sessions stay alive while used and end after' : 'Sessions last a fixed'} ${humanDuration(s)}${rolling ? ' idle' : ''}${exact ? '' : ` (${sourceWords}: ${humanDuration(seconds)}; Atlas allows 5 minutes to 90 days)`}.`,
      at,
      rolling ? 'auth_config.session.idleMs' : 'auth_config.session.absoluteMs',
    );
  }

  /** Minimum password length (Atlas requires at least 8). */
  minPasswordLength(n: number, area: string, setting: string, at: Where | undefined, sourceWords: string): void {
    const v = Math.max(8, Math.min(n, 128));
    this.set('passwordPolicy.minLength', v);
    this.add(
      v === n ? 'mapped' : 'differs',
      area,
      setting,
      v === n ? `${n}.` : n < 8 ? `${sourceWords} allows ${n}; Atlas requires at least 8. Existing shorter passwords still sign in; new ones need 8.` : `Set to ${v} (${sourceWords}: ${n}).`,
      at,
      'auth_config.passwordPolicy.minLength',
    );
  }

  result(): TranslationResult {
    const documents: Record<string, Json> = {
      instance: { ...(this.allowedOrigins.size ? { allowed_origins: [...this.allowedOrigins] } : {}), auth_config: this.authConfig },
    };
    if (this.oauthProviders.length) documents.oauth_providers = this.oauthProviders;
    if (this.customOauthProviders.length) documents.custom_oauth_providers = this.customOauthProviders;
    if (this.redirectUrls.length) documents.redirect_urls = this.redirectUrls;
    return {
      origin: this.origin,
      documents,
      report: this.report,
      env: [...this.env.entries()].map(([name, purpose]) => ({ name, for: purpose })).sort((a, b) => (a.name < b.name ? -1 : 1)),
      mappings: { providers: this.providers, roles: this.roles },
      ...(this.bridge ? { bridge: this.bridge } : {}),
      ...(this.lazy ? { lazy: this.lazy } : {}),
    };
  }
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function humanDuration(seconds: number): string {
  if (seconds % DAY === 0) return `${seconds / DAY} day${seconds === DAY ? '' : 's'}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/**
 * Social provider names the frameworks use → Atlas catalog provider keys
 * (Auth.js provider ids, arctic class names lowercased, Passport strategy
 * names, OmniAuth strategies, django-allauth provider ids).
 */
export const FRAMEWORK_PROVIDER_MAP: Record<string, string> = {
  google: 'google',
  google_oauth2: 'google',
  'google-oauth20': 'google',
  github: 'github',
  gitlab: 'gitlab',
  facebook: 'facebook',
  apple: 'apple',
  twitter: 'x',
  twitter2: 'x',
  twitter_oauth2: 'x',
  x: 'x',
  discord: 'discord',
  slack: 'slack',
  slack_openid: 'slack',
  linkedin: 'linkedin',
  linkedin_oauth2: 'linkedin',
  linkedin_openid: 'linkedin',
  'linkedin-openidconnect': 'linkedin',
  microsoft: 'microsoft',
  'azure-ad': 'microsoft',
  'microsoft-entra-id': 'microsoft',
  microsoftentraid: 'microsoft',
  microsoft_graph: 'microsoft',
  azure_activedirectory_v2: 'microsoft',
  'azuread-openidconnect': 'microsoft',
  twitch: 'twitch',
  spotify: 'spotify',
  reddit: 'reddit',
  zoom: 'zoom',
  notion: 'notion',
  dropbox: 'dropbox',
  atlassian: 'atlassian',
  salesforce: 'salesforce',
  bitbucket: 'bitbucket',
  bitbucket_oauth2: 'bitbucket',
  amazon: 'amazon',
  kakao: 'kakao',
  naver: 'naver',
  line: 'line',
  vk: 'vk',
  shopify: 'shopify',
  okta: 'okta',
  auth0: 'auth0',
  cognito: 'cognito',
};

import type { ConfigDocuments, ReportStatus, TranslationReportEntry, TranslationResult } from '../framework/plugin';
import type { Json } from '../../serialize';

/**
 * Shared machinery for the vendor CONFIG translators (`atlas migrate <vendor>
 * config`): build the Atlas config-as-code documents (`instance` with its
 * `auth_config`, `oauth_providers`, `roles`, `permissions`, …) and the report
 * line by line, every line naming the vendor setting it came from.
 *
 * Secrets are never copied: a vendor client secret becomes a `${NAME}`
 * placeholder the operator sets before `atlas config import`.
 */
export class ConfigBuilder {
  readonly auth: Record<string, Json> = {};
  readonly instance: Record<string, Json> = {};
  readonly collections: Record<string, Json[]> = {
    oauth_providers: [],
    custom_oauth_providers: [],
    permissions: [],
    roles: [],
    oauth_clients: [],
    resource_servers: [],
    redirect_urls: [],
    jwt_templates: [],
  };
  readonly report: TranslationReportEntry[] = [];
  private readonly env = new Map<string, string>();
  readonly providers: Record<string, string> = {};
  readonly roles: Record<string, string> = {};

  /** Set `auth_config.<path>` (dotted). */
  set(path: string, value: Json): void {
    const keys = path.split('.');
    let node = this.auth;
    for (const k of keys.slice(0, -1)) {
      const next = node[k];
      if (!next || typeof next !== 'object' || Array.isArray(next)) node[k] = {};
      node = node[k] as Record<string, Json>;
    }
    node[keys[keys.length - 1]!] = value;
  }

  add(status: ReportStatus, area: string, setting: string, note: string, atlas?: string): void {
    this.report.push({ status, area, setting, note, ...(atlas ? { atlas } : {}) });
  }

  /** A `${NAME}` placeholder the import interpolates from the environment. */
  placeholder(name: string, purpose: string): string {
    this.env.set(name, purpose);
    return `\${${name}}`;
  }

  push(collection: keyof ConfigBuilder['collections'] | string, value: Json): void {
    (this.collections[collection] ??= []).push(value);
  }

  /** An `oauth_providers` entry for a built-in Atlas provider, credentials as placeholders. */
  socialProvider(o: {
    atlasKey: string;
    vendorName: string;
    area: string;
    setting: string;
    clientId?: string;
    scopes?: string[];
    enabled?: boolean;
    allowSignUp?: boolean;
  }): void {
    const upper = o.atlasKey.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    if (this.collections.oauth_providers!.some((p) => (p as { provider?: string }).provider === o.atlasKey)) return;
    const entry: Record<string, Json> = {
      provider: o.atlasKey,
      enabled: o.enabled !== false,
      allow_sign_in: true,
      allow_sign_up: o.allowSignUp !== false,
      client_id: o.clientId ?? this.placeholder(`${upper}_CLIENT_ID`, `${o.vendorName} client id`),
      client_secret: this.placeholder(`${upper}_CLIENT_SECRET`, `${o.vendorName} client secret`),
    };
    if (o.scopes?.length) entry.scopes = o.scopes;
    this.push('oauth_providers', entry);
    this.providers[o.vendorName] = o.atlasKey;
    this.add(
      o.clientId ? 'differs' : 'manual',
      o.area,
      o.setting,
      `${o.vendorName} sign-in becomes Atlas's built-in "${o.atlasKey}" provider. Keep the same OAuth app so imported accounts relink by provider user id; add Atlas's callback URL to it${o.clientId ? '' : ', and set the client id'} and set ${upper}_CLIENT_SECRET (secrets are never copied).`,
      `oauth_providers ${o.atlasKey}`,
    );
  }

  result(origin: string, extra: Pick<TranslationResult, 'bridge' | 'lazy'> = {}): TranslationResult {
    const documents: ConfigDocuments = {};
    const instance: Record<string, Json> = { ...this.instance };
    if (Object.keys(this.auth).length) instance.auth_config = this.auth;
    if (Object.keys(instance).length) documents.instance = instance;
    for (const [type, list] of Object.entries(this.collections)) if (list.length) documents[type] = list;
    return {
      origin,
      documents,
      report: this.report,
      env: [...this.env.entries()].map(([name, purpose]) => ({ name, for: purpose })),
      mappings: { providers: this.providers, roles: this.roles },
      ...extra,
    };
  }
}

/** Social provider names vendors use → Atlas built-in provider keys. */
export const SOCIAL_KEYS: Record<string, string> = {
  google: 'google',
  'google-oauth2': 'google',
  github: 'github',
  gitlab: 'gitlab',
  facebook: 'facebook',
  apple: 'apple',
  microsoft: 'microsoft',
  windowslive: 'microsoft',
  'microsoft-account': 'microsoft',
  azure_ad: 'microsoft',
  linkedin: 'linkedin',
  linkedin_oidc: 'linkedin',
  twitter: 'x',
  x: 'x',
  discord: 'discord',
  slack: 'slack',
  spotify: 'spotify',
  twitch: 'twitch',
  bitbucket: 'bitbucket',
  dropbox: 'dropbox',
  notion: 'notion',
  salesforce: 'salesforce',
  paypal: 'paypal',
  amazon: 'amazon',
  tiktok: 'tiktok',
  line: 'line',
  zoom: 'zoom',
  figma: 'figma',
  hubspot: 'hubspot',
  atlassian: 'atlassian',
  coinbase: 'coinbase',
  box: 'box',
  yahoo: 'yahoo',
  roblox: 'roblox',
  reddit: 'reddit',
};

/** The Atlas key for a vendor's provider name (`oauth_google`, `oauth2:google`, `GOOGLE`, `google-oauth2`), or null. */
export function socialKey(raw: string): string | null {
  const k = raw.toLowerCase().replace(/^oauth2?[_:]/, '').replace(/^oauth_/, '');
  return SOCIAL_KEYS[k] ?? null;
}

/** `Billing Admin` → `billing_admin`. */
export function keyOf(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9:]+/g, '_').replace(/^_+|_+$/g, '') || 'role';
}

const MIN = 60_000;
/** Atlas's session window: 5 minutes to 90 days. */
export function clampSessionMs(ms: number): number {
  return Math.min(Math.max(ms, 5 * MIN), 90 * 24 * 60 * MIN);
}

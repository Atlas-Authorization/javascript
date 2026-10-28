import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AtlasApiError, DEFAULT_API_URL } from '@atlasauth/backend';
import { list, str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import {
  httpFor,
  parseInstanceEnv,
  readManifest,
  writeManifest,
  type InstanceEnv,
  type ProjectInstance,
  type ProjectManifest,
} from '../project';
import { assertProductName, productDir, readEnvFile, writeSecretFile } from '../secrets';
import { envApiUrl, wantsJson } from './shared';

/**
 * `atlas init` — set up an Atlas app for a product in one idempotent command.
 *
 * It drives the platform API (a `psk_` platform key) to find or create the app
 * + instance, then the instance's own Backend API to set sign-in strategies,
 * the email sender, the custom domain, a first-party OAuth client and a
 * webhook endpoint. Re-running finds each thing by name / host / URL and only
 * fills what is missing.
 *
 * Every secret it receives goes straight into a 0600 file under
 * `~/.config/<product>/` (directory 0700); stdout carries only public values
 * and file paths. Before anything that would hand back a NEW secret is
 * created, the target file is checked: an existing, different file is refused
 * unless `--force`, so a secret is never minted only to be thrown away.
 */

const STRATEGY_ALIASES: Record<string, string> = {
  password: 'password',
  email_code: 'emailCode',
  email_link: 'emailLink',
  passkey: 'passkey',
  phone_code: 'phoneCode',
  username: 'username',
  siwe: 'siwe',
};
/** Strategies that need email delivery: turned on only once the instance can send. */
const EMAIL_STRATEGIES = new Set(['emailCode', 'emailLink']);

type EmailMode = 'managed' | 'development' | 'none';
const EMAIL_PROVIDERS = ['resend', 'brevo'] as const;
type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

interface InitOptions {
  product: string;
  appName: string;
  environment: InstanceEnv;
  domain?: string;
  authHost?: string;
  strategies: string[];
  email: EmailMode;
  emailFrom?: string;
  emailProvider?: EmailProvider;
  emailKeyFile?: string;
  redirects: string[];
  webhookUrl?: string;
  /** ATL-D14 the app route that receives back-channel logouts (set on the OAuth client). */
  backchannelUrl?: string;
  force: boolean;
  rotateSecret: boolean;
}

function camel(s: string): string {
  return s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

function parseOptions(args: ParsedArgs): InitOptions {
  const v = args.values;
  const product = str(v, 'product');
  if (!product) throw new CliError('atlas init requires --product <name>.');
  assertProductName(product);
  const environment = parseInstanceEnv(str(v, 'instance-env'), 'production');
  const domain = str(v, 'domain')?.trim().toLowerCase().replace(/\.$/, '');
  if (domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new CliError(`--domain must be a domain name like example.com, got '${domain}'.`);
  }
  const emailRaw = str(v, 'email') ?? (domain ? 'managed' : 'none');
  if (emailRaw !== 'managed' && emailRaw !== 'development' && emailRaw !== 'none') {
    throw new CliError(`--email must be managed, development or none, got '${emailRaw}'.`);
  }
  if (emailRaw === 'managed' && !domain && !str(v, 'email-from')) {
    throw new CliError('--email managed needs --domain (or --email-from <address on your domain>).');
  }
  if (emailRaw === 'development' && environment !== 'development') {
    throw new CliError('--email development is only for --instance-env development. Use --email managed on production.');
  }
  const providerRaw = str(v, 'email-provider');
  if (providerRaw !== undefined && !EMAIL_PROVIDERS.includes(providerRaw as EmailProvider)) {
    throw new CliError(
      `--email-provider must be ${EMAIL_PROVIDERS.join(' or ')}, got '${providerRaw}'. Configure other providers with PUT /v1/messaging_providers/email.`,
    );
  }
  const emailKeyFile = str(v, 'email-key-file');
  if (emailKeyFile !== undefined && !providerRaw) throw new CliError('--email-key-file needs --email-provider resend|brevo.');
  const strategies = list(v, 'strategies').map((s) => STRATEGY_ALIASES[s] ?? camel(s));
  const redirects = list(v, 'client-redirect');
  for (const r of redirects) {
    try {
      new URL(r);
    } catch {
      throw new CliError(`--client-redirect must be an absolute URL, got '${r}'.`);
    }
  }
  const backchannelUrl = str(v, 'backchannel');
  if (backchannelUrl !== undefined) {
    let u: URL;
    try {
      u = new URL(backchannelUrl);
    } catch {
      throw new CliError(`--backchannel must be an absolute URL, got '${backchannelUrl}'.`);
    }
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
      throw new CliError('--backchannel must be an https URL (http only on localhost).');
    }
    if (redirects.length === 0) throw new CliError('--backchannel needs --client-redirect: it is set on the OAuth client.');
  }
  return {
    product,
    appName: str(v, 'name') || product,
    environment,
    domain,
    authHost: str(v, 'auth-host') || (domain ? `auth.${domain}` : undefined),
    strategies,
    email: emailRaw,
    emailFrom: str(v, 'email-from') || (emailRaw === 'managed' && domain ? `noreply@mail.${domain}` : undefined),
    emailProvider: providerRaw as EmailProvider | undefined,
    emailKeyFile,
    redirects,
    webhookUrl: str(v, 'webhook-url'),
    backchannelUrl,
    force: v.force === true,
    rotateSecret: v['rotate-secret'] === true,
  };
}

/** The platform key and API URL: ATLAS_PLATFORM_KEY, else a stored profile holding a psk_ key. */
function platformAuth(ctx: RunContext, args: ParsedArgs): { secretKey: string; apiUrl: string } {
  const file = ctx.config.load();
  const profile = str(args.values, 'profile') || file.active_profile || 'default';
  const stored = file.profiles[profile];
  const envKey = ctx.env.ATLAS_PLATFORM_KEY?.trim();
  const key = envKey || ((stored?.secret_key?.startsWith('psk_') || /^atlas_(live|test)_psk_/.test(stored?.secret_key ?? '')) ? stored?.secret_key : undefined);
  if (!key) {
    throw new CliError(
      "atlas init needs a platform key (psk_…). Set ATLAS_PLATFORM_KEY, or store one with 'atlas login --secret-key psk_…'.",
    );
  }
  const apiUrl = envApiUrl(ctx.env) || stored?.api_url || DEFAULT_API_URL;
  return { secretKey: key, apiUrl };
}

interface ListBody<T> {
  data?: T[];
}
interface AppRow {
  id: string;
  name: string;
  environment: string;
  publishable_key: string;
  frontend_api_host: string | null;
  issuer?: string | null;
  discovery_url?: string | null;
  jwks_uri?: string | null;
  secret?: string;
}
interface InstanceRow {
  id: string;
  publishable_key: string;
  frontend_api_host: string | null;
  issuer?: string | null;
  discovery_url?: string | null;
  jwks_uri?: string | null;
  auth_config_resolved?: { strategies?: Record<string, unknown> };
  /** Switched-on methods not offered to users until an email provider exists. */
  inactive_methods?: Array<{ method: string; reason: string }>;
}

const isStatus = (err: unknown, status: number) => err instanceof AtlasApiError && err.status === status;

/**
 * Read the customer's provider key from a file, or stdin with '-'. A bare key,
 * or a dotenv line (`RESEND_API_KEY=re_…`). Never from argv, never printed.
 */
function readProviderKey(ctx: RunContext, file: string): string {
  let text: string;
  try {
    text = ctx.readFile(file === '-' ? '/dev/stdin' : file);
  } catch {
    throw new CliError(`Could not read the email provider key from ${file === '-' ? 'stdin' : file}.`);
  }
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '';
  const m = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(line);
  const key = (m ? m[1]! : line).trim().replace(/^"(.*)"$/, '$1');
  if (!key || /\s/.test(key)) throw new CliError(`No email provider key found in ${file === '-' ? 'stdin' : file}.`);
  return key;
}

/** Refuse up front when a NEW secret would land on an existing, different file. */
function assertFreeForNewSecret(path: string, force: boolean): void {
  if (existsSync(path) && !force) {
    throw new CliError(
      `${path} already exists. A new secret would be created and could not be saved there. Move the file aside, or re-run with --force to replace it.`,
    );
  }
}

export async function init(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const opts = parseOptions(args);
  const json = wantsJson(args.values);
  const log = (line: string) => (json ? ctx.io.err(line) : ctx.io.out(line));
  const dir = productDir(ctx.env, opts.product);
  const env = opts.environment;
  const secretFile = join(dir, `${env}.env`);
  const clientFile = join(dir, `${env}-oauth-client.env`);
  const webhookFile = join(dir, `${env}-webhook.env`);

  // The plan, then a confirmation unless --yes.
  log(`atlas init: ${opts.appName} (${env})`);
  log(`  strategies: ${opts.strategies.length ? opts.strategies.join(', ') : '(instance defaults)'}`);
  log(
    `  email:      ${opts.email}${opts.email === 'managed' ? ` from ${opts.emailFrom}` : ''}${opts.emailProvider ? ` (your ${opts.emailProvider} account)` : ''}`,
  );
  if (opts.authHost) log(`  domain:     ${opts.authHost}`);
  if (opts.redirects.length) log(`  client:     first-party OAuth client → ${opts.redirects.join(', ')}`);
  if (opts.webhookUrl) log(`  webhook:    ${opts.webhookUrl}`);
  log(`  secrets:    ${dir} (0600 files, never printed)`);
  if (args.values.yes !== true) {
    const answer = (await ctx.prompt.text('Proceed? (y/N)')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') throw new CliError('Aborted. Nothing was changed.');
  }

  const platform = platformAuth(ctx, args);
  const plat = httpFor(ctx, platform);

  // --- 1. app + instance --------------------------------------------------
  const apps = (await plat.get<ListBody<AppRow>>('/v1/platform/apps')).data ?? [];
  let app = apps.find((a) => a.name === opts.appName && a.environment === env);
  let created = false;
  if (!app) {
    assertFreeForNewSecret(secretFile, opts.force);
    const origins = [...new Set(opts.redirects.map((r) => new URL(r).origin).filter((o) => o.startsWith('http')))];
    app = await plat.post<AppRow>('/v1/platform/apps', {
      name: opts.appName,
      environment: env,
      create_development_sibling: false,
      ...(origins.length ? { allowed_origins: origins } : {}),
    });
    created = true;
    writeSecretFile(dir, `${env}.env`, { ATLAS_SECRET_KEY: app.secret ?? '' }, {
      force: opts.force,
      comment: `Atlas secret key for ${opts.appName} (${env}, ${app.id}). Server-side only.`,
    });
    log(`Created app ${app.id}. Secret key written to ${secretFile}.`);
  } else {
    log(`Found app ${app.id}.`);
  }

  let secretKey = readEnvFile(secretFile)?.ATLAS_SECRET_KEY;
  if (!secretKey) {
    if (!opts.rotateSecret) {
      throw new CliError(
        `App ${app.id} exists but its secret key is not in ${secretFile}. Re-run with --rotate-secret to mint a new one (existing keys keep working for the default overlap window).`,
      );
    }
    const rotated = await plat.post<{ secret: string; previous_keys_expire_at: number | null }>(
      `/v1/platform/apps/${app.id}/rotate_secret`,
      {},
    );
    writeSecretFile(dir, `${env}.env`, { ATLAS_SECRET_KEY: rotated.secret }, {
      force: true,
      comment: `Atlas secret key for ${opts.appName} (${env}, ${app.id}). Server-side only.`,
    });
    secretKey = rotated.secret;
    const until = rotated.previous_keys_expire_at ? new Date(rotated.previous_keys_expire_at).toISOString() : 'now';
    log(`Minted a new secret key into ${secretFile}. Previous keys stop working: ${until}.`);
  }

  const api = httpFor(ctx, { secretKey, apiUrl: platform.apiUrl });
  const previous = readManifest(ctx.env, opts.product);
  const record: ProjectInstance = {
    ...(previous?.instances[env] ?? {}),
    instance_id: app.id,
    environment: env,
    publishable_key: app.publishable_key,
    frontend_api_host: app.frontend_api_host,
    issuer: null,
    discovery_url: null,
    jwks_uri: null,
    secret_file: secretFile,
  };

  // --- 2. email sender (before strategies: email methods need it) ----------
  // Always the customer's own provider account: Atlas lends none. The key comes
  // from --email-key-file (or stdin) and is sent once; it is never printed.
  const providerKey = () => {
    if (!opts.emailProvider || !opts.emailKeyFile) {
      throw new CliError(
        `--email ${opts.email} sends through your own email provider. Pass --email-provider resend|brevo and --email-key-file <path> (or - to read it from stdin).`,
      );
    }
    return { transport: opts.emailProvider, config: { api_key: readProviderKey(ctx, opts.emailKeyFile) } };
  };
  let emailReady = opts.email === 'none';
  if (opts.email === 'managed') {
    let managed: { from_address: string; verified: boolean; records?: Array<{ type: string; name: string; value: string; priority?: number }> };
    try {
      managed = await api.get('/v1/messaging_providers/email/managed');
    } catch (err) {
      if (!isStatus(err, 404)) throw err;
      managed = await api.post('/v1/messaging_providers/email/managed', { from_address: opts.emailFrom, ...providerKey() });
      log(`Registered ${opts.emailFrom} on your ${opts.emailProvider} account (managed email).`);
    }
    emailReady = managed.verified;
    record.email = { mode: 'managed', from_address: managed.from_address };
    if (!managed.verified) {
      log('Publish these DNS records for managed email, then run: atlas init again (or POST /v1/messaging_providers/email/managed/verify):');
      for (const r of managed.records ?? []) {
        log(`  ${r.type.padEnd(5)} ${r.name}  ${r.value}${r.priority !== undefined ? `  (priority ${r.priority})` : ''}`);
      }
    } else {
      log(`Managed email verified: ${managed.from_address}.`);
    }
  } else if (opts.email === 'development') {
    const providers = await api.get<{ email?: { id: string; mode?: string } | null }>('/v1/messaging_providers');
    let dev: { from_address: string; active: boolean; note?: string };
    if (providers.email?.mode === 'development' && !opts.emailKeyFile) {
      dev = await api.get('/v1/messaging_providers/email/development');
    } else if (providers.email && !opts.emailKeyFile) {
      dev = await api.post('/v1/messaging_providers/email/development', {
        provider_id: providers.email.id,
        ...(opts.emailFrom ? { from_address: opts.emailFrom } : {}),
      });
    } else {
      dev = await api.post('/v1/messaging_providers/email/development', {
        ...providerKey(),
        ...(opts.emailFrom ? { from_address: opts.emailFrom } : {}),
      });
    }
    emailReady = dev.active;
    record.email = { mode: 'development', from_address: dev.from_address };
    log(`Development email sender on: your provider, from ${dev.from_address} (capped, development instances only).`);
    if (dev.note) log(`  Note: ${dev.note}`);
  } else {
    record.email = { mode: 'none' };
  }

  // --- 3. strategies --------------------------------------------------------
  // Every requested method is switched on, even before the email sender is
  // ready: the instance accepts the write and simply does not offer a method
  // that needs email (it reports it under inactive_methods) until it can send.
  if (opts.strategies.length) {
    const current = (await api.get<InstanceRow>('/v1/instance')).auth_config_resolved?.strategies ?? {};
    const missing = opts.strategies.filter((s) => current[s] !== true);
    if (missing.length) {
      try {
        const res = await api.patch<InstanceRow>('/v1/instance', { auth_config: { strategies: Object.fromEntries(missing.map((s) => [s, true])) } });
        log(`Turned on: ${missing.join(', ')}.`);
        const inactive = (res?.inactive_methods ?? []).map((m) => m.method);
        if (inactive.length) {
          log(`Not offered to users yet (they need an email provider, and this instance cannot send email): ${inactive.join(', ')}. They become active once email can be sent.`);
        }
      } catch (err) {
        // An older server refuses email methods without a sender: say so, keep going.
        if (!(err instanceof AtlasApiError && err.status === 422 && err.code === 'EMAIL_PROVIDER_REQUIRED')) throw err;
        log(`Not turned on yet: ${err.message} Re-run atlas init once email can be sent.`);
      }
    }
    if (!emailReady && missing.some((s) => EMAIL_STRATEGIES.has(s))) {
      log('Email code / email link need the email sender: they start working as soon as it is ready.');
    }
  }

  // --- 4. custom domain ------------------------------------------------------
  if (opts.authHost) {
    const domains = (await api.get<ListBody<{ host: string; cname_target: string | null; status: string; live?: boolean }>>('/v1/domains')).data ?? [];
    let d = domains.find((x) => x.host === opts.authHost);
    if (!d) {
      d = await api.post('/v1/domains', { host: opts.authHost, role: 'fapi' });
      log(`Added custom domain ${opts.authHost}.`);
    }
    record.custom_domain = { host: d!.host, cname_target: d!.cname_target, status: d!.status };
    if (!d!.live && d!.cname_target) {
      log(`Publish this DNS record for the sign-in domain: CNAME ${d!.host} → ${d!.cname_target} (DNS only, not proxied).`);
    }
  }

  // --- 5. first-party OAuth client -----------------------------------------
  if (opts.redirects.length) {
    const clientName = `${opts.appName} (${env})`;
    const clients = (
      await api.get<ListBody<{ id: string; client_id: string; name: string; redirect_uris: string[]; backchannel_logout_uri?: string | null }>>('/v1/oauth_clients')
    ).data ?? [];
    const existing = clients.find((c) => c.name === clientName);
    if (existing) {
      const missingUris = opts.redirects.filter((r) => !existing.redirect_uris.includes(r));
      if (missingUris.length) {
        await api.patch(`/v1/oauth_clients/${existing.id}`, { redirect_uris: [...existing.redirect_uris, ...missingUris] });
        log(`Added redirect URIs to OAuth client ${existing.client_id}: ${missingUris.join(', ')}.`);
      } else {
        log(`Found OAuth client ${existing.client_id}.`);
      }
      if (opts.backchannelUrl && existing.backchannel_logout_uri !== opts.backchannelUrl) {
        await api.patch(`/v1/oauth_clients/${existing.id}`, { backchannel_logout_uri: opts.backchannelUrl });
        log(`Set the back-channel logout URI of ${existing.client_id} to ${opts.backchannelUrl}.`);
      }
      const hasSecret = Boolean(readEnvFile(clientFile)?.ATLAS_CLIENT_SECRET);
      if (!hasSecret) log(`Its secret is not in ${clientFile}. Mint one with: atlas client rotate ${existing.id} --product ${opts.product} --instance-env ${env}`);
      record.oauth_client = {
        id: existing.id,
        client_id: existing.client_id,
        redirect_uris: [...new Set([...existing.redirect_uris, ...missingUris])],
        secret_file: hasSecret ? clientFile : null,
      };
    } else {
      assertFreeForNewSecret(clientFile, opts.force);
      const c = await api.post<{ id: string; client_id: string; redirect_uris: string[]; client_secret?: string }>('/v1/oauth_clients', {
        name: clientName,
        redirect_uris: opts.redirects,
        first_party: true,
        ...(opts.backchannelUrl ? { backchannel_logout_uri: opts.backchannelUrl } : {}),
      });
      if (c.client_secret) {
        writeSecretFile(dir, `${env}-oauth-client.env`, { ATLAS_CLIENT_ID: c.client_id, ATLAS_CLIENT_SECRET: c.client_secret }, {
          force: opts.force,
          comment: `OAuth client ${c.id} for ${opts.appName} (${env}). Server-side only.`,
        });
      }
      record.oauth_client = { id: c.id, client_id: c.client_id, redirect_uris: c.redirect_uris, secret_file: c.client_secret ? clientFile : null };
      log(`Created first-party OAuth client ${c.client_id}. Secret written to ${clientFile}.`);
    }
  }

  if (opts.backchannelUrl) {
    log(
      `Back-channel logout goes to ${opts.backchannelUrl}. Serve it with @atlasauth/backend: expressBackchannelLogout, fastifyBackchannelLogoutPlugin or nextBackchannelLogout ({ issuer, clientId, onLogout }). Test it with POST /v1/oauth_clients/{id}/backchannel_logout/test.`,
    );
  }

  // --- 6. webhook endpoint ---------------------------------------------------
  if (opts.webhookUrl) {
    const hooks = (await api.get<ListBody<{ id: string; url: string }>>('/v1/webhook_endpoints')).data ?? [];
    const existing = hooks.find((h) => h.url === opts.webhookUrl);
    if (existing) {
      const hasSecret = Boolean(readEnvFile(webhookFile)?.ATLAS_WEBHOOK_SECRET);
      record.webhook = { id: existing.id, url: existing.url, secret_file: hasSecret ? webhookFile : null };
      log(`Found webhook endpoint ${existing.id}.`);
    } else {
      assertFreeForNewSecret(webhookFile, opts.force);
      const h = await api.post<{ id: string; url: string; secret?: string }>('/v1/webhook_endpoints', { url: opts.webhookUrl });
      if (h.secret) {
        writeSecretFile(dir, `${env}-webhook.env`, { ATLAS_WEBHOOK_SECRET: h.secret }, {
          force: opts.force,
          comment: `Signing secret for webhook endpoint ${h.id} (${opts.webhookUrl}).`,
        });
      }
      record.webhook = { id: h.id, url: h.url, secret_file: h.secret ? webhookFile : null };
      log(`Created webhook endpoint ${h.id}. Signing secret written to ${webhookFile}.`);
    }
  }

  // --- 7. public endpoints, manifest, summary ----------------------------------
  const inst = await api.get<InstanceRow>('/v1/instance').catch(() => undefined);
  const host = inst?.frontend_api_host ?? app.frontend_api_host;
  const base = host ? `https://${host}` : null;
  record.publishable_key = inst?.publishable_key ?? app.publishable_key;
  record.frontend_api_host = host ?? null;
  record.issuer = inst?.issuer ?? app.issuer ?? base;
  record.discovery_url = inst?.discovery_url ?? app.discovery_url ?? (record.issuer ? `${record.issuer}/.well-known/openid-configuration` : null);
  record.jwks_uri = inst?.jwks_uri ?? app.jwks_uri ?? (base ? `${base}/.well-known/jwks.json` : null);

  const manifest: ProjectManifest = {
    product: opts.product,
    api_url: platform.apiUrl,
    instances: { ...(previous?.instances ?? {}), [env]: record },
  };
  const manifestFile = writeManifest(ctx.env, manifest);

  if (json) {
    printJson(ctx.io, { created, manifest: manifestFile, ...record });
    return 0;
  }
  ctx.io.out('');
  ctx.io.out(`Done. ${created ? 'Created' : 'Updated'} ${opts.appName} (${env}).`);
  ctx.io.out(`  Instance:          ${record.instance_id}`);
  ctx.io.out(`  Publishable key:   ${record.publishable_key}`);
  ctx.io.out(`  Frontend API:      ${base ?? '(not assigned)'}`);
  ctx.io.out(`  Issuer:            ${record.issuer ?? '(unknown)'}`);
  ctx.io.out(`  Discovery:         ${record.discovery_url ?? '(unknown)'}`);
  if (record.oauth_client) ctx.io.out(`  OAuth client id:   ${record.oauth_client.client_id}`);
  ctx.io.out(`  Secret key file:   ${secretFile}`);
  if (record.oauth_client?.secret_file) ctx.io.out(`  Client secret file: ${record.oauth_client.secret_file}`);
  if (record.webhook?.secret_file) ctx.io.out(`  Webhook secret file: ${record.webhook.secret_file}`);
  ctx.io.out(`  Project manifest:  ${manifestFile}`);
  ctx.io.out(`Next: atlas preflight --product ${opts.product} --instance-env ${env}, and atlas env --product ${opts.product} --format dotenv`);
  return 0;
}


import { resolve } from 'node:path';
import { CliError } from '../../errors';
import { exportOryApi, exportOryTables } from '../export/ory';
import { fetchOryClients, fetchOrySchemas, parseOryConfig, resolveOrySchemas, splitOryProject, translateOryConfig, type OryConfigFile, type OryIdentitySchema } from '../export/ory-config';
import { readDumpDir } from '../export/frameworks/tables';
import type { Obj, RecordSet } from '../export/record-set';
import { hostOf, vendorStep, writeRecordSet } from '../export/plugin-kit';
import { VendorHttp } from '../export/vendor-http';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';

/**
 * `atlas migrate ory` — Ory Kratos and Hydra, self-hosted or on Ory Network:
 * the Kratos config (kratos.yml, or `ory get project` JSON), identity schemas
 * and Hydra's config and OAuth 2.0 clients as Atlas config; identities with
 * their verified addresses, social links, metadata and — from a database dump —
 * password hashes in every format Kratos verifies, TOTP seeds, recovery codes,
 * WebAuthn / passkey credentials and live session tokens; a zero-logout
 * bridge (Kratos vouches for the session, or imported session tokens); lazy
 * migration through Kratos' login flow; and the code. Credentials stay on this
 * machine. Ory Network has no database access and its Admin API returns no
 * hashes, seeds or session tokens: those users move by lazy migration and
 * enrol their second factor again.
 */

const ADMIN_URL: CredentialSpec = { flag: '--ory-admin-url', env: 'ORY_ADMIN_URL', label: 'the Kratos admin URL (http://kratos:4434) or your Ory Network project URL', required: false };
const PUBLIC_URL: CredentialSpec = { flag: '--ory-public-url', env: 'ORY_PUBLIC_URL', label: 'the Kratos public URL (https://auth.example.com, or https://<slug>.projects.oryapis.com)', required: false };
const API_KEY: CredentialSpec = { flag: '--ory-api-key', env: 'ORY_API_KEY', label: 'an Ory Network project API key (ory_pat_…)', required: false, secret: true };
const DUMP: CredentialSpec = { flag: '--ory-dump', env: 'ORY_DUMP_DIR', label: 'a folder of Kratos table dumps (identities.csv, identity_credentials.csv, …)', required: false };
const RP_ID: CredentialSpec = { flag: '--ory-rp-id', env: 'ORY_RP_ID', label: 'the WebAuthn relying-party id passkeys were registered for (rp.id in kratos.yml)', required: false };
const NID: CredentialSpec = { flag: '--ory-nid', env: 'ORY_NID', label: 'the project (nid) to export from a multi-project database', required: false };
const CONFIG_FILE: CredentialSpec = { flag: '--ory-config', env: 'ORY_CONFIG', label: 'kratos.yml, or the JSON of `ory get project <id> --format json`', required: false };
const HYDRA_CONFIG: CredentialSpec = { flag: '--ory-hydra-config', env: 'ORY_HYDRA_CONFIG', label: 'hydra.yml', required: false };
const HYDRA_URL: CredentialSpec = { flag: '--ory-hydra-url', env: 'ORY_HYDRA_URL', label: 'the Hydra admin URL (http://hydra:4445), to read OAuth 2.0 clients', required: false };
const BRIDGE_MODE: CredentialSpec = {
  flag: '--ory-bridge',
  env: 'ORY_BRIDGE',
  label: 'what the bridge accepts: whoami-cookie (default when the public URL is known), whoami-token (X-Session-Token / Bearer tokens checked with Kratos) or session-token (tokens imported with a database export)',
  required: false,
};
const COOKIE_NAME: CredentialSpec = { flag: '--ory-cookie-name', env: 'ORY_COOKIE_NAME', label: 'the session cookie name (ory_kratos_session; ory_session_<slug> on Ory Network)', required: false };
const EMAIL_TRAIT: CredentialSpec = { flag: '--ory-email-trait', env: 'ORY_EMAIL_TRAIT', label: 'the identity trait holding the email address (default email), for lazy migration', required: false };

const NETWORK = /\.projects\.oryapis\.com$|\.oryapis\.com$/i;

const isNetwork = (url: string | undefined): boolean => !!url && NETWORK.test(hostOf(url).replace(/:\d+$/, ''));

/** `https://…` with no trailing slash; a bare host gets https. */
function baseUrl(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(s) ? s : `https://${s}`;
}

type BridgeMode = 'whoami-cookie' | 'whoami-token' | 'session-token';
const PRESETS: Record<BridgeMode, string> = { 'whoami-cookie': 'ory_whoami', 'whoami-token': 'ory_whoami_token', 'session-token': 'ory' };

function publicUrl(p: PluginContext, t?: { bridge?: { vars: Record<string, string> }; lazy?: { config: Record<string, string> } }): string | undefined {
  const admin = p.credential(ADMIN_URL);
  const raw = p.credential(PUBLIC_URL) ?? (isNetwork(admin) ? admin : undefined) ?? t?.bridge?.vars.base_url ?? t?.lazy?.config.base_url;
  return raw ? baseUrl(raw) : undefined;
}

function bridgeMode(p: PluginContext, hasPublicUrl: boolean): BridgeMode {
  const raw = p.credential(BRIDGE_MODE)?.trim().toLowerCase();
  if (!raw) return hasPublicUrl ? 'whoami-cookie' : 'session-token';
  if (raw === 'whoami-cookie' || raw === 'whoami-token' || raw === 'session-token') return raw;
  throw new CliError(`Ory: --set ory-bridge takes whoami-cookie, whoami-token or session-token (got ${raw}).`);
}

/** The preset the last `bridge.vars` call chose (the framework reads `vars` first, then `preset`). */
let chosenPreset = 'ory';

export const oryPlugin: MigrationPlugin = {
  vendor: 'ory',
  source: 'ory',
  label: 'Ory (Kratos, Hydra, Ory Network)',
  help: 'Move Ory Kratos and Hydra (self-hosted or Ory Network): kratos.yml, identity schemas, Hydra settings and OAuth 2.0 clients as Atlas config; identities with verified addresses, social links and metadata through the Admin API, plus password hashes, TOTP seeds, recovery codes, passkeys and session tokens from a database dump; a zero-logout bridge where Kratos vouches for the session; lazy migration through the Kratos login flow; and the code. Credentials stay on this machine.',
  config: {
    reads: 'kratos.yml or `ory get project` JSON, hydra.yml, the identity schemas, and the Hydra Admin API (OAuth 2.0 clients)',
    credentials: [CONFIG_FILE, HYDRA_CONFIG, PUBLIC_URL, HYDRA_URL, ADMIN_URL, API_KEY],
    async translate(p) {
      const warnings: string[] = [];
      let kratos: OryConfigFile | undefined;
      let hydra: OryConfigFile | undefined;
      const read = (path: string): OryConfigFile => {
        try {
          return parseOryConfig(p.ctx.readFile(resolve(path)), path);
        } catch (err) {
          throw new CliError(`Ory: could not read ${path}: ${(err as Error).message}`);
        }
      };
      const configPath = p.credential(CONFIG_FILE);
      if (configPath) {
        const parsed = read(configPath);
        const project = splitOryProject(parsed);
        kratos = project?.kratos ?? parsed;
        hydra = project?.hydra;
      }
      const hydraPath = p.credential(HYDRA_CONFIG);
      if (hydraPath) hydra = read(hydraPath);

      let schemas: OryIdentitySchema[] = resolveOrySchemas(kratos, (path) => p.ctx.readFile(path), (m) => warnings.push(m));
      const url = p.credential(PUBLIC_URL) ?? (isNetwork(p.credential(ADMIN_URL)) ? p.credential(ADMIN_URL) : undefined);
      const apiKey = p.credential(API_KEY);
      const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : undefined;
      if (url && !schemas.length) {
        const http = new VendorHttp({ vendor: 'Ory', baseUrl: baseUrl(url), headers, fetchImpl: p.fetch });
        schemas = await vendorStep('Ory', () => fetchOrySchemas(http));
      }
      let clients: Obj[] = [];
      const admin = p.credential(ADMIN_URL);
      const hydraUrl = p.credential(HYDRA_URL) ?? (isNetwork(admin) ? admin : isNetwork(url) ? url : undefined);
      if (hydraUrl) {
        const http = new VendorHttp({ vendor: 'Ory Hydra', baseUrl: baseUrl(hydraUrl), headers, fetchImpl: p.fetch });
        clients = await vendorStep('Ory Hydra', () => fetchOryClients(http));
      }
      if (!kratos && !hydra && !schemas.length && !clients.length) {
        throw new CliError('Ory: nothing to read. Pass kratos.yml (--set ory-config=<file>), an Ory Network project JSON, a public URL (--set ory-public-url=…) or the Hydra admin URL (--set ory-hydra-url=…).');
      }
      for (const w of warnings) p.say(`  ${w}`);
      const origin = configPath ?? (url ? `Ory ${hostOf(url)}` : hydraPath ?? `Ory Hydra ${hostOf(hydraUrl ?? '')}`);
      return translateOryConfig({ origin, kratos, hydra, schemas, clients, publicUrl: url ? baseUrl(url) : undefined });
    },
  },
  export: {
    reads: 'a dump of the Kratos database (identities, identity_credentials, identity_verifiable_addresses, sessions) or the Kratos Admin API',
    credentials: [DUMP, ADMIN_URL, API_KEY, RP_ID, NID],
    limits: [
      'Password hashes, TOTP seeds, recovery codes, WebAuthn credentials and session tokens live only in the database: dump it (see the guide). The Admin API returns none of them, so those users move by lazy migration and enrol their second factor again.',
      'Ory Network has no database access: its identities export through the Admin API with a project API key, passwords move by lazy migration and the bridge asks Ory to vouch for the session.',
      'Hash formats Atlas cannot verify (for example $hmac-md4$) are left out and those users move by lazy migration.',
      'Passkeys and security keys need the relying-party id (--set ory-rp-id) and keep working only when Atlas serves sign-in on that domain.',
      'Ory Network organizations (enterprise SSO) and Hydra consent grants are not exported: recreate SSO connections in Atlas; users consent again.',
    ],
    async run(p, writer, resume) {
      const dump = p.credential(DUMP);
      const rpId = p.credential(RP_ID);
      const rawAdmin = p.credential(ADMIN_URL) ?? (isNetwork(p.credential(PUBLIC_URL)) ? p.credential(PUBLIC_URL) : undefined);
      let set: RecordSet;
      if (dump) {
        set = await vendorStep('Ory', async () => exportOryTables(readDumpDir(resolve(dump)), { rpId, networkId: p.credential(NID) }));
      } else if (rawAdmin) {
        const apiKey = p.credential(API_KEY);
        if (isNetwork(rawAdmin) && !apiKey) throw new CliError('Ory Network: pass a project API key (--set ory-api-key=ory_pat_… or ORY_API_KEY).');
        set = await vendorStep('Ory', () => exportOryApi({ adminUrl: rawAdmin, apiKey, rpId, fetchImpl: p.fetch, onProgress: (m) => p.say(`  reading ${m}`) }));
      } else {
        throw new CliError('Ory: pass a folder of Kratos table dumps (--set ory-dump=<folder>), or the admin URL (--set ory-admin-url=…) for an Admin API export without password hashes.');
      }
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    get preset() {
      return chosenPreset;
    },
    vars(p, t) {
      const vars: Record<string, string> = { ...t?.bridge?.vars };
      const url = publicUrl(p, t);
      const mode = bridgeMode(p, !!url);
      chosenPreset = PRESETS[mode];
      if (mode === 'session-token') return {};
      if (!url) throw new CliError('Ory: the whoami bridge calls Kratos: pass its public URL (--set ory-public-url=https://auth.example.com).');
      vars.base_url = url;
      if (mode === 'whoami-cookie') {
        const slug = /^https:\/\/([a-z0-9-]+)\.projects\.oryapis\.com/i.exec(url)?.[1];
        vars.cookie_name = p.credential(COOKIE_NAME)?.trim() ?? vars.cookie_name ?? (slug ? `ory_session_${slug}` : 'ory_kratos_session');
      } else delete vars.cookie_name;
      return vars;
    },
  },
  lazy: {
    preset: 'ory',
    config(p, t) {
      const config: Record<string, string> = { ...t?.lazy?.config };
      const url = publicUrl(p, t);
      if (url) config.base_url = url;
      const trait = p.credential(EMAIL_TRAIT);
      if (trait) config.email_trait = trait.trim();
      return config;
    },
  },
  codemod: 'ory',
};

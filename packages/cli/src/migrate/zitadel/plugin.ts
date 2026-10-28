import { resolve } from 'node:path';
import { CliError } from '../../errors';
import { exportZitadelApi, mapZitadel, readZitadelExport, zitadelBase, type ZitadelMapOptions } from '../export/zitadel';
import { configSnapshotFromExport, fetchZitadelConfig, translateZitadelConfig } from '../export/zitadel-config';
import { need, vendorStep, writeRecordSet } from '../export/plugin-kit';
import type { RecordSet } from '../export/record-set';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';

/**
 * `atlas migrate zitadel` — ZITADEL Cloud and self-hosted ZITADEL: policies,
 * applications, project roles and identity providers as Atlas config; users
 * with their password hashes, TOTP secrets, verified email and phone, social
 * and enterprise links, project roles (as app roles) and organizations with
 * their members, from ZITADEL's own export (a file, or the admin API with a
 * service-user token); a zero-logout bridge for ZITADEL ID tokens and JWT
 * access tokens; lazy migration through the session API; and the code. The
 * token stays on this machine.
 */

const URL_SPEC: CredentialSpec = { flag: '--zitadel-url', env: 'ZITADEL_URL', label: 'your ZITADEL URL (https://<instance>.zitadel.cloud, or your own domain)', required: false };
const TOKEN: CredentialSpec = { flag: '--zitadel-token', env: 'ZITADEL_TOKEN', label: 'a service user\'s personal access token (IAM_OWNER to export, IAM_LOGIN_CLIENT for lazy migration)', required: false, secret: true };
const EXPORT_FILE: CredentialSpec = { flag: '--zitadel-export', env: 'ZITADEL_EXPORT_FILE', label: 'the JSON file `zitadel export` wrote (or a saved POST /admin/v1/export response)', required: false };
const ORGS: CredentialSpec = { flag: '--zitadel-orgs', env: 'ZITADEL_ORGS', label: 'how organizations move: auto (when there is more than one), all or skip', required: false };

function instanceUrl(p: PluginContext): string | undefined {
  const raw = p.credential(URL_SPEC);
  return raw ? zitadelBase(raw) : undefined;
}

function orgsMode(p: PluginContext): NonNullable<ZitadelMapOptions['orgs']> {
  const raw = (p.credential(ORGS) ?? 'auto').trim().toLowerCase();
  if (raw !== 'auto' && raw !== 'all' && raw !== 'skip') throw new CliError(`ZITADEL: --set zitadel-orgs takes auto, all or skip (got ${raw}).`);
  return raw;
}

function readDocument(p: PluginContext, path: string): unknown {
  try {
    return JSON.parse(p.ctx.readFile(resolve(path))) as unknown;
  } catch (err) {
    throw new CliError(`ZITADEL: could not read the export ${path}: ${(err as Error).message}`);
  }
}

export const zitadelPlugin: MigrationPlugin = {
  vendor: 'zitadel',
  source: 'zitadel',
  label: 'ZITADEL',
  help: 'Move ZITADEL (Cloud or self-hosted): login, password and lockout policy, applications, project roles and identity providers as Atlas config; users with password hashes, TOTP secrets, verified email and phone, social and enterprise links, roles and organizations from ZITADEL\'s own export; a zero-logout bridge for ZITADEL ID tokens and JWT access tokens; lazy migration through the session API; and the code. Your service-user token stays on this machine.',
  config: {
    reads: 'a `zitadel export` file, or your instance through the admin API (policies, applications, roles, identity providers, actions)',
    credentials: [EXPORT_FILE, URL_SPEC, TOKEN],
    async translate(p) {
      const file = p.credential(EXPORT_FILE);
      const url = instanceUrl(p);
      if (file) return translateZitadelConfig(configSnapshotFromExport(readDocument(p, file), file, url));
      const token = p.credential(TOKEN);
      if (!url || !token) {
        throw new CliError('ZITADEL: pass the export file (--set zitadel-export=<file>), or your instance URL and a service-user token (--set zitadel-url=… --set zitadel-token=…).');
      }
      return translateZitadelConfig(await vendorStep('ZITADEL', () => fetchZitadelConfig({ instance: url, token, fetchImpl: p.fetch })));
    },
  },
  export: {
    reads: 'ZITADEL\'s export (a `zitadel export` file, or POST /admin/v1/export with a service-user token)',
    credentials: [EXPORT_FILE, URL_SPEC, TOKEN, ORGS],
    limits: [
      'Passkeys and security keys live only in ZITADEL\'s event store and are not exported: users register a passkey again.',
      'Password hashes and TOTP secrets need the export with passwords and secrets on (`zitadel export`, or an IAM_OWNER token on the admin API). With a narrower role the export lists users through the user API instead, and passwords move by lazy migration.',
      'Machine users (service accounts) are not exported: recreate them as Atlas API keys or M2M clients.',
      'Organizations become Atlas organizations when the instance has more than one (--set zitadel-orgs=all to always, skip to never); organization roles other than ORG_OWNER join as plain members.',
      'Sessions are opaque to Atlas: the bridge accepts ZITADEL ID tokens and JWT access tokens instead.',
    ],
    async run(p, writer, resume) {
      const file = p.credential(EXPORT_FILE);
      const orgs = orgsMode(p);
      let set: RecordSet;
      if (file) {
        const url = instanceUrl(p);
        set = await vendorStep('ZITADEL', async () => mapZitadel({ ...readZitadelExport(readDocument(p, file)), instance: url }, { orgs }));
      } else {
        const url = instanceUrl(p);
        if (!url) throw new CliError('ZITADEL: pass the export file (--set zitadel-export=<file>), or your instance URL and a service-user token (--set zitadel-url=… --set zitadel-token=…).');
        const token = need(p, TOKEN);
        set = await vendorStep('ZITADEL', () => exportZitadelApi({ instance: url, token, orgs, fetchImpl: p.fetch, onProgress: (m) => p.say(`  reading ${m}`) }));
      }
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'zitadel',
    vars(p, t) {
      const vars: Record<string, string> = { ...t?.bridge?.vars };
      const url = instanceUrl(p);
      if (url) vars.issuer = url;
      if (!vars.issuer) throw new CliError('ZITADEL: the bridge needs the issuer: pass your instance URL (--set zitadel-url=https://<instance>.zitadel.cloud).');
      return vars;
    },
  },
  lazy: {
    preset: 'zitadel',
    config(p, t) {
      const config: Record<string, string> = { ...t?.lazy?.config };
      const url = instanceUrl(p);
      if (url) config.base_url = url;
      return config;
    },
    secret: TOKEN,
  },
  codemod: 'zitadel',
};

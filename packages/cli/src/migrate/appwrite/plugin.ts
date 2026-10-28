import { APPWRITE_CLOUD, exportAppwrite } from '../export/appwrite';
import { translateAppwriteConfig } from '../export/appwrite-config';
import { CliError } from '../../errors';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';
import { localFile, need, vendorStep, writeRecordSet } from '../export/plugin-kit';
import { projectFile, truthyCredential } from '../export/project-files';

/**
 * `atlas migrate appwrite` — an Appwrite project (Cloud or self-hosted): auth
 * settings from appwrite.json and the project document, users with their
 * hashes and hash options, identities, MFA recovery codes, teams, memberships
 * and invitations through the Server API (an API key on this machine), the
 * `appwrite` remote bridge (Appwrite vouches for a live session once), lazy
 * migration through the Account API for anyone the export missed, and the
 * `appwrite` codemod.
 */

const ENDPOINT: CredentialSpec = { flag: '--appwrite-endpoint', env: 'APPWRITE_ENDPOINT', label: 'the Appwrite API endpoint including /v1 (default https://cloud.appwrite.io/v1)', required: false };
const PROJECT_ID: CredentialSpec = { flag: '--appwrite-project-id', env: 'APPWRITE_PROJECT_ID', label: 'the Appwrite project id', required: true };
const API_KEY: CredentialSpec = { flag: '--appwrite-api-key', env: 'APPWRITE_API_KEY', label: 'an Appwrite API key with users.read and teams.read', required: true, secret: true };
const RECOVERY_CODES: CredentialSpec = { flag: '--appwrite-recovery-codes', env: 'APPWRITE_RECOVERY_CODES', label: 'true to export MFA recovery codes', required: false };
const SKIP_TEAMS: CredentialSpec = { flag: '--appwrite-skip-teams', env: 'APPWRITE_SKIP_TEAMS', label: 'true to leave teams out', required: false };
const CONFIG_FILE: CredentialSpec = { flag: '--appwrite-config', env: 'APPWRITE_CONFIG_FILE', label: 'appwrite.json (after appwrite pull settings)', required: false };
const PROJECT_FILE: CredentialSpec = { flag: '--appwrite-project-file', env: 'APPWRITE_PROJECT_FILE', label: 'the project document (appwrite projects get --project-id <id> --json)', required: false };

function endpointOf(p: PluginContext): string {
  return (p.credential(ENDPOINT) ?? APPWRITE_CLOUD).trim().replace(/\/+$/, '');
}

export const appwritePlugin: MigrationPlugin = {
  vendor: 'appwrite',
  source: 'appwrite',
  label: 'Appwrite',
  help: 'Move an Appwrite project: its auth methods, session and password settings and OAuth providers as Atlas config; its users with their password hashes (Argon2, bcrypt, scrypt, Firebase scrypt, MD5, SHA, phpass), labels, prefs, OAuth identities, MFA recovery codes, teams, memberships and invitations; a zero-logout bridge that asks Appwrite about each live session once; lazy migration for anyone left; and the code. Your API key stays on this machine.',
  config: {
    reads: 'appwrite.json (appwrite pull settings) and, for OAuth providers, the project document (appwrite projects get --json)',
    credentials: [CONFIG_FILE, PROJECT_FILE, ENDPOINT, { ...PROJECT_ID, required: false }],
    async translate(p) {
      const file = projectFile(p, CONFIG_FILE, ['appwrite.json', 'appwrite.config.json']);
      const projectText = localFile(p, PROJECT_FILE, 'text');
      if (!file && !projectText) throw new CliError('Appwrite: no appwrite.json in this folder. Run appwrite pull settings, or pass --set appwrite-config=<file> / --set appwrite-project-file=<appwrite projects get --json output>.');
      let project: Record<string, unknown> | undefined;
      if (projectText) {
        try {
          project = JSON.parse(projectText) as Record<string, unknown>;
        } catch {
          throw new CliError('Appwrite: the project document is not JSON (use appwrite projects get --project-id <id> --json).');
        }
      }
      return vendorStep('Appwrite', async () =>
        translateAppwriteConfig({ file, project, endpoint: p.credential(ENDPOINT), projectId: p.credential({ ...PROJECT_ID, required: false }) }),
      );
    },
  },
  export: {
    reads: 'the Appwrite Server API (users with hashes, identities, MFA, teams and memberships)',
    credentials: [ENDPOINT, PROJECT_ID, API_KEY, RECOVERY_CODES, SKIP_TEAMS],
    limits: [
      'TOTP secrets are encrypted at rest and Appwrite has no API to read them: those users enrol an authenticator app again. Recovery codes move with --set appwrite-recovery-codes=true.',
      'Sessions are stored as hashes and cannot be exported: the appwrite bridge preset asks Appwrite about each live session once instead.',
      'A SHA hash imported into Appwrite without a version is ambiguous (SHA3-512 on 1.x, SHA-256 on 2.x): the export picks by digest length and warns.',
      'OAuth access and refresh tokens are not exported: users keep their link and re-consent when your app next calls the provider.',
    ],
    async run(p, writer, resume) {
      const set = await vendorStep('Appwrite', () =>
        exportAppwrite({
          endpoint: endpointOf(p),
          projectId: need(p, PROJECT_ID),
          apiKey: need(p, API_KEY),
          recoveryCodes: truthyCredential(p, RECOVERY_CODES),
          skipTeams: truthyCredential(p, SKIP_TEAMS),
          fetchImpl: p.fetch,
          onProgress: (m) => p.say(`  reading ${m}`),
        }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'appwrite',
    vars(p, t) {
      const vars: Record<string, string> = { ...t?.bridge?.vars };
      const endpoint = p.credential(ENDPOINT);
      if (endpoint || !vars.endpoint_url) vars.endpoint_url = endpointOf(p);
      const project = p.credential({ ...PROJECT_ID, required: false });
      if (project) vars.project_id = project;
      return vars;
    },
  },
  lazy: {
    preset: 'appwrite',
    config(p, t) {
      const config: Record<string, string> = { ...t?.lazy?.config };
      const endpoint = p.credential(ENDPOINT);
      if (endpoint || !config.endpoint) config.endpoint = endpointOf(p);
      const project = p.credential({ ...PROJECT_ID, required: false });
      if (project) config.project_id = project;
      return config;
    },
  },
  codemod: 'appwrite',
};

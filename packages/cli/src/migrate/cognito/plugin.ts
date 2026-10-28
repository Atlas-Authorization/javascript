import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CognitoApi, exportCognito, regionOfPool, type AwsCredentials } from '../export/cognito';
import { fetchCognitoConfig, translateCognitoConfig } from '../export/cognito-config';
import { CliError } from '../../errors';
import { truthyCredential } from '../export/project-files';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';
import { localFile, need, vendorStep, writeRecordSet } from '../export/plugin-kit';

/**
 * `atlas migrate cognito` — an Amazon Cognito user pool: its settings as
 * Atlas config (DescribeUserPool, app clients, identity providers, resource
 * servers, groups), its users with their attributes, federated links, groups
 * and SMS / email factors through the cognito-idp API (or `aws cognito-idp
 * list-users` output), the `cognito` bridge preset (ID tokens verified
 * against the pool's JWKS) and lazy migration for every password (Cognito
 * never exports hashes). AWS credentials stay on this machine: they sign the
 * requests and are sent to AWS only as a signature.
 */

const POOL: CredentialSpec = { flag: '--cognito-user-pool-id', env: 'COGNITO_USER_POOL_ID', label: 'the user pool id (us-east-1_AbC123xyz)', required: true };
const REGION: CredentialSpec = { flag: '--aws-region', env: 'AWS_REGION', label: 'the AWS region (default: from the pool id)', required: false };
const ACCESS_KEY: CredentialSpec = { flag: '--aws-access-key-id', env: 'AWS_ACCESS_KEY_ID', label: 'an AWS access key id allowed cognito-idp:List*/Describe*', required: false };
const SECRET_KEY: CredentialSpec = { flag: '--aws-secret-access-key', env: 'AWS_SECRET_ACCESS_KEY', label: 'its secret access key', required: false, secret: true };
const SESSION_TOKEN: CredentialSpec = { flag: '--aws-session-token', env: 'AWS_SESSION_TOKEN', label: 'the session token of temporary credentials', required: false, secret: true };
const PROFILE: CredentialSpec = { flag: '--aws-profile', env: 'AWS_PROFILE', label: 'a profile with static keys in ~/.aws/credentials', required: false };
const USERS_FILE: CredentialSpec = { flag: '--cognito-users-file', env: 'COGNITO_USERS_FILE', label: '`aws cognito-idp list-users --output json` output', required: false };
const CLIENT_ID: CredentialSpec = { flag: '--cognito-client-id', env: 'COGNITO_CLIENT_ID', label: 'the app client id (the ID token audience; for lazy migration a client without a secret that allows USER_PASSWORD_AUTH)', required: false };
const MFA: CredentialSpec = { flag: '--cognito-mfa', env: 'COGNITO_EXPORT_MFA', label: 'true to read every user\'s MFA settings (one AdminGetUser per user)', required: false };
const GROUPS_AS: CredentialSpec = { flag: '--groups-as', env: 'ATLAS_MIGRATE_GROUPS_AS', label: 'how groups move: roles or skip', required: false };

/** Static keys of a profile in the shared credentials file (SSO / assume-role profiles need `aws configure export-credentials`). */
export function profileCredentials(text: string, profile: string): AwsCredentials | undefined {
  let current = '';
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[\s*(?:profile\s+)?([^\]]+?)\s*\]$/.exec(line);
    if (section) {
      current = section[1]!;
      continue;
    }
    const kv = /^([A-Za-z_]+)\s*=\s*(.*)$/.exec(line);
    if (kv && current === profile) values[kv[1]!.toLowerCase()] = kv[2]!.trim();
  }
  if (!values.aws_access_key_id || !values.aws_secret_access_key) return undefined;
  return { accessKeyId: values.aws_access_key_id, secretAccessKey: values.aws_secret_access_key, ...(values.aws_session_token ? { sessionToken: values.aws_session_token } : {}) };
}

/** AWS credentials from flags / env, else the named (or default) profile; undefined when none. */
function awsCredentials(p: PluginContext): AwsCredentials | undefined {
  const accessKeyId = p.credential(ACCESS_KEY);
  const secretAccessKey = p.credential(SECRET_KEY);
  if (accessKeyId && secretAccessKey) {
    const sessionToken = p.credential(SESSION_TOKEN);
    return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
  }
  const profile = p.credential(PROFILE) ?? 'default';
  const file = p.ctx.env.AWS_SHARED_CREDENTIALS_FILE?.trim() || join(homedir(), '.aws', 'credentials');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  return profileCredentials(text, profile);
}

function requireCredentials(p: PluginContext): AwsCredentials {
  const creds = awsCredentials(p);
  if (!creds) {
    throw new CliError(
      'Cognito: pass AWS credentials (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, plus AWS_SESSION_TOKEN for temporary ones) or a profile with static keys (AWS_PROFILE). For SSO profiles run `eval "$(aws configure export-credentials --format env)"` first.',
    );
  }
  return creds;
}

function poolOf(p: PluginContext): { poolId: string; region: string } {
  const poolId = need(p, POOL).trim();
  const region = p.credential(REGION) ?? regionOfPool(poolId);
  if (!region) throw new CliError(`Cognito: ${poolId} is not a user pool id (expected <region>_<id>, e.g. us-east-1_AbC123xyz).`);
  return { poolId, region };
}

function groupsAs(p: PluginContext): 'roles' | 'skip' {
  const raw = p.credential(GROUPS_AS) ?? 'roles';
  if (raw !== 'roles' && raw !== 'skip') throw new CliError(`Cognito: --groups-as must be roles or skip (got ${raw}).`);
  return raw;
}

export const cognitoPlugin: MigrationPlugin = {
  vendor: 'cognito',
  source: 'cognito',
  label: 'Amazon Cognito',
  help: 'Move an Amazon Cognito user pool: password policy, MFA, sign-in identifiers, app clients, identity providers, resource servers and groups as Atlas config; users (keyed by sub) with their attributes, federated links, groups and SMS / email factors; enterprise SAML / OIDC connections; a zero-logout bridge for Cognito ID tokens; lazy migration for every password (Cognito never exports hashes); and the Amplify code. AWS credentials stay on this machine.',
  config: {
    reads: 'your user pool via the Cognito API (DescribeUserPool, app clients, identity providers, resource servers, groups)',
    credentials: [POOL, REGION, ACCESS_KEY, SECRET_KEY, SESSION_TOKEN, PROFILE],
    async translate(p) {
      const { poolId, region } = poolOf(p);
      const api = new CognitoApi({ region, credentials: requireCredentials(p), fetchImpl: p.fetch });
      const snap = await vendorStep('Cognito', () => fetchCognitoConfig(api, poolId, region));
      return translateCognitoConfig(snap);
    },
  },
  export: {
    reads: 'the Cognito API (ListUsers, groups, identity providers) or `aws cognito-idp list-users` output (--cognito-users-file)',
    credentials: [POOL, REGION, ACCESS_KEY, SECRET_KEY, SESSION_TOKEN, PROFILE, USERS_FILE, MFA],
    limits: [
      'Cognito never exports password hashes (no API, no support request): every password moves by lazy migration, checked against Cognito on the user\'s first Atlas sign-in. Users who never sign in during the window reset their password.',
      'TOTP secrets and passkeys never leave Cognito: those users enrol again. SMS and email second factors move (the verified phone number / email).',
      'Users with FORCE_CHANGE_PASSWORD or RESET_REQUIRED status cannot move by lazy migration: they reset their password in Atlas.',
      'With a list-users file only users move; groups and enterprise connections need API access.',
    ],
    async run(p, writer, resume) {
      const { poolId, region } = poolOf(p);
      const usersText = localFile(p, USERS_FILE, 'text');
      const credentials = usersText ? awsCredentials(p) : requireCredentials(p);
      const set = await vendorStep('Cognito', () =>
        exportCognito({
          userPoolId: poolId,
          region,
          credentials,
          usersText,
          mfa: truthyCredential(p, MFA),
          groups: groupsAs(p),
          fetchImpl: p.fetch,
          onProgress: (m) => p.say(`  reading ${m}`),
        }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'cognito',
    vars(p, t) {
      const vars: Record<string, string> = { ...t?.bridge?.vars };
      const pool = p.credential({ ...POOL, required: false });
      if (pool) {
        vars.user_pool_id = pool.trim();
        const region = p.credential(REGION) ?? regionOfPool(pool);
        if (region) vars.region = region;
      }
      const clientId = p.credential(CLIENT_ID);
      if (clientId) vars.client_id = clientId;
      return vars;
    },
  },
  lazy: {
    preset: 'cognito',
    config(p, t) {
      const config: Record<string, string> = { ...t?.lazy?.config };
      const pool = p.credential({ ...POOL, required: false });
      if (pool) {
        config.user_pool_id = pool.trim();
        const region = p.credential(REGION) ?? regionOfPool(pool);
        if (region) config.region = region;
      }
      const clientId = p.credential(CLIENT_ID);
      if (clientId) config.client_id = clientId;
      return config;
    },
  },
  codemod: 'cognito',
};

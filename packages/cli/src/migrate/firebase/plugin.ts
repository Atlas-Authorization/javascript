import { exportFirebase, firebaseHttp, parseServiceAccount, type FirebaseHashParams } from '../export/firebase';
import { fetchFirebaseConfig, translateFirebaseConfig } from '../export/firebase-config';
import { CliError } from '../../errors';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';
import { localFile, vendorStep, writeRecordSet } from '../export/plugin-kit';

/**
 * `atlas migrate firebase` (also Google Cloud Identity Platform) — the
 * project's sign-in settings as Atlas config, its users with their Firebase
 * scrypt hashes, identities, SMS second factors and tenants through the
 * Identity Toolkit Admin API (or an auth:export file), the `firebase` bridge
 * preset (a Firebase ID token becomes an Atlas session) and the `firebase`
 * lazy-migration preset for passwords whose hashes were not exported.
 * The service-account key stays on this machine; only Google sees its signature.
 */

const PROJECT: CredentialSpec = { flag: '--firebase-project', env: 'FIREBASE_PROJECT_ID', label: 'your Firebase / Google Cloud project id', required: false };
const SERVICE_ACCOUNT: CredentialSpec = { flag: '--firebase-service-account', env: 'GOOGLE_APPLICATION_CREDENTIALS', label: 'a service-account key file (JSON) with Firebase Authentication Admin', required: false, secret: true };
const ACCESS_TOKEN: CredentialSpec = { flag: '--firebase-access-token', env: 'FIREBASE_ACCESS_TOKEN', label: 'an OAuth access token for the project (gcloud auth print-access-token)', required: false, secret: true };
const USERS_FILE: CredentialSpec = { flag: '--firebase-users-file', env: 'FIREBASE_USERS_FILE', label: 'a firebase auth:export file (JSON or CSV)', required: false };
const TENANT: CredentialSpec = { flag: '--firebase-tenant', env: 'FIREBASE_TENANT_ID', label: 'an Identity Platform tenant id, or "all" (every tenant, each as an organization)', required: false };
const ANONYMOUS: CredentialSpec = { flag: '--firebase-anonymous', env: 'FIREBASE_ANONYMOUS', label: '"include" to export anonymous users too', required: false };
const SIGNER_KEY: CredentialSpec = { flag: '--firebase-signer-key', env: 'FIREBASE_SIGNER_KEY', label: 'the password hash signer key (base64)', required: false, secret: true };
const SALT_SEPARATOR: CredentialSpec = { flag: '--firebase-salt-separator', env: 'FIREBASE_SALT_SEPARATOR', label: 'the password hash salt separator (base64)', required: false };
const ROUNDS: CredentialSpec = { flag: '--firebase-rounds', env: 'FIREBASE_ROUNDS', label: 'the password hash rounds', required: false };
const MEM_COST: CredentialSpec = { flag: '--firebase-mem-cost', env: 'FIREBASE_MEM_COST', label: 'the password hash memory cost', required: false };
const BRIDGE: CredentialSpec = { flag: '--firebase-bridge', env: 'FIREBASE_BRIDGE', label: 'what the bridge exchanges: id-token (default) or session-cookie (Admin SDK createSessionCookie)', required: false };
const COOKIE_NAME: CredentialSpec = { flag: '--firebase-cookie-name', env: 'FIREBASE_SESSION_COOKIE_NAME', label: 'the session cookie name your app sets (default session; __session is always read)', required: false };
const API_KEY: CredentialSpec = { flag: '--firebase-api-key', env: 'FIREBASE_API_KEY', label: 'the project Web API key (AIza…), for lazy migration', required: false };

/** The project id: the flag, else the service-account file's. */
function projectOf(p: PluginContext): string {
  const explicit = p.credential(PROJECT);
  if (explicit) return explicit.trim();
  const sa = localFile(p, SERVICE_ACCOUNT, 'text');
  const fromKey = sa ? parseServiceAccount(sa).project_id : undefined;
  if (fromKey) return fromKey;
  throw new CliError('Firebase: pass the project id (--set firebase-project=<id> or FIREBASE_PROJECT_ID).');
}

function hashParams(p: PluginContext): Partial<FirebaseHashParams> {
  const n = (spec: CredentialSpec) => {
    const v = p.credential(spec);
    if (v === undefined) return undefined;
    const num = Number(v);
    if (!Number.isInteger(num)) throw new CliError(`Firebase: ${spec.label} must be a whole number.`);
    return num;
  };
  const out: Partial<FirebaseHashParams> = {};
  const signer = p.credential(SIGNER_KEY);
  const sep = p.credential(SALT_SEPARATOR);
  const rounds = n(ROUNDS);
  const mem = n(MEM_COST);
  if (signer) out.signer_key = signer;
  if (sep !== undefined) out.salt_separator = sep;
  if (rounds !== undefined) out.rounds = rounds;
  if (mem !== undefined) out.mem_cost = mem;
  return out;
}

function http(p: PluginContext, projectId: string) {
  const token = p.credential(ACCESS_TOKEN);
  const sa = localFile(p, SERVICE_ACCOUNT, 'text');
  if (!token && !sa) {
    throw new CliError('Firebase: pass a service-account key file (--set firebase-service-account=<path> or GOOGLE_APPLICATION_CREDENTIALS) or an access token (FIREBASE_ACCESS_TOKEN).');
  }
  return firebaseHttp({ accessToken: token, serviceAccount: sa ? parseServiceAccount(sa) : undefined, projectId, fetchImpl: p.fetch });
}

export const firebasePlugin: MigrationPlugin = {
  vendor: 'firebase',
  source: 'firebase',
  label: 'Firebase Authentication',
  help: 'Move a Firebase Authentication or Identity Platform project: its sign-in methods, providers, MFA and password policy as Atlas config; its users with their Firebase scrypt password hashes, social / OIDC / SAML links, SMS second factors and tenants; a zero-logout bridge for Firebase ID tokens; lazy migration for any password you could not export; and the code. The service-account key stays on this machine.',
  config: {
    reads: 'your Firebase project config via the Identity Toolkit admin API',
    credentials: [PROJECT, SERVICE_ACCOUNT, ACCESS_TOKEN],
    async translate(p) {
      const projectId = projectOf(p);
      const snap = await vendorStep('Firebase', () => fetchFirebaseConfig(http(p, projectId), projectId));
      return translateFirebaseConfig(snap);
    },
  },
  export: {
    reads: 'the Identity Toolkit admin API (accounts:batchGet, tenants, SAML providers, hash parameters) or a firebase auth:export file',
    credentials: [PROJECT, SERVICE_ACCOUNT, ACCESS_TOKEN, USERS_FILE, TENANT, ANONYMOUS, SIGNER_KEY, SALT_SEPARATOR, ROUNDS, MEM_COST],
    limits: [
      'TOTP second factors cannot be exported (Firebase keeps no exportable secret): those users enrol again. SMS second factors move by phone number.',
      'Password hashes need the project\'s hash parameters: read from the project config with an owner / Firebase Authentication Admin key, or passed as flags from Console → Authentication → Users → ⋮ → Password hash parameters. Without them, passwords move by lazy migration.',
      'The auth:export file keeps ten social providers only, has no OIDC / SAML / phone links, cannot hold a tenant, and its CSV has no second factors: export through the API for those.',
      'Sessions are not exported: the firebase bridge preset exchanges a Firebase ID token (and firebase_session_cookie a session cookie) instead.',
    ],
    async run(p, writer, resume) {
      const projectId = projectOf(p);
      const usersText = localFile(p, USERS_FILE, 'text');
      const set = await vendorStep('Firebase', () =>
        exportFirebase({
          projectId,
          usersText,
          usersFileName: p.credential(USERS_FILE),
          serviceAccountJson: usersText === undefined ? localFile(p, SERVICE_ACCOUNT, 'text') : undefined,
          accessToken: usersText === undefined ? p.credential(ACCESS_TOKEN) : undefined,
          tenant: p.credential(TENANT),
          hashParams: hashParams(p),
          includeAnonymous: p.credential(ANONYMOUS) === 'include',
          fetchImpl: p.fetch,
          onProgress: (m) => p.say(`  reading ${m}`),
        }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'firebase',
    presetFor(p) {
      const mode = (p.credential(BRIDGE) ?? 'id-token').trim().toLowerCase();
      if (mode === 'session-cookie') return 'firebase_session_cookie';
      if (mode !== 'id-token') throw new CliError(`Firebase: --set firebase-bridge takes id-token or session-cookie (got ${mode}).`);
      return 'firebase';
    },
    vars(p, t) {
      const vars: Record<string, string> = { ...t?.bridge?.vars };
      const project = p.credential(PROJECT);
      if (project) vars.project_id = project.trim();
      const cookie = p.credential(COOKIE_NAME);
      if (cookie) vars.cookie_name = cookie.trim();
      return vars;
    },
  },
  lazy: {
    preset: 'firebase',
    config(p, t) {
      const config: Record<string, string> = { ...t?.lazy?.config };
      const tenant = p.credential(TENANT);
      if (tenant && tenant !== 'all') config.tenant_id = tenant;
      // The Web API key is public (it ships in the client config): it is preset config, not a secret.
      const apiKey = p.credential(API_KEY);
      if (apiKey) config.api_key = apiKey;
      return config;
    },
  },
  codemod: 'firebase',
};

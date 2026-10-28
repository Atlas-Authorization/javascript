import type { TranslationResult } from '../framework/plugin';
import { isObj, objs, str, type Obj } from './record-set';
import { addAt, jsonKeyLine } from './source-lines';
import { ConfigBuilder, clampSessionMs, socialKey } from './translate-kit';

/**
 * `atlas migrate appwrite config` — an Appwrite project's auth settings →
 * Atlas config.
 *
 * Two local sources, either or both (Appwrite's Projects API is console-only,
 * so no project key can read it — the owner's own CLI can):
 *   - `appwrite.json` (or `appwrite.config.json`) after `appwrite pull
 *     settings`: `settings.auth.methods` and `settings.auth.security`, read
 *     with file:line;
 *   - the project document (`appwrite projects get --project-id <id> --json`,
 *     Appwrite 1.x model: `authDuration`, `authLimit`, … and `oAuthProviders`),
 *     the only place the OAuth providers are listed.
 */
export interface AppwriteConfigSnapshot {
  /** The CLI config file, as text, with its path for the report. */
  file?: { path: string; text: string };
  /** The project document (Projects API / `appwrite projects get --json`). */
  project?: Obj;
  endpoint?: string;
  projectId?: string;
}

/** Appwrite auth method ids (`settings.auth.methods` keys) → Atlas strategy. */
const METHODS: Record<string, { atlas: string; note: string }> = {
  'email-password': { atlas: 'strategies.password', note: 'Email + password sign-in. Imported Appwrite hashes verify as they are and are upgraded to Argon2id.' },
  'magic-url': { atlas: 'strategies.emailLink', note: 'Magic URL sign-in becomes Atlas email links.' },
  'email-otp': { atlas: 'strategies.emailCode', note: 'Email OTP becomes Atlas email codes.' },
  phone: { atlas: 'strategies.phoneCode', note: 'Phone (SMS) OTP becomes Atlas SMS codes, sent through your Atlas SMS settings.' },
  anonymous: { atlas: 'strategies.anonymous', note: 'Anonymous sessions become Atlas anonymous users.' },
};

/** The 1.x project model's method flags, in `settings.auth.methods` terms. */
const PROJECT_METHODS: Record<string, string> = {
  authEmailPassword: 'email-password',
  authUsersAuthMagicURL: 'magic-url',
  authEmailOtp: 'email-otp',
  authPhone: 'phone',
  authAnonymous: 'anonymous',
  authInvites: 'invites',
  authJWT: 'jwt',
};

const PROJECT_SECURITY: Record<string, string> = {
  authDuration: 'duration',
  authLimit: 'limit',
  authSessionsLimit: 'sessionsLimit',
  authPasswordHistory: 'passwordHistory',
  authPasswordDictionary: 'passwordDictionary',
  authPersonalDataCheck: 'personalDataCheck',
  authSessionAlerts: 'sessionAlerts',
  authMockNumbers: 'mockNumbers',
};

export function parseAppwriteConfigFile(text: string): Obj {
  const parsed = JSON.parse(text) as unknown;
  if (!isObj(parsed)) throw new Error('appwrite.json is not a JSON object.');
  return parsed;
}

export function translateAppwriteConfig(snap: AppwriteConfigSnapshot): TranslationResult {
  const b = new ConfigBuilder();
  const fileDoc = snap.file ? parseAppwriteConfigFile(snap.file.text) : undefined;
  const settings = isObj(fileDoc?.settings) ? fileDoc.settings : {};
  const auth = isObj(settings.auth) ? settings.auth : {};
  const project = snap.project ?? {};
  const projectId = snap.projectId ?? str(fileDoc?.projectId) ?? str(project.$id);
  const filePath = snap.file?.path;

  // One view of methods and security, from the file (with lines) or the project document.
  const methods: Record<string, { on: boolean; line?: number; from: string }> = {};
  const fileMethods = isObj(auth.methods) ? auth.methods : {};
  for (const [k, v] of Object.entries(fileMethods)) {
    if (typeof v === 'boolean') methods[k] = { on: v, line: jsonKeyLine(snap.file!.text, ['settings', 'auth', 'methods', k]), from: `settings.auth.methods.${k}` };
  }
  for (const [flag, k] of Object.entries(PROJECT_METHODS)) {
    if (methods[k] || typeof project[flag] !== 'boolean') continue;
    methods[k] = { on: project[flag] as boolean, from: flag };
  }
  for (const m of objs(project.authMethods)) {
    const id = str(m.$id);
    if (id && !methods[id] && typeof m.enabled === 'boolean') methods[id] = { on: m.enabled, from: `authMethods.${id}` };
  }
  const security: Record<string, { value: unknown; line?: number; from: string }> = {};
  const fileSecurity = isObj(auth.security) ? auth.security : {};
  for (const [k, v] of Object.entries(fileSecurity)) security[k] = { value: v, line: jsonKeyLine(snap.file!.text, ['settings', 'auth', 'security', k]), from: `settings.auth.security.${k}` };
  for (const [flag, k] of Object.entries(PROJECT_SECURITY)) if (!security[k] && project[flag] !== undefined) security[k] = { value: project[flag], from: flag };

  const at = (line: number | undefined) => (line ? filePath : undefined);

  // ── sign-in methods ──
  for (const [id, m] of Object.entries(methods)) {
    const known = METHODS[id];
    if (known) {
      b.set(known.atlas, m.on);
      if (m.on) addAt(b, at(m.line), m.line, 'mapped', 'auth methods', m.from, known.note, `auth_config.${known.atlas}`);
    } else if (id === 'invites' && m.on) {
      addAt(b, at(m.line), m.line, 'mapped', 'auth methods', m.from, 'Team invites become Atlas organization invitations (pending ones are imported).', 'organizations');
    } else if (id === 'jwt' && m.on) {
      addAt(b, at(m.line), m.line, 'differs', 'auth methods', m.from, 'Appwrite JWTs (account.createJWT) are replaced by Atlas session tokens (getToken()); your backend verifies them with Atlas\'s JWKS instead of calling Appwrite.', 'session tokens');
    } else if (m.on) {
      addAt(b, at(m.line), m.line, 'manual', 'auth methods', m.from, `The Appwrite method "${id}" has no direct Atlas setting: review it.`);
    }
  }
  if (methods['email-password']?.on) {
    b.set('passwordPolicy.minLength', 8);
    b.add('mapped', 'auth methods', 'password minimum length', 'Appwrite requires 8 characters; so does Atlas.', 'auth_config.passwordPolicy.minLength');
  }

  // ── security ──
  const sec = (k: string) => security[k];
  const duration = sec('duration');
  if (duration && typeof duration.value === 'number' && duration.value > 0) {
    const ms = clampSessionMs(duration.value * 1000);
    b.set('session.absoluteMs', ms);
    addAt(b, at(duration.line), duration.line, ms === duration.value * 1000 ? 'mapped' : 'differs', 'security', duration.from, `${duration.value} s sessions${ms !== duration.value * 1000 ? ' (Appwrite defaults to one year; Atlas allows at most 90 days)' : ''}.`, 'auth_config.session.absoluteMs');
  }
  const sessions = sec('sessionsLimit');
  if (sessions && typeof sessions.value === 'number' && sessions.value > 0) {
    b.set('session.maxConcurrentSessions', sessions.value);
    addAt(b, at(sessions.line), sessions.line, 'mapped', 'security', sessions.from, `At most ${sessions.value} sessions per user (the oldest is signed out).`, 'auth_config.session.maxConcurrentSessions');
  }
  const limit = sec('limit');
  if (limit && typeof limit.value === 'number' && limit.value > 0) {
    addAt(b, at(limit.line), limit.line, 'manual', 'security', limit.from, `Appwrite caps the project at ${limit.value} users; Atlas has no user cap. Close sign-up (signUpMode "restricted") if that cap was a gate.`, 'auth_config.signUpMode');
  }
  const history = sec('passwordHistory');
  if (history && typeof history.value === 'number' && history.value > 0) {
    b.set('passwordPolicy.historyCount', history.value);
    addAt(b, at(history.line), history.line, 'mapped', 'security', history.from, `New passwords may not repeat the last ${history.value}. Atlas starts the history at the first password set in Atlas.`, 'auth_config.passwordPolicy.historyCount');
  }
  const dict = sec('passwordDictionary');
  if (dict?.value === true) {
    b.set('passwordPolicy.checkBreaches', true);
    addAt(b, at(dict.line), dict.line, 'differs', 'security', dict.from, 'Appwrite rejects the 10,000 most common passwords; Atlas rejects passwords found in breach corpora, a superset.', 'auth_config.passwordPolicy.checkBreaches');
  }
  const personal = sec('personalDataCheck');
  if (personal?.value === true) {
    b.set('passwordPolicy.rejectIdentifierSubstring', true);
    addAt(b, at(personal.line), personal.line, 'mapped', 'security', personal.from, 'Passwords may not contain the user\'s name, email or phone.', 'auth_config.passwordPolicy.rejectIdentifierSubstring');
  }
  const alerts = sec('sessionAlerts');
  if (alerts?.value === true) addAt(b, at(alerts.line), alerts.line, 'manual', 'security', alerts.from, 'New-session email alerts: enable Atlas\'s new sign-in notification email in the dashboard (Emails).');
  const mock = sec('mockNumbers');
  if (mock && Array.isArray(mock.value) && mock.value.length) {
    addAt(b, at(mock.line), mock.line, 'manual', 'security', mock.from, `${mock.value.length} mock phone number(s) with fixed OTPs: use Atlas development-instance test numbers instead; they are not copied.`);
  }
  for (const k of ['membershipsUserName', 'membershipsUserEmail', 'membershipsMfa'] as const) {
    const flag = `auth${k[0]!.toUpperCase()}${k.slice(1)}`;
    if (project[flag] === false) b.add('manual', 'memberships privacy', flag, 'Appwrite hides this member field from team members; Atlas shows members\' names and emails to their organization. Restrict with organization permissions if needed.');
  }

  // ── OAuth providers ──
  for (const p of objs(project.oAuthProviders)) {
    const key = str(p.key);
    if (!key || p.enabled !== true) continue;
    const atlas = socialKey(key);
    const appId = str(p.appId);
    if (atlas) {
      b.socialProvider({ atlasKey: atlas, vendorName: key, area: 'oauth providers', setting: `oAuthProviders.${key}`, clientId: appId });
    } else {
      b.add('manual', 'oauth providers', `oAuthProviders.${key}`, `"${key}" is not an Atlas built-in provider: add it as a custom OAuth/OIDC provider (custom_oauth_providers) with the same client id${appId ? ` (${appId})` : ''}.`, 'custom_oauth_providers');
    }
  }
  if (!snap.project && snap.file) {
    b.add('manual', 'oauth providers', 'oAuthProviders', 'appwrite.json does not list OAuth providers: pass the project document (appwrite projects get --json) to translate them, or add them in the Atlas dashboard with the same client ids.');
  }

  // ── always ──
  b.add('differs', 'sessions', 'a_session_<project> cookie', 'Appwrite sessions live on the Appwrite domain and are stored hashed: the appwrite bridge preset asks Appwrite about each live session once and swaps it for an Atlas session.', 'migrations bridge appwrite');
  b.add('differs', 'multi-factor', 'TOTP authenticators', 'Appwrite cannot export TOTP secrets: those users enrol an authenticator app again (recovery codes can be exported).', 'auth_config.mfa.factors.totp');

  const endpoint = snap.endpoint ?? str(fileDoc?.endpoint);
  const base = endpoint?.replace(/\/+$/, '');
  const ids: Record<string, string> = projectId ? { project_id: projectId } : {};
  // The bridge preset names the endpoint `endpoint_url`, the lazy preset `endpoint`.
  return b.result(filePath ?? `appwrite project ${projectId ?? ''}`.trim(), {
    bridge: { preset: 'appwrite', vars: { ...ids, ...(base ? { endpoint_url: base } : {}) } },
    lazy: { preset: 'appwrite', config: { ...ids, ...(base ? { endpoint: base } : {}) } },
  });
}

import type { TranslationResult } from '../framework/plugin';
import { isObj, objs, str, strs, type Obj } from './record-set';
import { addAt, lineAt } from './source-lines';
import { ConfigBuilder, clampSessionMs, socialKey } from './translate-kit';

/**
 * `atlas migrate pocketbase config` — a PocketBase app's auth-collection
 * options → Atlas config.
 *
 * Read from `_collections` (the data.db or its dump — the same source the
 * export reads) or from a collections export file (Settings → Export
 * collections, `pb_schema.json`), with file:line for the file. v0.23+
 * options (`passwordAuth`, `oauth2`, `mfa`, `otp`, `authToken`, `authRule`,
 * flattened onto the collection in an export file, under `options` in the
 * database) and ≤0.22 options (`allowEmailAuth`, `minPasswordLength`,
 * `onlyVerified` …) are both understood. Token secrets and OAuth client
 * secrets are never copied.
 */
export interface PocketBaseConfigSnapshot {
  /** `_collections` rows, or the collections array of an export file. */
  collections: Obj[];
  /** The export file, for file:line in the report. */
  file?: { path: string; text: string };
  /** The public PocketBase URL (bridge and lazy-migration presets). */
  url?: string;
}

export function parsePocketBaseSchema(text: string): Obj[] {
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) return objs(parsed);
  if (isObj(parsed) && Array.isArray(parsed.collections)) return objs(parsed.collections);
  throw new Error('Not a PocketBase collections export (expected a JSON array of collections).');
}

/** Options of a collection, wherever this PocketBase version keeps them. */
function optionsOf(c: Obj): Obj {
  const o = typeof c.options === 'string' ? safeJson(c.options) : c.options;
  return { ...(isObj(o) ? o : {}), ...c };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
}

export function translatePocketBaseConfig(snap: PocketBaseConfigSnapshot): TranslationResult {
  const b = new ConfigBuilder();
  const auth = snap.collections.filter((c) => str(c.type) === 'auth' && str(c.name) !== '_superusers');
  const main = auth.find((c) => str(c.name) === 'users') ?? auth[0];
  if (!main) {
    b.add('manual', 'collections', '_collections', 'No auth collection found: nothing to translate.');
    return b.result(snap.file?.path ?? 'pocketbase _collections');
  }
  const name = str(main.name)!;
  const o = optionsOf(main);
  const file = snap.file;
  // Lines are searched from the collection's own "name" key onwards.
  const start = file ? Math.max(0, file.text.search(new RegExp(`"name"\\s*:\\s*"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`))) : 0;
  const line = (...keys: string[]): number | undefined => {
    if (!file) return undefined;
    // The collection's "id" may come before "name": search the whole object for the first key.
    const from = file.text.lastIndexOf('{', start);
    let at = from < 0 ? 0 : from;
    for (const k of keys) {
      const i = file.text.indexOf(`"${k}"`, at);
      if (i < 0) return undefined;
      at = i + k.length + 2;
    }
    return lineAt(file.text, at);
  };
  const where = (...keys: string[]) => {
    const l = line(...keys);
    return { f: l ? file!.path : undefined, l };
  };
  const area = `collection ${name}`;
  const put = (status: 'mapped' | 'differs' | 'manual', keys: string[], note: string, atlas?: string) => {
    const w = where(...keys);
    addAt(b, w.f, w.l, status, area, keys.join('.'), note, atlas);
  };

  if (auth.length > 1) {
    b.add('differs', 'collections', 'auth collections', `${auth.length} auth collections (${auth.map((c) => str(c.name)).join(', ')}): Atlas has one user pool per instance. Their records are imported together, each tagged with private_metadata.pocketbase_collection; use app roles to tell them apart.`, 'users');
  }

  // ── password and identity fields ──
  const pa = isObj(o.passwordAuth) ? o.passwordAuth : undefined;
  if (pa) {
    const on = pa.enabled !== false;
    b.set('strategies.password', on);
    if (on) put('mapped', ['passwordAuth', 'enabled'], 'Password sign-in. Imported bcrypt hashes verify as they are and are upgraded to Argon2id.', 'auth_config.strategies.password');
    const fields = strs(pa.identityFields);
    if (fields.includes('username')) {
      b.set('strategies.username', true);
      put('mapped', ['passwordAuth', 'identityFields'], 'Username sign-in.', 'auth_config.strategies.username');
    }
    const other = fields.filter((f) => f !== 'email' && f !== 'username');
    if (other.length) put('manual', ['passwordAuth', 'identityFields'], `Sign-in by ${other.join(', ')} has no Atlas equivalent: those users sign in by email or username.`);
  } else if (typeof o.allowEmailAuth === 'boolean' || typeof o.allowUsernameAuth === 'boolean') {
    // ≤0.22
    const email = o.allowEmailAuth === true;
    const username = o.allowUsernameAuth === true;
    b.set('strategies.password', email || username);
    if (email || username) put('mapped', ['allowEmailAuth'], 'Password sign-in. Imported bcrypt hashes verify as they are and are upgraded to Argon2id.', 'auth_config.strategies.password');
    if (username) {
      b.set('strategies.username', true);
      put('mapped', ['allowUsernameAuth'], 'Username sign-in.', 'auth_config.strategies.username');
    }
  }
  const minPw = typeof o.minPasswordLength === 'number' ? o.minPasswordLength : passwordFieldMin(main);
  if (minPw !== undefined) {
    b.set('passwordPolicy.minLength', Math.max(8, minPw));
    put(minPw < 8 ? 'differs' : 'mapped', typeof o.minPasswordLength === 'number' ? ['minPasswordLength'] : ['fields', 'password', 'min'], minPw < 8 ? `PocketBase allows ${minPw}; Atlas requires at least 8 (existing passwords still sign in).` : `${minPw} characters minimum.`, 'auth_config.passwordPolicy.minLength');
  }
  if (o.onlyVerified === true) {
    b.set('requireEmailVerification', true);
    put('mapped', ['onlyVerified'], 'Only verified users may sign in.', 'auth_config.requireEmailVerification');
  }
  if (strs(o.onlyEmailDomains).length) put('manual', ['onlyEmailDomains'], `Sign-up limited to ${strs(o.onlyEmailDomains).join(', ')}: add these domains to the Atlas allowlist (restrictions.allowlistOnly).`, 'auth_config.restrictions');
  if (strs(o.exceptEmailDomains).length) put('manual', ['exceptEmailDomains'], `Blocked domains ${strs(o.exceptEmailDomains).join(', ')}: add them to the Atlas blocklist.`, 'blocklist');

  // ── OAuth2 ──
  const oauth = isObj(o.oauth2) ? o.oauth2 : undefined;
  if (oauth?.enabled === true || o.allowOAuth2Auth === true) {
    const providers = objs(oauth?.providers);
    for (const p of providers) {
      const pname = str(p.name);
      if (!pname) continue;
      const atlas = socialKey(pname);
      const w = where('oauth2', 'providers', pname);
      if (atlas) {
        b.socialProvider({ atlasKey: atlas, vendorName: pname, area: `${area} oauth2`, setting: `oauth2.providers.${pname}`, clientId: str(p.clientId) });
        if (w.l) Object.assign(b.report[b.report.length - 1]!, { file: w.f, line: w.l });
      } else {
        addAt(b, w.f, w.l, 'manual', `${area} oauth2`, `oauth2.providers.${pname}`, `"${pname}" is not an Atlas built-in provider: add it as a custom OAuth/OIDC provider with the same client id${str(p.clientId) ? ` (${str(p.clientId)})` : ''} and authorization / token / userinfo URLs.`, 'custom_oauth_providers');
      }
    }
    if (!providers.length) put('manual', ['allowOAuth2Auth'], 'OAuth2 is on but the providers live in the app settings (≤0.22): add each one in the Atlas dashboard with the same client id so imported links keep working.', 'oauth_providers');
    const mapped = isObj(oauth?.mappedFields) ? oauth!.mappedFields : undefined;
    if (mapped && Object.values(mapped).some((v) => str(v))) put('differs', ['oauth2', 'mappedFields'], 'PocketBase copies provider fields onto the record; Atlas fills first/last name and image from the provider profile automatically.', 'user profile');
  }

  // ── OTP and MFA ──
  const otp = isObj(o.otp) ? o.otp : undefined;
  if (otp?.enabled === true) {
    b.set('strategies.emailCode', true);
    put('mapped', ['otp', 'enabled'], 'One-time email codes become Atlas email-code sign-in.', 'auth_config.strategies.emailCode');
    if (typeof otp.duration === 'number') put('differs', ['otp', 'duration'], `Codes live ${otp.duration} s in PocketBase; set verification.emailCode.ttlMinutes (whole minutes).`, 'auth_config.verification.emailCode.ttlMinutes');
    if (typeof otp.length === 'number' && otp.length !== 6) put('differs', ['otp', 'length'], `PocketBase sends ${otp.length}-digit codes; Atlas's length is set in verification.emailCode.length.`, 'auth_config.verification.emailCode.length');
  }
  const mfa = isObj(o.mfa) ? o.mfa : undefined;
  if (mfa?.enabled === true) {
    b.set('mfaPolicy', str(mfa.rule) ? 'optional' : 'required');
    put('differs', ['mfa', 'enabled'], `PocketBase MFA asks for a second, different sign-in method (password then OTP)${str(mfa.rule) ? ` when "${str(mfa.rule)}" matches` : ''}. Atlas MFA is an enrolled second factor (authenticator app, SMS, passkey or email code): users enrol one after the move.`, 'auth_config.mfaPolicy');
  }

  // ── tokens, rules, emails ──
  const token = isObj(o.authToken) ? o.authToken : undefined;
  if (typeof token?.duration === 'number' && token.duration > 0) {
    const ms = clampSessionMs(token.duration * 1000);
    b.set('session.absoluteMs', ms);
    put(ms === token.duration * 1000 ? 'mapped' : 'differs', ['authToken', 'duration'], `Auth tokens last ${token.duration} s; Atlas sessions last as long (and refresh short-lived session tokens on their own). The token secret is not copied.`, 'auth_config.session.absoluteMs');
  }
  if (str(o.authRule)) put('manual', ['authRule'], `Sign-in is limited by the rule "${str(o.authRule)}": express it as an Atlas pre-sign-in action or restriction.`, 'actions');
  if (str(o.manageRule)) put('manual', ['manageRule'], `"${str(o.manageRule)}" may manage other users: give those users an Atlas app role with the users:write permission.`, 'roles');
  if (isObj(o.authAlert) && o.authAlert.enabled === true) put('manual', ['authAlert', 'enabled'], 'New-device sign-in alerts: enable Atlas\'s new sign-in notification email (Emails).');
  for (const tpl of ['verificationTemplate', 'resetPasswordTemplate', 'confirmEmailChangeTemplate']) {
    if (isObj(o[tpl]) && str((o[tpl] as Obj).body)) put('manual', [tpl], 'Custom email template: recreate it in Atlas Emails (Atlas variables differ).', 'email_templates');
  }

  const vars: Record<string, string> = { collection: name };
  if (snap.url) vars.url = snap.url.replace(/\/+$/, '');
  return b.result(file?.path ?? `pocketbase collection ${name}`, {
    bridge: { preset: 'pocketbase', vars: { ...vars } },
    lazy: { preset: 'pocketbase', config: { ...vars } },
  });
}

/** v0.23+ keeps the minimum length on the password field. */
function passwordFieldMin(c: Obj): number | undefined {
  const fields = typeof c.fields === 'string' ? safeJson(c.fields) : c.fields;
  const pw = objs(fields).find((f) => str(f.name) === 'password' && str(f.type) === 'password');
  return typeof pw?.min === 'number' && pw.min > 0 ? pw.min : undefined;
}


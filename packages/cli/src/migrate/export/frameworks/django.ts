import { inflateSync } from 'node:zlib';
import {
  FrameworkExport,
  bool,
  json,
  sha256Hex,
  text,
  time,
  timeMs,
  type Row,
  type Tables,
} from './tables';
import { parseAttestationObject } from './webauthn';

/**
 * Django (django.contrib.auth, django-allauth) → canonical records, from
 * `manage.py dumpdata` JSON (`[{ "model", "pk", "fields" }]`) — or the export
 * script ({@link DJANGO_EXPORT_SCRIPT}), which runs the same dump inside the
 * app and adds what only the app's own code can produce: allauth TOTP secrets
 * through the MFA adapter's `decrypt`, and the unused recovery codes.
 *
 *   auth.user (or your AUTH_USER_MODEL) → user: the `password` column verbatim
 *       (pbkdf2_sha256 / argon2 / bcrypt_sha256 / scrypt / legacy md5+sha1 —
 *       every Django hasher Atlas verifies); `!`-prefixed unusable passwords are
 *       dropped; is_active=false → banned; is_staff / is_superuser and groups →
 *       app roles
 *   account.emailaddress → every address with its verified / primary flags
 *   socialaccount.socialaccount (+ socialtoken) → identity
 *   mfa.authenticator → totp, recovery codes (script), WebAuthn passkeys
 *   sessions.session (database backend) → session (sha256 of the session key)
 */
export interface DjangoExportOptions {
  /** `app_label.model` of AUTH_USER_MODEL (detected: a model with a `password` field and `username` or `email`). */
  userModel?: string;
  /** The WebAuthn RP id allauth registered passkeys against. */
  rpId?: string;
  oauthTokens?: boolean;
  sessions?: boolean;
  /** Treat users.email as verified when allauth is absent. Default false. */
  trustEmails?: boolean;
  now?: Date;
}

interface Fixture {
  model: string;
  pk: unknown;
  fields: Row;
}

function fixtures(tables: Tables): Map<string, Fixture[]> {
  const byModel = new Map<string, Fixture[]>();
  for (const name of tables.names()) {
    for (const row of tables.rows(name)) {
      const model = text(row.model)?.toLowerCase();
      const fields = json(row.fields);
      if (!model || !fields) continue;
      const list = byModel.get(model) ?? [];
      list.push({ model, pk: row.pk, fields });
      byModel.set(model, list);
    }
  }
  return byModel;
}

export function exportDjango(tables: Tables, options: DjangoExportOptions = {}): FrameworkExport {
  const out = new FrameworkExport();
  const now = (options.now ?? new Date()).getTime();
  const fx = fixtures(tables);
  const userModel =
    options.userModel?.toLowerCase() ??
    (fx.has('auth.user')
      ? 'auth.user'
      : [...fx.keys()].find((m) => {
          const f = fx.get(m)![0]!.fields;
          return 'password' in f && ('username' in f || 'email' in f) && 'last_login' in f;
        }));
  if (!userModel || !fx.has(userModel)) {
    out.warn('No user model rows found: dump auth.user (or your AUTH_USER_MODEL) with manage.py dumpdata.');
    return out;
  }

  // Groups → app roles (permission codenames when auth.permission was dumped).
  const permissions = new Map<string, string>();
  for (const p of fx.get('auth.permission') ?? []) {
    const codename = text(p.fields.codename);
    if (codename) permissions.set(String(p.pk), codename);
  }
  const groups = new Map<string, string>();
  for (const g of fx.get('auth.group') ?? []) {
    const name = text(g.fields.name);
    if (!name) continue;
    groups.set(String(g.pk), name);
    const perms = (Array.isArray(g.fields.permissions) ? g.fields.permissions : [])
      .map((pk) => (Array.isArray(pk) ? text(pk[0]) : permissions.get(String(pk))))
      .filter((p): p is string => Boolean(p));
    out.add('role', { key: name, name, scope: 'app', permissions: perms.length ? perms : undefined });
  }

  const emails = new Map<string, Array<{ email: string; verified: boolean; primary: boolean }>>();
  for (const e of fx.get('account.emailaddress') ?? []) {
    const uid = text(e.fields.user);
    const email = text(e.fields.email)?.toLowerCase();
    if (!uid || !email) continue;
    const list = emails.get(uid) ?? [];
    list.push({ email, verified: bool(e.fields.verified), primary: bool(e.fields.primary) });
    emails.set(uid, list);
  }
  const allauth = fx.has('account.emailaddress');

  const ids = new Set<string>();
  let unusable = 0;
  for (const u of fx.get(userModel)!) {
    const id = text(u.pk);
    if (!id) continue;
    const f = u.fields;
    const email = text(f.email)?.toLowerCase();
    const list = emails.get(id) ?? (email ? [{ email, verified: options.trustEmails === true, primary: true }] : []);
    const username = text(f.username);
    if (!list.length && !username) {
      out.omit('user', 'no email or username');
      continue;
    }
    const digest = text(f.password);
    const usable = Boolean(digest) && !digest!.startsWith('!');
    if (!usable && digest) unusable++;
    const roles = (Array.isArray(f.groups) ? f.groups : [])
      .map((g) => (Array.isArray(g) ? text(g[0]) : groups.get(String(g))))
      .filter((g): g is string => Boolean(g));
    if (bool(f.is_superuser)) roles.push('superuser');
    if (bool(f.is_staff)) roles.push('staff');
    const active = f.is_active === undefined ? true : bool(f.is_active);
    ids.add(id);
    out.add('user', {
      id,
      emails: list,
      username,
      first_name: text(f.first_name),
      last_name: text(f.last_name),
      password: usable ? { algorithm: 'auto', hash: digest! } : undefined,
      roles: roles.length ? [...new Set(roles)] : undefined,
      banned: active ? undefined : true,
      ban_reason: active ? undefined : 'is_active was false in Django',
      created_at: time(f.date_joined),
      last_sign_in_at: time(f.last_login),
    });
  }
  if (unusable) out.warn(`${unusable} user(s) had an unusable password (social-only or set_unusable_password): they sign in through their identities.`);
  if (!allauth) out.warn('django-allauth email addresses were not in the dump: email verification state comes from --trust-emails.');
  for (const key of ['superuser', 'staff']) {
    const used = out.list('user').some((u) => u.roles?.includes(key));
    if (used && !out.list('role').some((r) => r.key === key)) out.add('role', { key, name: key, scope: 'app' });
  }

  // Social accounts (+ tokens).
  const tokens = new Map<string, Row>();
  for (const t of fx.get('socialaccount.socialtoken') ?? []) {
    const account = text(t.fields.account);
    if (account) tokens.set(account, t.fields);
  }
  const providers = new Set<string>();
  for (const s of fx.get('socialaccount.socialaccount') ?? []) {
    const uid = text(s.fields.user);
    const provider = text(s.fields.provider);
    const subject = text(s.fields.uid);
    if (!uid || !provider || !subject || !ids.has(uid)) {
      out.omit('identity', 'social account without a known user, provider or uid');
      continue;
    }
    providers.add(provider);
    const token = tokens.get(String(s.pk));
    const extra = json(s.fields.extra_data);
    out.add('identity', {
      user_id: uid,
      provider,
      provider_user_id: subject,
      kind: provider === 'openid_connect' || provider === 'saml' ? (provider === 'saml' ? 'saml' : 'oidc') : 'oauth',
      email: text(extra?.email),
      profile: extra,
      ...(options.oauthTokens && token
        ? { access_token: text(token.token), refresh_token: text(token.token_secret), expires_at: time(token.expires_at) }
        : {}),
    });
  }
  out.manifest.providers = [...providers].sort();

  // allauth MFA. The script's decrypted extras win over the dump's raw data.
  const extras = tables.rows('mfa_secrets');
  const extraBy = new Map(extras.map((r) => [`${text(r.authenticator_id)}`, r]));
  const rawPasskeys: Fixture[] = [];
  for (const a of fx.get('mfa.authenticator') ?? []) {
    const uid = text(a.fields.user);
    const type = text(a.fields.type);
    const data = json(a.fields.data) ?? {};
    if (!uid || !ids.has(uid)) continue;
    const extra = extraBy.get(String(a.pk));
    if (type === 'totp') {
      const secret = text(extra?.secret) ?? text(data.secret);
      if (!secret || !/^[A-Z2-7]+=*$/i.test(secret)) {
        out.omit('mfa_factor', 'TOTP secret encrypted by a custom MFA adapter: run the export script so the adapter decrypts it');
        continue;
      }
      out.add('mfa_factor', { user_id: uid, type: 'totp', secret_base32: secret.toUpperCase(), digits: 6, period: 30, algorithm: 'SHA1', verified: true, created_at: time(a.fields.created_at) });
    } else if (type === 'recovery_codes') {
      const codes = Array.isArray(extra?.codes) ? (extra!.codes as unknown[]).map(String) : [];
      if (!codes.length) {
        out.omit('mfa_factor', 'recovery codes are derived from an encrypted seed: run the export script to carry the unused ones');
        continue;
      }
      out.add('mfa_factor', { user_id: uid, type: 'backup_codes', backup_codes: codes });
    } else if (type === 'webauthn') {
      rawPasskeys.push(a);
    }
  }
  if (rawPasskeys.length && !options.rpId) {
    out.omit('passkey', 'no RP id given (--rp-id): a passkey only works on the domain it was registered for', rawPasskeys.length);
  }
  for (const a of options.rpId ? rawPasskeys : []) {
    const data = json(a.fields.data) ?? {};
    const credential = json(data.credential);
    const response = json(credential?.response);
    const parsed = typeof response?.attestationObject === 'string' ? parseAttestationObject(response.attestationObject) : null;
    if (!parsed) {
      out.omit('passkey', 'WebAuthn authenticator whose registration response could not be read');
      continue;
    }
    out.add('passkey', {
      user_id: text(a.fields.user)!,
      credential_id: parsed.credentialId.toString('base64url'),
      public_key: parsed.publicKey.toString('base64url'),
      sign_count: parsed.signCount,
      aaguid: parsed.aaguid,
      backed_up: parsed.backedUp,
      transports: Array.isArray(response?.transports) ? (response!.transports as unknown[]).map(String) : undefined,
      rp_id: options.rpId!,
      name: text(data.name),
      created_at: time(a.fields.created_at),
    });
  }
  if (options.rpId) out.manifest.rpId = options.rpId;

  // Database-backed sessions.
  if (options.sessions !== false) {
    for (const s of fx.get('sessions.session') ?? []) {
      const key = text(s.pk);
      const expires = timeMs(s.fields.expire_date);
      const data = decodeSessionData(String(s.fields.session_data ?? ''));
      const uid = text(data?._auth_user_id);
      if (!key || expires === undefined || !data) {
        out.omit('session', 'session row that could not be decoded');
        continue;
      }
      if (!uid) {
        out.omit('session', 'anonymous session');
        continue;
      }
      if (!ids.has(uid)) {
        out.omit('session', 'session of a user not in the export');
        continue;
      }
      if (expires <= now) {
        out.omit('session', 'expired');
        continue;
      }
      out.add('session', { id: sha256Hex(key).slice(0, 32), user_id: uid, token_hash: sha256Hex(key), expires_at: new Date(expires).toISOString() });
    }
  }
  out.manifest.settings = { session_cookie: 'sessionid' };
  return out;
}

/**
 * Decode `django_session.session_data` without the SECRET_KEY (the rows come
 * from the app's own database): Django ≥ 3.1 `signing.dumps` (`payload:ts:sig`,
 * payload zlib-compressed when it starts with `.`), and the pre-3.1 form,
 * base64(`<hash>:<json>`).
 */
export function decodeSessionData(raw: string): Row | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    if (value.split(':').length === 3) {
      const payload = value.split(':')[0]!;
      const compressed = payload.startsWith('.');
      const bytes = Buffer.from(compressed ? payload.slice(1) : payload, 'base64url');
      const parsed = JSON.parse((compressed ? inflateSync(bytes) : bytes).toString('utf8')) as unknown;
      return json(parsed) ?? null;
    }
    const legacy = Buffer.from(value, 'base64').toString('utf8');
    const colon = legacy.indexOf(':');
    if (colon < 0) return null;
    return json(legacy.slice(colon + 1)) ?? null;
  } catch {
    return null;
  }
}

/**
 * The export script, run inside the Django app so allauth's own code decrypts
 * TOTP secrets and lists the unused recovery codes; it streams NDJSON straight
 * into the CLI:
 *
 *   python manage.py shell < atlas_export.py | npx atlas migrate django export --file -
 */
export const DJANGO_EXPORT_SCRIPT = `# Atlas export for a Django app (django.contrib.auth + django-allauth).
import io, json, sys
from django.apps import apps
from django.conf import settings
from django.core.management import call_command

def emit(table, row):
    sys.stdout.write(json.dumps({"table": table, "row": row}, default=str) + "\\n")

labels = [settings.AUTH_USER_MODEL, "auth.group", "auth.permission"]
for label in ["account.emailaddress", "socialaccount.socialaccount", "socialaccount.socialtoken", "mfa.authenticator", "sessions.session"]:
    try:
        apps.get_model(label)
        labels.append(label)
    except (LookupError, ValueError):
        pass

buf = io.StringIO()
call_command("dumpdata", *labels, format="json", stdout=buf)
for obj in json.loads(buf.getvalue()):
    emit("dumpdata", obj)

try:
    from allauth.mfa.models import Authenticator
    from allauth.mfa.adapter import get_adapter
except ImportError:
    Authenticator = None

if Authenticator is not None:
    try:
        from allauth.mfa.recovery_codes.internal.auth import RecoveryCodes
    except ImportError:
        try:
            from allauth.mfa.recovery_codes import RecoveryCodes
        except ImportError:
            RecoveryCodes = None
    adapter = get_adapter()
    for a in Authenticator.objects.all():
        if a.type == "totp":
            emit("mfa_secrets", {"authenticator_id": a.pk, "secret": adapter.decrypt(a.data["secret"])})
        elif a.type == "recovery_codes" and RecoveryCodes is not None:
            emit("mfa_secrets", {"authenticator_id": a.pk, "codes": RecoveryCodes(a).get_unused_codes()})
`;

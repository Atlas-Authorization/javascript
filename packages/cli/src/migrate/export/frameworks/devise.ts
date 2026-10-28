import {
  FrameworkExport,
  bool,
  col,
  sha256Hex,
  splitName,
  text,
  time,
  timeMs,
  type Tables,
} from './tables';

/**
 * Devise (Rails) → canonical records, from the rows the Rails runner script
 * ({@link DEVISE_EXPORT_SCRIPT}) streams out of the app with its own models —
 * so attributes Rails encrypts (devise-two-factor's `otp_secret` under Active
 * Record encryption or attr_encrypted) arrive decrypted, and the Devise config
 * (pepper, stretches, the modules each model enables) comes along.
 *
 *   users            → user: email + confirmable (`confirmed_at`), the bcrypt
 *                      `encrypted_password` (with `config.pepper` when set),
 *                      lockable (`locked_at`), trackable timestamps
 *   omniauth         → identity: `provider`/`uid` on users, or an
 *                      `identities` / `authentications` table
 *   devise-two-factor → mfa_factor totp (`otp_secret`) + backup codes (their
 *                      Devise-bcrypt digests, verified like passwords)
 *   rolify / `admin`  → app roles
 *   activerecord-session_store → session (the cookie store has no rows: the
 *                      bridge decrypts the `_<app>_session` cookie instead)
 *
 * devise-encryptable digests (sha1 / sha512 / authlogic / restful_authentication)
 * are not carried: those users reset their password or migrate lazily.
 */
export interface DeviseExportOptions {
  /** The Warden scope / model table (default `users`). */
  usersTable?: string;
  /** Treat emails as verified when the model does not use :confirmable. Default false. */
  trustUnconfirmable?: boolean;
  sessions?: boolean;
  now?: Date;
}

export function exportDevise(tables: Tables, options: DeviseExportOptions = {}): FrameworkExport {
  const out = new FrameworkExport();
  const now = (options.now ?? new Date()).getTime();
  const config = tables.rows('devise_config')[0] ?? {};
  const pepper = text(config.pepper);
  const modules = new Set(String(config.modules ?? '').split(/[\s,]+/).filter(Boolean));
  const confirmable = modules.size ? modules.has('confirmable') : undefined;
  out.manifest.sourceVersion = text(config.devise_version) ? `devise ${text(config.devise_version)}` : 'devise';
  if (pepper) out.manifest.settings = { pepper_set: true };

  const users = tables.find(...(options.usersTable ? [options.usersTable] : ['users', 'user', 'accounts', 'admins']));
  if (!users) {
    out.warn('No users rows found (run the Rails export script with your Devise model).');
    return out;
  }
  const ids = new Set<string>();
  const providers = new Set<string>();
  let encryptable = 0;
  let mfa = 0;
  for (const row of users.rows) {
    const id = text(col(row, 'id'));
    const email = text(col(row, 'email'))?.toLowerCase();
    if (!id || !email) {
      out.omit('user', 'row without an id or email');
      continue;
    }
    const encrypted = text(col(row, 'encrypted_password'));
    let password: { algorithm: string; hash: string; params?: Record<string, string> } | undefined;
    if (encrypted && /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(encrypted)) {
      password = pepper ? { algorithm: 'bcrypt_pepper', hash: encrypted, params: { pepper } } : { algorithm: 'bcrypt', hash: encrypted };
    } else if (encrypted) encryptable++;
    const confirmedAt = col(row, 'confirmed_at');
    const verified = confirmable === false || (confirmable === undefined && !('confirmed_at' in row))
      ? options.trustUnconfirmable === true
      : Boolean(confirmedAt);
    const name = text(col(row, 'name', 'full_name'));
    const roles = new Set<string>();
    if (bool(col(row, 'admin', 'is_admin'))) roles.add('admin');
    const role = text(col(row, 'role'));
    if (role) roles.add(role);
    ids.add(id);
    out.add('user', {
      id,
      emails: [{ email, verified, primary: true }],
      username: text(col(row, 'username')),
      name,
      first_name: text(col(row, 'first_name')) ?? splitName(name).first_name,
      last_name: text(col(row, 'last_name')) ?? splitName(name).last_name,
      password,
      locked: Boolean(col(row, 'locked_at')) || undefined,
      roles: roles.size ? [...roles] : undefined,
      created_at: time(col(row, 'created_at')),
      last_sign_in_at: time(col(row, 'current_sign_in_at', 'last_sign_in_at')),
      private_metadata: text(col(row, 'unconfirmed_email')) ? { unconfirmed_email: text(col(row, 'unconfirmed_email')) } : undefined,
    });
    // omniauth's single-provider convention: provider + uid columns on the user.
    const provider = text(col(row, 'provider'));
    const uid = text(col(row, 'uid'));
    if (provider && uid && provider !== 'email') {
      providers.add(provider);
      out.add('identity', { user_id: id, provider, provider_user_id: uid, kind: 'oauth' });
    }
    // devise-two-factor.
    const secret = text(col(row, 'otp_secret'));
    if (secret && (bool(col(row, 'otp_required_for_login')) || !('otp_required_for_login' in row))) {
      mfa++;
      out.add('mfa_factor', { user_id: id, type: 'totp', secret_base32: secret.toUpperCase(), digits: 6, period: 30, algorithm: 'SHA1', verified: true });
      const codes = backupCodes(col(row, 'otp_backup_codes'));
      if (codes.length) {
        out.add('mfa_factor', {
          user_id: id,
          type: 'backup_codes',
          backup_code_hashes: codes.map((hash) =>
            pepper ? { algorithm: 'bcrypt_pepper', hash, params: { pepper } } : { algorithm: 'bcrypt', hash },
          ),
        });
      }
    }
  }
  if (encryptable) out.warn(`${encryptable} encrypted_password value(s) are not bcrypt (devise-encryptable): those users reset their password or migrate lazily.`);
  if (mfa) out.warn(`${mfa} devise-two-factor TOTP secret(s) carried over; authenticator apps keep working.`);

  for (const row of tables.rows('identities', 'authentications', 'user_identities', 'omniauth_identities')) {
    const userId = text(col(row, 'user_id'));
    const provider = text(col(row, 'provider'));
    const uid = text(col(row, 'uid', 'provider_uid'));
    if (!userId || !provider || !uid || !ids.has(userId)) {
      out.omit('identity', 'identity row without a known user, provider or uid');
      continue;
    }
    providers.add(provider);
    out.add('identity', { user_id: userId, provider, provider_user_id: uid, kind: 'oauth', email: text(col(row, 'email')) });
  }
  out.manifest.providers = [...providers].sort();

  // rolify: roles(id, name, resource_type, resource_id) + users_roles(user_id, role_id). Global roles only.
  const roleNames = new Map<string, string>();
  for (const r of tables.rows('roles')) {
    const rid = text(col(r, 'id'));
    const name = text(col(r, 'name'));
    if (rid && name && !text(col(r, 'resource_type'))) roleNames.set(rid, name);
  }
  if (roleNames.size) {
    for (const name of new Set(roleNames.values())) out.add('role', { key: name, name, scope: 'app' });
    const extra = new Map<string, Set<string>>();
    for (const ur of tables.rows('users_roles')) {
      const uid = text(col(ur, 'user_id'));
      const name = roleNames.get(text(col(ur, 'role_id')) ?? '');
      if (!uid || !name || !ids.has(uid)) continue;
      const set = extra.get(uid) ?? new Set<string>();
      set.add(name);
      extra.set(uid, set);
    }
    for (const user of out.list('user')) {
      const more = extra.get(user.id);
      if (more) user.roles = [...new Set([...(user.roles ?? []), ...more])];
    }
    const scoped = tables.rows('roles').length - roleNames.size;
    if (scoped > 0) out.warn(`${scoped} rolify role(s) scoped to a resource were not carried: model them as Atlas organization roles or permissions.`);
  }

  // activerecord-session_store rows, as the export script decoded them.
  if (options.sessions !== false) {
    for (const row of tables.rows('sessions')) {
      const raw = text(col(row, 'session_id'));
      const userId = text(col(row, 'user_id'));
      const updated = timeMs(col(row, 'expires_at')) ?? (timeMs(col(row, 'updated_at')) !== undefined ? timeMs(col(row, 'updated_at'))! + Number(config.session_ttl_seconds ?? 1209600) * 1000 : undefined);
      if (!raw || !userId || !ids.has(userId) || updated === undefined) {
        out.omit('session', 'session row without an id, a known user or an expiry');
        continue;
      }
      if (updated <= now) {
        out.omit('session', 'expired');
        continue;
      }
      // Rack stores the PRIVATE id `2::<sha256 hex of the cookie's public id>`.
      const tokenHash = /^2::[0-9a-f]{64}$/.test(raw) ? raw.slice(3) : sha256Hex(raw);
      out.add('session', { id: tokenHash.slice(0, 32), user_id: userId, token_hash: tokenHash, expires_at: new Date(updated).toISOString() });
    }
  }
  out.manifest.settings = {
    ...(out.manifest.settings ?? {}),
    session_store: text(config.session_store) ?? 'cookie_store',
    session_cookie: text(config.session_key) ?? null,
  };
  return out;
}

function backupCodes(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? (v.trim().startsWith('[') ? (JSON.parse(v) as unknown[]) : v.replace(/^\{|\}$/g, '').split(',')) : [];
  return list
    .map((c) => String(c).replace(/^"|"$/g, '').trim())
    .filter((c) => /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(c));
}

/**
 * The Rails runner script that streams a Devise app's rows as NDJSON
 * (`{"table": …, "row": {…}}`), straight into `atlas migrate export devise
 * --file -`, so decrypted secrets only ever travel through the pipe:
 *
 *   bin/rails runner atlas_export.rb | npx atlas migrate devise export --file -
 */
export const DEVISE_EXPORT_SCRIPT = `# Atlas export for a Devise app. Run: bin/rails runner atlas_export.rb [ModelName]
require "json"

model = (ARGV[0] || "User").constantize
emit = ->(table, row) { $stdout.puts({ table: table, row: row }.to_json) }

session_key = Rails.application.config.session_options[:key] rescue nil
emit.call("devise_config", {
  devise_version: Devise::VERSION,
  pepper: Devise.pepper,
  stretches: Devise.stretches,
  modules: model.devise_modules.join(","),
  session_store: Rails.application.config.session_store.to_s.demodulize.underscore,
  session_key: session_key,
  session_ttl_seconds: (Rails.application.config.session_options[:expire_after] || 1209600).to_i,
})

attrs = model.column_names - %w[encrypted_otp_secret encrypted_otp_secret_iv encrypted_otp_secret_salt]
model.find_each(batch_size: 1000) do |u|
  row = attrs.index_with { |c| u.read_attribute(c) }
  # devise-two-factor: read the secret through the model so Rails decrypts it.
  row["otp_secret"] = u.otp_secret if u.respond_to?(:otp_secret)
  emit.call(model.table_name, row)
end

%w[Identity Authentication].each do |name|
  next unless Object.const_defined?(name)
  klass = name.constantize
  next unless klass < ActiveRecord::Base
  klass.find_each { |i| emit.call(klass.table_name, i.attributes.slice("user_id", "provider", "uid", "email")) }
end

if Object.const_defined?(:Role) && ActiveRecord::Base.connection.table_exists?("users_roles")
  Role.find_each { |r| emit.call("roles", r.attributes.slice("id", "name", "resource_type", "resource_id")) }
  ActiveRecord::Base.connection.select_all("SELECT user_id, role_id FROM users_roles").each { |r| emit.call("users_roles", r) }
end

if defined?(ActiveRecord::SessionStore::Session)
  scope = "warden.user.#{Devise::Mapping.find_scope!(model)}.key"
  ActiveRecord::SessionStore::Session.find_each do |s|
    entry = s.data[scope] rescue nil
    next unless entry
    emit.call("sessions", { session_id: s.session_id, user_id: Array(entry[0]).first, updated_at: s.updated_at })
  end
end
`;


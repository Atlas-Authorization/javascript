import { resolve } from 'node:path';
import { str } from '../../args';
import { CliError } from '../../errors';
import { mapLdif, parseLdif } from '../export/ldap';
import { writeRecordSet } from '../export/plugin-kit';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';

/**
 * `atlas migrate ldap export --file dir.ldif` — an LDAP directory (OpenLDAP,
 * 389 DS, PingDirectory, Oracle/Sun DS, Active Directory) from an LDIF export
 * made with the directory's own tools. Users keep a password hash Atlas can
 * verify; the rest move by lazy migration (the `ldap` preset binds to the
 * directory over ldaps:// on the user's first sign-in).
 */

const GROUPS: CredentialSpec = { flag: 'ldap-groups', env: 'LDAP_GROUPS', label: 'what groups become: roles (default), organizations or none', required: false };
const ID_ATTRIBUTE: CredentialSpec = { flag: 'ldap-id-attribute', env: 'LDAP_ID_ATTRIBUTE', label: 'the attribute used as the user id (entryUUID, nsUniqueId, objectGUID …)', required: false };
const URL_SPEC: CredentialSpec = { flag: 'ldap-url', env: 'LDAP_URL', label: 'the directory URL for lazy migration (ldaps://ldap.example.com:636)', required: false };
const BIND_DN: CredentialSpec = { flag: 'ldap-bind-dn', env: 'LDAP_BIND_DN', label: 'the service account DN for lazy migration', required: false };
const BASE_DN: CredentialSpec = { flag: 'ldap-base-dn', env: 'LDAP_BASE_DN', label: 'the search base for lazy migration', required: false };
const FILTER: CredentialSpec = { flag: 'ldap-user-filter', env: 'LDAP_USER_FILTER', label: 'the user search filter with {{username}}', required: false };
const TRUST: CredentialSpec = { flag: 'ldap-trust-emails', env: 'LDAP_TRUST_EMAILS', label: 'mark directory addresses verified (true or false)', required: false };

function file(p: PluginContext): string {
  return str(p.args.values, 'file') ?? p.credential({ flag: 'file', env: 'ATLAS_MIGRATE_FILE', label: 'the LDIF file (--file)', required: true })!;
}

export const ldapPlugin: MigrationPlugin = {
  vendor: 'ldap',
  source: 'ldap',
  label: 'LDAP / Active Directory',
  help: 'Move a directory: users (mail, uid, names, phones, disabled and locked state, creation and last login), groups as roles or organizations, and every userPassword hash Atlas verifies ({SSHA}, {SMD5}, {PBKDF2-*}, {CRYPT}$6$…, bcrypt, Argon2, …). Export the directory as LDIF first (slapcat, ldifde, export-ldif, dsctl db2ldif); the file is read on this machine. Passwords Atlas cannot verify (Active Directory, DES crypt, pass-through) move by lazy migration against your directory over ldaps://.',
  export: {
    reads: 'a local LDIF export of the directory (--file)',
    credentials: [GROUPS, ID_ATTRIBUTE, TRUST],
    limits: [
      'Active Directory never exports password hashes (unicodePwd is write-only): configure lazy migration (preset ldap) so each user moves on their first sign-in.',
      'Traditional DES {CRYPT} and pass-through schemes ({SASL}) cannot be verified by Atlas: those users move by lazy migration.',
      'Directory addresses were set by administrators, not confirmed by the users: they import unverified unless --set ldap-trust-emails=true.',
    ],
    async run(p, writer, resume) {
      const path = resolve(file(p));
      const { entries, problems } = parseLdif(p.ctx.readFile(path));
      if (!entries.length) throw new CliError(`No entries found in ${path}: is it an LDIF export?`);
      const mode = p.credential(GROUPS) ?? 'roles';
      if (!['roles', 'organizations', 'none'].includes(mode)) throw new CliError('--set ldap-groups must be roles, organizations or none.');
      const set = mapLdif(entries, {
        groups: mode as 'roles' | 'organizations' | 'none',
        idAttribute: p.credential(ID_ATTRIBUTE),
        trustEmails: p.credential(TRUST) === 'true',
        origin: `LDIF export ${path}`,
      });
      for (const problem of problems.slice(0, 20)) set.warn(`LDIF: ${problem}`);
      p.say(`  read ${entries.length} entries from ${path}`);
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  lazy: {
    preset: 'ldap',
    config(p) {
      const config: Record<string, string> = {};
      for (const [key, spec] of [['url', URL_SPEC], ['bind_dn', BIND_DN], ['base_dn', BASE_DN], ['user_filter', FILTER], ['id_attribute', ID_ATTRIBUTE]] as const) {
        const v = p.credential(spec);
        if (v) config[key] = v;
      }
      return config;
    },
    secret: { flag: 'ldap-bind-password', env: 'LDAP_BIND_PASSWORD', label: 'the service account password', required: false, secret: true },
  },
};

import type { EmailAddress, PhoneNumber, UserRecord } from '@atlasauth/migrate';
import { detectPasswordHash } from './password-detect';
import { RecordSet, compact, e164 } from './record-set';
import { keyOf } from './translate-kit';

/**
 * `atlas migrate ldap export` — a directory's users and groups from an LDIF
 * export (RFC 2849), as the directory's own tools write it:
 *
 *   OpenLDAP      slapcat -n 1 > dir.ldif   (or ldapsearch -LLL … '*' '+')
 *   389 DS        dsctl <instance> db2ldif userroot
 *   PingDirectory export-ldif --backendID userRoot --ldifFile dir.ldif
 *   Oracle / Sun  export-ldif / db2ldif
 *   Active Dir.   ldifde -f dir.ldif -d "dc=corp,dc=example" -p subtree
 *
 * Users keep their password when `userPassword` holds a hash Atlas verifies
 * (`{SSHA*}`, `{PBKDF2-*}`, `{CRYPT}$6$…`, bcrypt, …). Active Directory never
 * exports one (unicodePwd is write-only), and pass-through schemes (`{SASL}`)
 * or DES `{CRYPT}` cannot be checked: those users move with lazy migration
 * (the `ldap` preset binds to the directory on their first sign-in).
 *
 * Groups (groupOfNames, groupOfUniqueNames, posixGroup, AD group) become app
 * roles, or organizations with members (`--set ldap-groups=organizations`).
 */

// ── LDIF ────────────────────────────────────────────────────────────────────

export interface LdifEntry {
  dn: string;
  /** Lower-cased attribute name (options such as `;binary` dropped) → values. Binary values are base64 strings. */
  attrs: Map<string, string[]>;
  /** The line the entry starts on (1-based), for messages. */
  line: number;
}

/** Text vs. binary: an `attr::` value that is not valid UTF-8 (objectGUID) stays base64. */
function decodeBase64Value(b64: string): { text: string; binary: boolean } {
  const bytes = Buffer.from(b64, 'base64');
  const text = bytes.toString('utf8');
  // eslint-disable-next-line no-control-regex -- intentionally detects control characters (binary input)
  const binary = text.includes('�') || /[\x00-\x08\x0E-\x1F]/.test(text);
  return binary ? { text: bytes.toString('base64'), binary: true } : { text, binary: false };
}

/**
 * Parse LDIF content records. Change records other than `add` are skipped;
 * comments and folded lines are handled; a malformed line is reported, not fatal.
 */
export function parseLdif(text: string): { entries: LdifEntry[]; problems: string[] } {
  const entries: LdifEntry[] = [];
  const problems: string[] = [];
  const raw = text.replace(/^\ufeff/, '').split(/\r?\n/);
  // Unfold: a line starting with exactly one space continues the previous one.
  const lines: Array<{ text: string; no: number }> = [];
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i]!;
    if (l.startsWith(' ') && lines.length && lines[lines.length - 1]!.text !== '') {
      lines[lines.length - 1]!.text += l.slice(1);
    } else lines.push({ text: l, no: i + 1 });
  }
  let current: LdifEntry | null = null;
  let skip = false;
  const flush = () => {
    if (current && !skip) entries.push(current);
    current = null;
    skip = false;
  };
  for (const { text: l, no } of lines) {
    if (l === '') {
      flush();
      continue;
    }
    if (l.startsWith('#')) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9;.-]*)(::?|:<)\s?(.*)$/.exec(l);
    if (!m) {
      problems.push(`line ${no}: not an LDIF attribute line`);
      continue;
    }
    const name = m[1]!.toLowerCase();
    const sep = m[2]!;
    let value = m[3]!;
    if (sep === ':<') continue; // a URL reference: never fetched
    if (sep === '::') value = decodeBase64Value(value.trim()).text;
    if (name === 'version' && !current) continue;
    if (name === 'dn') {
      flush();
      current = { dn: value.trim(), attrs: new Map(), line: no };
      continue;
    }
    if (!current) {
      problems.push(`line ${no}: attribute before any dn`);
      continue;
    }
    if (name === 'changetype') {
      if (value.trim().toLowerCase() !== 'add') skip = true;
      continue;
    }
    const base = name.split(';')[0]!;
    const list = current.attrs.get(base) ?? [];
    list.push(value);
    current.attrs.set(base, list);
  }
  flush();
  return { entries, problems };
}

// ── mapping ─────────────────────────────────────────────────────────────────

export interface LdapExportOptions {
  /** `roles` (default) or `organizations`. */
  groups?: 'roles' | 'organizations' | 'none';
  /** The attribute used as the user id (default: entryUUID, nsUniqueId, objectGUID, ibm-entryUUID, orclGUID, then the DN). */
  idAttribute?: string;
  /** Directory addresses are set by administrators: mark them verified (default false). */
  trustEmails?: boolean;
  /** Where the LDIF came from (shown in the dashboard). */
  origin?: string;
}

const PERSON = new Set(['inetorgperson', 'person', 'organizationalperson', 'posixaccount', 'user', 'account', 'shadowaccount', 'residentialperson', 'ds-cfg-root-dn-user']);
const GROUP = new Set(['groupofnames', 'groupofuniquenames', 'posixgroup', 'group', 'groupofurls', 'groupofentries']);
const ID_ATTRIBUTES = ['entryuuid', 'nsuniqueid', 'objectguid', 'ibm-entryuuid', 'orclguid', 'guid'];
const METADATA_ATTRIBUTES = ['title', 'departmentnumber', 'department', 'employeenumber', 'employeeid', 'employeetype', 'o', 'ou', 'l', 'manager', 'company', 'preferredlanguage', 'uidnumber', 'gidnumber', 'homedirectory', 'loginshell', 'userprincipalname'];

const one = (e: LdifEntry, name: string): string | undefined => {
  const v = e.attrs.get(name)?.[0]?.trim();
  return v ? v : undefined;
};
const all = (e: LdifEntry, name: string): string[] => (e.attrs.get(name) ?? []).map((v) => v.trim()).filter(Boolean);
const classes = (e: LdifEntry) => new Set(all(e, 'objectclass').map((c) => c.toLowerCase()));

/** Canonical DN for matching member values (case and spacing around `,`/`=` vary). */
export function normalizeDn(dn: string): string {
  return dn
    .split(/(?<!\\),/)
    .map((rdn) => rdn.split('=').map((p) => p.trim()).join('=').toLowerCase())
    .join(',');
}

/** AD objectGUID (base64 of the little-endian GUID) → the textual GUID. */
export function guidFromBase64(b64: string): string | undefined {
  const b = Buffer.from(b64, 'base64');
  if (b.length !== 16) return undefined;
  const hex = (i: number, n: number, le: boolean) => {
    const part = Buffer.from(b.subarray(i, i + n));
    if (le) part.reverse();
    return part.toString('hex');
  };
  return `${hex(0, 4, true)}-${hex(4, 2, true)}-${hex(6, 2, true)}-${hex(8, 2, false)}-${hex(10, 6, false)}`;
}

/** LDAP GeneralizedTime (`20240102030405Z`, `20240102030405.0Z`, `…+0100`) → ISO-8601. */
export function generalizedTime(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})?(\d{2})?(?:[.,]\d+)?(Z|[+-]\d{4})?$/.exec(v.trim());
  if (!m) return undefined;
  const tz = !m[7] || m[7] === 'Z' ? 'Z' : `${m[7].slice(0, 3)}:${m[7].slice(3)}`;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5] ?? '00'}:${m[6] ?? '00'}${tz}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** AD FILETIME (100 ns since 1601) → ISO, or undefined for 0 / never. */
function fileTime(v: string | undefined): string | undefined {
  if (!v || !/^\d+$/.test(v) || v === '0' || v === '9223372036854775807') return undefined;
  const ms = Number(BigInt(v) / 10000n) - 11644473600000;
  return ms > 0 ? new Date(ms).toISOString() : undefined;
}

function userId(e: LdifEntry, idAttribute?: string): string {
  const attrs = idAttribute ? [idAttribute.toLowerCase()] : ID_ATTRIBUTES;
  for (const a of attrs) {
    const v = one(e, a);
    if (!v) continue;
    if (a === 'objectguid') return guidFromBase64(v) ?? v;
    return v;
  }
  return e.dn;
}

/** Map a parsed LDIF onto canonical records. */
export function mapLdif(entries: LdifEntry[], options: LdapExportOptions = {}): RecordSet {
  const set = new RecordSet();
  set.manifest = { origin: options.origin ?? 'LDIF export', settings: { groups: options.groups ?? 'roles' } };
  const users: Array<{ entry: LdifEntry; record: UserRecord }> = [];
  const byDn = new Map<string, UserRecord>();
  const byUid = new Map<string, UserRecord>();
  const groups: LdifEntry[] = [];
  let ad = false;
  let noPassword = 0;
  const unusable = new Map<string, number>();

  for (const e of entries) {
    const cls = classes(e);
    if (cls.has('computer')) continue;
    if ([...cls].some((c) => GROUP.has(c))) {
      groups.push(e);
      continue;
    }
    if (![...cls].some((c) => PERSON.has(c))) continue;
    if (cls.has('user') || e.attrs.has('samaccountname')) ad = true;

    const mails = all(e, 'mail');
    const emails: EmailAddress[] = mails.filter((m) => m.includes('@')).map((m, i) => ({ email: m.toLowerCase(), verified: options.trustEmails === true, primary: i === 0 }));
    const phones: PhoneNumber[] = [];
    for (const raw of [...all(e, 'mobile'), ...all(e, 'telephonenumber')]) {
      const p = e164(raw);
      if (p && !phones.some((x) => x.phone === p)) phones.push({ phone: p, verified: false, primary: phones.length === 0 });
    }
    const username = one(e, 'uid') ?? one(e, 'samaccountname');
    const record: UserRecord = compact({
      id: userId(e, options.idAttribute),
      emails,
      phones,
      username,
      first_name: one(e, 'givenname'),
      last_name: one(e, 'sn'),
      name: one(e, 'displayname') ?? one(e, 'cn'),
      created_at: generalizedTime(one(e, 'createtimestamp') ?? one(e, 'whencreated')),
      last_sign_in_at: fileTime(one(e, 'lastlogontimestamp')) ?? generalizedTime(one(e, 'authtimestamp') ?? one(e, 'ds-pwp-last-login-time')),
      private_metadata: { ldap: compact({ dn: e.dn, ...Object.fromEntries(METADATA_ATTRIBUTES.map((a) => [a, one(e, a)])) }) },
    } as UserRecord);

    // Account state: AD userAccountControl ACCOUNTDISABLE (0x2), 389 DS / OpenLDAP nsAccountLock,
    // OpenLDAP ppolicy pwdAccountLockedTime (000001010000Z = locked by an administrator), AD lockoutTime.
    const uac = Number(one(e, 'useraccountcontrol') ?? 0);
    const lockedTime = one(e, 'pwdaccountlockedtime');
    if ((uac & 0x2) !== 0 || one(e, 'nsaccountlock')?.toLowerCase() === 'true' || lockedTime === '000001010000Z' || one(e, 'ds-pwp-account-disabled')?.toLowerCase() === 'true') {
      record.banned = true;
      record.ban_reason = 'Disabled in the directory';
    } else if (lockedTime || (one(e, 'lockouttime') && one(e, 'lockouttime') !== '0')) record.locked = true;

    const pw = one(e, 'userpassword');
    if (pw) {
      const d = detectPasswordHash(pw);
      if (d.ok) record.password = d.password;
      else unusable.set(d.reason, (unusable.get(d.reason) ?? 0) + 1);
    } else noPassword++;

    if (!record.emails?.length && !record.phones?.length && !record.username) {
      set.omit('user', 'no mail, phone or uid', 1);
      continue;
    }
    users.push({ entry: e, record });
    byDn.set(normalizeDn(e.dn), record);
    if (username) byUid.set(username.toLowerCase(), record);
  }

  // Groups: members by DN (member / uniqueMember) or by uid (posixGroup memberUid);
  // AD users also list their groups in memberOf when the groups were not exported.
  const mode = options.groups ?? 'roles';
  const seenGroups = new Map<string, { id: string; name: string; members: Set<UserRecord> }>();
  const groupFor = (dn: string, name: string, id: string) => {
    const k = normalizeDn(dn);
    let g = seenGroups.get(k);
    if (!g) seenGroups.set(k, (g = { id, name, members: new Set() }));
    return g;
  };
  for (const g of groups) {
    const name = one(g, 'cn') ?? g.dn.split(',')[0]!.replace(/^[^=]+=/, '');
    const group = groupFor(g.dn, name, one(g, 'entryuuid') ?? one(g, 'nsuniqueid') ?? (one(g, 'objectguid') ? guidFromBase64(one(g, 'objectguid')!) : undefined) ?? g.dn);
    for (const m of [...all(g, 'member'), ...all(g, 'uniquemember')]) {
      const u = byDn.get(normalizeDn(m.replace(/#'?[0-9A-Fa-f]*'?B?$/, '')));
      if (u) group.members.add(u);
    }
    for (const uid of all(g, 'memberuid')) {
      const u = byUid.get(uid.toLowerCase());
      if (u) group.members.add(u);
    }
  }
  for (const { entry, record } of users) {
    for (const dn of all(entry, 'memberof')) {
      const name = dn.split(/(?<!\\),/)[0]!.replace(/^[^=]+=/, '');
      groupFor(dn, name, dn).members.add(record);
    }
  }

  if (mode === 'roles') {
    for (const g of seenGroups.values()) {
      const key = keyOf(g.name);
      set.add('role', { key, name: g.name, scope: 'app', description: `Directory group ${g.name}` }, key);
      for (const u of g.members) u.roles = [...new Set([...(u.roles ?? []), key])];
    }
  } else if (mode === 'organizations') {
    for (const g of seenGroups.values()) {
      set.add('organization', { id: g.id, name: g.name, slug: keyOf(g.name).replace(/_/g, '-') }, g.id);
      for (const u of g.members) set.add('membership', { organization_id: g.id, user_id: u.id, role: 'member' }, `${g.id}|${u.id}`);
    }
  }

  for (const { record } of users) set.add('user', record, record.id);

  if (ad) set.warn('Active Directory never exports password hashes (unicodePwd is write-only): set up lazy migration with the ldap preset so each user moves on their first sign-in.');
  if (noPassword && !ad) set.warn(`${noPassword} user(s) have no userPassword in the export (export with operational attributes as the directory manager, or use lazy migration).`);
  for (const [reason, n] of unusable) set.warn(`${n} password(s) left out: ${reason}. Lazy migration (the ldap preset) moves those users on first sign-in.`);
  return set;
}

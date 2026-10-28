import type { PasswordHash, UserRecord } from '@atlasauth/migrate';
import { RecordSet, bag, compact, e164, isObj, objs, str, strs, type Obj } from './record-set';
import { keyOf } from './translate-kit';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate export appwrite` — an Appwrite project (Cloud or self-hosted,
 * 1.5 and later) through the Server API, with an API key the owner creates
 * (scopes `users.read`, `teams.read`; `users.write` too for recovery codes on
 * 2.x). The key is used on this machine only.
 *
 * Appwrite's Users API returns every user's hash with its algorithm and
 * options (`password`, `hash`, `hashOptions`), so passwords move as they are:
 * Argon2 and bcrypt are self-describing, MD5 and the eleven SHA variants are
 * unsalted hex, phpass keeps its `$P$`/`$H$` digest, plain scrypt carries its
 * literal N / r / p and string salt, and `scryptMod` is Firebase's modified
 * scrypt with Appwrite's fixed N=2^14, r=8.
 *
 * Teams become organizations (confirmed memberships with their roles,
 * unconfirmed ones as pending invitations), labels become app roles, prefs
 * become public metadata (list queries use the JSON syntax of 1.5+). MFA
 * recovery codes are readable (opt in); TOTP secrets are encrypted at rest
 * with no read route, so those users enrol again. Sessions are stored as hashes and cannot leave: the `appwrite` bridge
 * preset asks Appwrite about a live session instead.
 */

export interface AppwriteExportOptions {
  /** The API endpoint including /v1 (default https://cloud.appwrite.io/v1). */
  endpoint?: string;
  projectId: string;
  apiKey: string;
  /** Read each MFA user's recovery codes (`GET /users/{id}/mfa/recovery-codes`). */
  recoveryCodes?: boolean;
  /** Skip teams and memberships. */
  skipTeams?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

export const APPWRITE_CLOUD = 'https://cloud.appwrite.io/v1';
const PAGE = 100;

export async function exportAppwrite(opts: AppwriteExportOptions): Promise<RecordSet> {
  const set = new RecordSet();
  const endpoint = (opts.endpoint ?? APPWRITE_CLOUD).replace(/\/+$/, '');
  const http = new VendorHttp({
    vendor: 'Appwrite',
    baseUrl: endpoint,
    headers: { 'x-appwrite-project': opts.projectId, 'x-appwrite-key': opts.apiKey },
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
  });
  const progress = opts.onProgress ?? (() => undefined);

  progress('users');
  const users = await listAll(http, '/users', 'users');
  const ids = new Set<string>();
  const labels = new Set<string>();
  let shaGuessed = 0;
  for (const u of users) {
    const id = str(u.$id);
    if (!id) continue;
    ids.add(id);
    const user = mapUser(u);
    const pw = appwritePasswordHash(u);
    if (pw.hash) user.password = pw.hash;
    if (pw.guessed) shaGuessed++;
    if (pw.problem) set.warn(pw.problem);
    for (const l of user.roles ?? []) labels.add(l);
    set.add('user', compact(user));
  }
  for (const l of [...labels].sort()) set.add('role', { key: l, name: l, scope: 'app' }, `app:${l}`);
  if (shaGuessed) {
    set.warn(
      `${shaGuessed} SHA hash(es) were imported without a version: Appwrite 1.x checks those as SHA3-512 and 2.x as SHA-256. The export picked by digest length; a user whose hash still fails signs in through lazy migration or a reset.`,
    );
  }

  progress('identities');
  try {
    for (const i of await listAll(http, '/users/identities', 'identities')) {
      const userId = str(i.userId);
      const provider = str(i.provider);
      const providerUid = str(i.providerUid);
      if (!userId || !provider || !providerUid || !ids.has(userId)) continue;
      set.add('identity', compact({ id: str(i.$id), user_id: userId, provider, provider_user_id: providerUid, kind: 'oauth' as const, email: str(i.providerEmail)?.toLowerCase() }), `${provider}:${providerUid}`);
    }
  } catch (err) {
    // `GET /users/identities` exists from 1.5; older servers only list per user.
    if (!(err instanceof VendorApiError && [404, 400].includes(err.status))) throw err;
    set.warn('This Appwrite server has no identities listing (before 1.5): OAuth links are not exported; users relink by email on first social sign-in.');
  }

  progress('two-factor');
  let totp = 0;
  for (const u of users) {
    const id = str(u.$id);
    if (!id || u.mfa !== true) continue;
    const factors = await optionalGet<Obj>(http, `/users/${id}/mfa/factors`);
    if (!factors) continue;
    if (factors.totp === true) totp++;
    const phone = e164(u.phone);
    if (factors.phone === true && phone) set.add('mfa_factor', { user_id: id, type: 'phone', phone, verified: u.phoneVerification === true });
    if (factors.email === true && str(u.email)) set.add('mfa_factor', { user_id: id, type: 'email', verified: u.emailVerification === true });
    if (factors.recoveryCode === true && opts.recoveryCodes) {
      const codes = await optionalGet<Obj>(http, `/users/${id}/mfa/recovery-codes`);
      const list = strs(codes?.recoveryCodes);
      if (list.length) set.add('mfa_factor', { user_id: id, type: 'backup_codes', backup_codes: list, verified: true });
    }
  }
  if (totp) set.omit('mfa_factor', 'Appwrite keeps TOTP secrets encrypted with no API to read them: those users enrol an authenticator app again', totp);
  if (!opts.recoveryCodes && users.some((u) => u.mfa === true)) {
    set.warn('Recovery codes were not read: pass --set appwrite-recovery-codes=true (the API key needs users.read, or users.write on Appwrite 2.x).');
  }

  if (!opts.skipTeams) {
    progress('teams');
    const teams = await optionalList(http, '/teams', 'teams');
    const orgRoles = new Set<string>();
    for (const t of teams) {
      const teamId = str(t.$id);
      const name = str(t.name);
      if (!teamId || !name) continue;
      set.add('organization', compact({ id: teamId, name, public_metadata: bag(t.prefs), created_at: str(t.$createdAt) }));
      for (const m of await optionalList(http, `/teams/${teamId}/memberships`, 'memberships')) {
        const role = appwriteTeamRole(strs(m.roles));
        orgRoles.add(role);
        const userId = str(m.userId);
        if (m.confirm === true && userId && ids.has(userId)) {
          set.add('membership', compact({ id: str(m.$id), organization_id: teamId, user_id: userId, role, created_at: str(m.joined) ?? str(m.$createdAt) }), `${teamId}:${userId}`);
        } else if (m.confirm !== true) {
          const email = str(m.userEmail);
          const id = str(m.$id);
          if (!email || !id) {
            set.omit('invitation', 'unconfirmed membership whose email is hidden by the project\'s membership privacy settings');
            continue;
          }
          set.add('invitation', compact({ id, organization_id: teamId, email: email.toLowerCase(), role, status: 'pending' as const, created_at: str(m.invited) }));
        }
      }
    }
    for (const r of [...orgRoles].sort()) if (r !== 'admin' && r !== 'member') set.add('role', { key: r, name: r, scope: 'organization' }, `org:${r}`);
  }

  const providers = new Set(set.list('identity').map((i) => i.provider));
  set.manifest = { ...set.manifest, origin: `${endpoint} project ${opts.projectId}`, providers: [...providers].sort() };
  set.warn('Appwrite sessions are stored as hashes and cannot be exported: enable the appwrite bridge preset so signed-in users move without a new sign-in.');
  return set;
}

// ── users ───────────────────────────────────────────────────────────────────

function mapUser(u: Obj): UserRecord {
  const email = str(u.email)?.toLowerCase();
  const phone = e164(u.phone);
  const labels = strs(u.labels).map(keyOf);
  const user: UserRecord = {
    id: str(u.$id)!,
    emails: email ? [{ email, verified: u.emailVerification === true, primary: true }] : undefined,
    phones: phone ? [{ phone, verified: u.phoneVerification === true, primary: !email }] : undefined,
    name: str(u.name),
    roles: labels.length ? labels : undefined,
    banned: u.status === false ? true : undefined,
    public_metadata: bag(u.prefs),
    created_at: str(u.registration) ?? str(u.$createdAt),
    last_sign_in_at: str(u.accessedAt),
  };
  if (!email && !phone) user.anonymous = true;
  return user;
}

/** Appwrite team roles → one Atlas membership role: `owner` is the org admin, else the first custom role. */
export function appwriteTeamRole(roles: string[]): string {
  if (roles.includes('owner')) return 'admin';
  const first = roles.find((r) => r.trim());
  return first ? keyOf(first) : 'member';
}

const SHA_VERSIONS: Record<string, string> = {
  sha1: 'sha1',
  sha224: 'sha224',
  sha256: 'sha256',
  sha384: 'sha384',
  sha512: 'sha512',
  'sha512/224': 'sha512_224',
  'sha512/256': 'sha512_256',
  'sha3-224': 'sha3_224',
  'sha3-256': 'sha3_256',
  'sha3-384': 'sha3_384',
  'sha3-512': 'sha3_512',
};

/**
 * One Appwrite user's hash in the bundle's terms (see the module comment).
 * `guessed` marks a SHA hash stored without a version; `problem` is a warning
 * for a hash that cannot be carried.
 */
export function appwritePasswordHash(u: Obj): { hash?: PasswordHash; guessed?: boolean; problem?: string } {
  const digest = str(u.password);
  if (!digest) return {};
  const options = isObj(u.hashOptions) ? u.hashOptions : {};
  const type = (str(u.hash) ?? str(options.type) ?? '').toLowerCase();
  switch (type) {
    case 'argon2':
    case 'bcrypt':
      return { hash: { algorithm: 'auto', hash: digest } };
    case 'md5':
      return { hash: { algorithm: 'md5', hash: digest.toLowerCase(), params: { encoding: 'hex' } } };
    case 'sha': {
      const version = str(options.version)?.toLowerCase();
      if (version) {
        const algorithm = SHA_VERSIONS[version];
        return algorithm
          ? { hash: { algorithm, hash: digest.toLowerCase(), params: { encoding: 'hex' } } }
          : { problem: `A SHA hash with the unknown version "${version}" was left out.` };
      }
      // No version: 1.x defaults to sha3-512 (128 hex), 2.x to sha256 (64 hex).
      if (digest.length === 128) return { hash: { algorithm: 'sha3_512', hash: digest.toLowerCase(), params: { encoding: 'hex' } }, guessed: true };
      if (digest.length === 64) return { hash: { algorithm: 'sha256', hash: digest.toLowerCase(), params: { encoding: 'hex' } }, guessed: true };
      return { problem: 'A SHA hash without a version and of an unexpected length was left out.' };
    }
    case 'phpass':
      // Appwrite's phpass falls back to crypt() for bcrypt-style digests.
      return { hash: { algorithm: /^\$2[aby]\$/.test(digest) ? 'auto' : 'phpass', hash: digest } };
    case 'scrypt': {
      const salt = str(options.salt);
      if (salt === undefined) return { problem: 'A scrypt hash came back without its salt (the server did not return hashOptions.salt) and was left out; those users move by lazy migration.' };
      return {
        hash: {
          algorithm: 'scrypt',
          hash: digest.toLowerCase(),
          salt,
          params: {
            // php-scrypt: N is the literal cost (not log2), the salt string is used as is, the output is hex.
            n: num(options.costCpu, 8),
            r: num(options.costMemory, 14),
            p: num(options.costParallel, 1),
            key_length: num(options.length, 64),
            salt_encoding: 'utf8',
            encoding: 'hex',
          },
        },
      };
    }
    case 'scryptmod': {
      const signer = str(options.signerKey);
      if (!signer) return { problem: 'A scryptMod hash came back without its signer key and was left out.' };
      return {
        hash: {
          algorithm: 'scrypt_firebase',
          hash: digest,
          salt: str(options.salt) ?? '',
          // Appwrite hard-codes N=16384 (mem_cost 14), r=8, p=1.
          params: { signer_key: signer, salt_separator: str(options.saltSeparator) ?? '', rounds: 8, mem_cost: 14 },
        },
      };
    }
    default:
      return { problem: `A password hash of the unknown type "${type || 'none'}" was left out.` };
  }
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : fallback);

// ── paging ──────────────────────────────────────────────────────────────────

/** An Appwrite 1.5+ query (JSON form) for the `queries[]` parameter. */
export function appwriteQuery(method: string, values: unknown[]): string {
  return `queries[]=${encodeURIComponent(JSON.stringify({ method, values }))}`;
}

/** Every row of a list endpoint, by cursor (`cursorAfter` the last `$id`, ordered by `$id`). */
async function listAll(http: VendorHttp, path: string, key: string): Promise<Obj[]> {
  const out: Obj[] = [];
  let cursor: string | undefined;
  for (;;) {
    const q = [appwriteQuery('limit', [PAGE]), ...(cursor ? [appwriteQuery('cursorAfter', [cursor])] : [])].join('&');
    const { body } = await http.get<Obj>(`${path}${path.includes('?') ? '&' : '?'}${q}`);
    const rows = isObj(body) ? objs(body[key]) : [];
    out.push(...rows);
    const last = rows.length ? str(rows[rows.length - 1]!.$id) : undefined;
    if (rows.length < PAGE || !last) return out;
    cursor = last;
  }
}

async function optionalList(http: VendorHttp, path: string, key: string): Promise<Obj[]> {
  try {
    return await listAll(http, path, key);
  } catch (err) {
    if (err instanceof VendorApiError && [401, 403, 404].includes(err.status)) return [];
    throw err;
  }
}

async function optionalGet<T>(http: VendorHttp, path: string): Promise<T | null> {
  try {
    return (await http.get<T>(path)).body;
  } catch (err) {
    if (err instanceof VendorApiError && [400, 401, 403, 404].includes(err.status)) return null;
    throw err;
  }
}

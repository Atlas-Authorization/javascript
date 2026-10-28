import type { EmailAddress, PhoneNumber, UserRecord } from '@atlasauth/migrate';
import { RecordSet, bag, compact, e164, objs, str, type Obj } from './record-set';
import { keyOf } from './translate-kit';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate onelogin export` — a OneLogin account through API v2 with API
 * credentials (client id + secret, on this machine): users (login, email,
 * name, phone, status, custom attributes, last login) and roles (as app roles,
 * with their members).
 *
 * OneLogin never returns password hashes or MFA secrets: passwords move by lazy
 * migration (the `onelogin` preset), second factors are enrolled again.
 */

export interface OneLoginExportOptions {
  subdomain: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

/** `acme`, `acme.onelogin.com` or a URL → `acme`. */
export function oneLoginSubdomain(raw: string): string {
  const s = raw.trim().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/\.onelogin\.com$/i, '');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(s)) throw new Error(`"${raw}" is not a OneLogin subdomain.`);
  return s.toLowerCase();
}

/** OneLogin user `status` codes. */
const STATUS = { suspended: 2, locked: 3 } as const;

export async function oneLoginToken(o: Pick<OneLoginExportOptions, 'subdomain' | 'clientId' | 'clientSecret' | 'fetchImpl'>): Promise<string> {
  const f = o.fetchImpl ?? fetch;
  const res = await f(`https://${oneLoginSubdomain(o.subdomain)}.onelogin.com/auth/oauth2/v2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `client_id:${o.clientId}, client_secret:${o.clientSecret}` },
    body: JSON.stringify({ grant_type: 'client_credentials' }),
  });
  const body = (await res.json().catch(() => null)) as Obj | null;
  const token = str(body?.access_token);
  if (res.status !== 200 || !token) throw new Error(`OneLogin refused the API credentials (${res.status}).`);
  return token;
}

async function pages(http: VendorHttp, path: string): Promise<Obj[]> {
  const out: Obj[] = [];
  let cursor: string | null = null;
  do {
    const sep: string = path.includes('?') ? '&' : '?';
    const res: { body: unknown; headers: Headers } = await http.get<unknown>(cursor ? `${path}${sep}cursor=${encodeURIComponent(cursor)}` : path);
    out.push(...objs(res.body));
    cursor = res.headers.get('after-cursor') || null;
  } while (cursor);
  return out;
}

export async function exportOneLogin(o: OneLoginExportOptions): Promise<RecordSet> {
  const set = new RecordSet();
  const say = o.onProgress ?? (() => undefined);
  const sub = oneLoginSubdomain(o.subdomain);
  set.manifest = { origin: `OneLogin account ${sub}.onelogin.com` };
  const token = await oneLoginToken(o);
  const http = new VendorHttp({ vendor: 'OneLogin', baseUrl: `https://${sub}.onelogin.com`, headers: { authorization: `Bearer ${token}` }, fetchImpl: o.fetchImpl, sleep: o.sleep });

  say('roles');
  const roleKey = new Map<string, string>();
  try {
    for (const r of await pages(http, '/api/2/roles?limit=100')) {
      const id = str(r.id);
      const name = str(r.name);
      if (!id || !name) continue;
      const key = keyOf(name);
      roleKey.set(id, key);
      set.add('role', { key, name, scope: 'app' }, key);
    }
  } catch (err) {
    if (!(err instanceof VendorApiError && [401, 403, 404].includes(err.status))) throw err;
    set.warn('Roles could not be read (the API credential lacks the Read roles scope): users are imported without roles.');
  }

  say('users');
  const users = await pages(http, '/api/2/users?limit=100');
  let unactivated = 0;
  for (const u of users) {
    const id = str(u.id);
    if (!id) continue;
    const email = str(u.email)?.toLowerCase();
    const emails: EmailAddress[] = email?.includes('@') ? [{ email, verified: false, primary: true }] : [];
    const phone = e164(u.phone);
    const phones: PhoneNumber[] = phone ? [{ phone, verified: false, primary: true }] : [];
    const status = Number(u.status);
    const roles = (Array.isArray(u.role_ids) ? (u.role_ids as unknown[]).map(String) : []).map((r) => roleKey.get(r)).filter((r): r is string => !!r);
    const record: UserRecord = compact({
      id,
      emails,
      phones,
      username: str(u.username),
      first_name: str(u.firstname),
      last_name: str(u.lastname),
      created_at: str(u.created_at),
      last_sign_in_at: str(u.last_login),
      roles: [...new Set(roles)],
      private_metadata: {
        onelogin: compact({
          status,
          external_id: str(u.external_id),
          directory_id: str(u.directory_id),
          group_id: str(u.group_id),
          title: str(u.title),
          department: str(u.department),
          company: str(u.company),
          custom_attributes: bag(u.custom_attributes),
        }),
      },
    } as UserRecord);
    if (status === STATUS.suspended) {
      record.banned = true;
      record.ban_reason = 'Suspended in OneLogin';
    } else if (status === STATUS.locked) record.locked = true;
    if (status === 0) unactivated++;
    if (!record.emails?.length && !record.phones?.length && !record.username) {
      set.omit('user', 'no email, phone or username', 1);
      continue;
    }
    set.add('user', record, id);
  }

  set.omit('password', 'OneLogin never exports password hashes', users.length);
  set.warn('Addresses are imported unverified (OneLogin does not say which were confirmed). Passwords move by lazy migration (preset onelogin); users enrol their second factor again.');
  if (unactivated) set.warn(`${unactivated} user(s) never activated their OneLogin account (no password to migrate).`);
  return set;
}

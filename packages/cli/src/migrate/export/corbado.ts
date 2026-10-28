import type { UserRecord } from '@atlasauth/migrate';
import { RecordSet, compact, e164, isObj, objs, str, strs, type Obj } from './record-set';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate export corbado` — a Corbado project onto the canonical bundle
 * models, read with the project id and API secret (Backend API v2, HTTP Basic)
 * on this machine.
 *
 *   - users (`GET /v2/users`, with their email, phone and username
 *     identifiers; a `pending` identifier is unverified, `verified` and
 *     `primary` are verified); deleted users skipped, disabled users banned;
 *   - passkeys: `GET /v2/users/{id}/fullCredentials` returns each credential id
 *     AND its public key (base64url), so passkeys move and keep working. A
 *     passkey is bound to its relying-party id, which the API does not return:
 *     pass it with --corbado-rp-id (your Corbado relying party / domain), and
 *     Atlas must be served from that domain (or a subdomain of it) for the
 *     passkeys to keep working;
 *   - Corbado holds no passwords, TOTP seeds, organizations or API keys.
 *
 * Sessions are Corbado short-session JWTs, bridged by the `corbado` preset.
 */

export interface CorbadoExportOptions {
  projectId: string;
  apiSecret: string;
  /** Backend API origin (default https://backendapi.cloud.corbado.io). */
  baseUrl?: string;
  /** The passkeys' relying-party id; without it passkeys are not exported. */
  rpId?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

const PAGE = 100;
export const CORBADO_BACKEND = 'https://backendapi.cloud.corbado.io';

export function corbadoHttp(o: Pick<CorbadoExportOptions, 'projectId' | 'apiSecret' | 'baseUrl' | 'fetchImpl' | 'sleep'>): VendorHttp {
  if (!/^pro-\d+$/.test(o.projectId)) throw new Error(`Not a Corbado project id (pro-…): ${o.projectId}`);
  if (!o.apiSecret) throw new Error('Corbado needs an API secret (CORBADO_API_SECRET).');
  return new VendorHttp({
    vendor: 'Corbado',
    baseUrl: (o.baseUrl ?? CORBADO_BACKEND).replace(/\/+$/, ''),
    headers: { authorization: `Basic ${Buffer.from(`${o.projectId}:${o.apiSecret}`).toString('base64')}` },
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
  });
}

export async function exportCorbado(opts: CorbadoExportOptions): Promise<RecordSet> {
  const set = new RecordSet();
  const progress = opts.onProgress ?? (() => undefined);
  const http = corbadoHttp(opts);

  progress('users');
  const userIds: string[] = [];
  for (let page = 1; ; page++) {
    const { body } = await http.get<Obj>(`/v2/users?page=${page}&pageSize=${PAGE}&sort=%2Bcreated&includeIdentifiers=true`);
    const users = objs(body?.users);
    for (const u of users) {
      const mapped = mapCorbadoUser(u);
      if (mapped === 'deleted') {
        set.omit('user', 'deleted in Corbado');
        continue;
      }
      if (!mapped) {
        set.omit('user', 'no email, phone number or username');
        continue;
      }
      set.add('user', mapped, mapped.id);
      userIds.push(mapped.id);
    }
    const paging = isObj(body?.paging) ? body.paging : {};
    const totalPages = typeof paging.totalPages === 'number' ? paging.totalPages : undefined;
    if (users.length === 0 || (totalPages !== undefined ? page >= totalPages : users.length < PAGE)) break;
  }

  if (!opts.rpId) {
    if (userIds.length > 0) {
      set.warn('Passkeys were not exported: Corbado does not return the relying-party id they are bound to. Pass it with --corbado-rp-id and run the export again.');
    }
  } else {
    progress('passkeys');
    let denied = false;
    for (const id of userIds) {
      if (denied) break;
      let creds: Obj[];
      try {
        creds = objs((await http.get<Obj>(`/v2/users/${encodeURIComponent(id)}/fullCredentials`)).body?.fullCredentials);
      } catch (err) {
        if (err instanceof VendorApiError && err.status === 404) continue;
        if (err instanceof VendorApiError && err.status === 403) {
          denied = true;
          set.warn('Corbado refused the passkey export (the API secret lacks the credentials:export permission): passkeys were not exported; members register them again.');
          continue;
        }
        throw err;
      }
      for (const c of creds) {
        const credentialId = str(c.credentialID);
        const publicKey = str(c.publicKey);
        if (!credentialId || !publicKey) continue;
        set.add(
          'passkey',
          compact({
            user_id: id,
            credential_id: credentialId,
            public_key: publicKey,
            sign_count: typeof c.authenticatorSignCount === 'number' ? c.authenticatorSignCount : undefined,
            rp_id: opts.rpId,
            transports: strs(c.transports),
            aaguid: str(c.authenticatorAAGUID),
            backed_up: typeof c.backupState === 'boolean' ? c.backupState : undefined,
            created_at: typeof c.createdMs === 'number' ? c.createdMs : undefined,
          }),
          credentialId,
        );
      }
    }
    if (!denied && set.count('passkey') > 0) {
      set.warn(`Passkeys are bound to ${opts.rpId}: Atlas must be served from that domain (or one of its subdomains) for them to keep working.`);
    }
  }

  set.manifest = { origin: opts.projectId, settings: { project_id: opts.projectId }, ...(opts.rpId ? { rpId: opts.rpId } : {}) };
  return set;
}

/** One Corbado `userAggregate` → a user record; 'deleted' for removed users. */
export function mapCorbadoUser(u: Obj): UserRecord | 'deleted' | null {
  const id = str(u.userID);
  if (!id) return null;
  const status = str(u.status);
  if (status === 'deleted') return 'deleted';
  const verified = (i: Obj) => str(i.status) !== 'pending';
  const emails = objs(u.emailIdentifiers)
    .map((i) => ({ email: str(i.value)?.toLowerCase(), verified: verified(i), primary: str(i.status) === 'primary' }))
    .filter((e): e is { email: string; verified: boolean; primary: boolean } => !!e.email && e.email.includes('@'));
  if (emails.length > 0 && !emails.some((e) => e.primary)) emails[0]!.primary = true;
  const phones = objs(u.phoneNumberIdentifiers)
    .map((i) => ({ phone: e164(i.value), verified: verified(i), primary: str(i.status) === 'primary' }))
    .filter((p): p is { phone: string; verified: boolean; primary: boolean } => !!p.phone);
  if (phones.length > 0 && !phones.some((p) => p.primary)) phones[0]!.primary = emails.length === 0;
  const username = objs(u.usernameIdentifiers).map((i) => str(i.value)).find(Boolean);
  const user: UserRecord = compact({
    id,
    emails: emails.map((e) => ({ ...e })),
    phones: phones.map((p) => ({ ...p })),
    username,
    name: str(u.fullName),
    banned: status === 'disabled' ? true : undefined,
    created_at: typeof u.createdMS === 'number' ? u.createdMS : undefined,
  });
  return user.emails?.length || user.phones?.length || user.username ? user : null;
}

import type { UserRecord } from '@atlasauth/migrate';
import { parseCsv } from '../../import/csv';
import { RecordSet, compact, e164, isObj, str, type Obj } from './record-set';

/**
 * `atlas migrate export magic` — Magic (magic.link) users onto the canonical
 * bundle models, from the user export file of your Magic dashboard (Users →
 * Export: email, sign-up and last-login times).
 *
 * Magic offers NO API to list users: its Admin SDK only looks one user up by
 * issuer (DID), public address or DID token, so there is nothing to page
 * through and no secret key is needed. Two files feed the export:
 *
 *   - the dashboard export (CSV; JSON or NDJSON also accepted);
 *   - optionally an issuers file (email → issuer, e.g. collected with the
 *     Admin SDK's `getMetadataByIssuer` / `token.getIssuer` as users sign in).
 *
 * A user's issuer (`did:ethr:0x…`) is what Magic's DID tokens carry as `iss`,
 * so it is the id the zero-logout bridge matches on: a user without one is
 * imported by email and signs in by email code (the bridge cannot recognise
 * their old token). Magic holds no passwords or second-factor secrets;
 * wallet keys are never exported (users export them from Magic's own UI).
 */

export interface MagicExportOptions {
  /** The dashboard export (CSV, JSON array, or NDJSON). */
  usersText: string;
  /** Optional rows mapping an email (or public address) to its issuer. */
  issuersText?: string;
  onProgress?: (message: string) => void;
}

const ISSUER = /^did:ethr:0x[0-9a-fA-F]{40}$/;

/** `Sign Up Time` → `sign_up_time`. */
const norm = (k: string) => k.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function rows(text: string): Obj[] {
  const t = text.trim();
  if (!t) return [];
  let raw: Obj[];
  if (t.startsWith('[')) raw = (JSON.parse(t) as unknown[]).filter(isObj);
  else if (t.startsWith('{')) raw = t.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown).filter(isObj);
  else raw = parseCsv(t);
  return raw.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [norm(k), v])));
}

const pick = (r: Obj, names: string[]): string | undefined => {
  for (const n of names) {
    const v = str(r[n]);
    if (v) return v;
  }
  return undefined;
};

function time(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = /^\d{10,13}$/.test(v) ? Number(v) * (v.length === 10 ? 1000 : 1) : Date.parse(v);
  return Number.isFinite(n) ? n : undefined;
}

export function exportMagic(opts: MagicExportOptions): RecordSet {
  const set = new RecordSet();
  (opts.onProgress ?? (() => undefined))('users');
  const issuers = new Map<string, string>();
  for (const r of rows(opts.issuersText ?? '')) {
    const issuer = pick(r, ['issuer', 'did', 'issuer_did']);
    if (!issuer || !ISSUER.test(issuer)) continue;
    for (const key of [pick(r, ['email'])?.toLowerCase(), pick(r, ['public_address', 'address'])?.toLowerCase()]) if (key) issuers.set(key, issuer);
  }
  let withoutIssuer = 0;
  for (const r of rows(opts.usersText)) {
    const user = mapMagicUser(r, issuers);
    if (!user) {
      set.omit('user', 'no email address, phone number or issuer');
      continue;
    }
    if (!ISSUER.test(user.id)) withoutIssuer++;
    set.add('user', user, user.id);
  }
  if (withoutIssuer > 0) {
    set.warn(
      `${withoutIssuer} user(s) have no Magic issuer (did:ethr:…): they are imported by email and sign in with an email code, and the zero-logout bridge cannot recognise their current Magic token. Pass an email → issuer file with --magic-issuers-file to keep them signed in.`,
    );
  }
  if (set.count('user') > 0) {
    set.warn('Magic wallet keys are never exported: users who rely on their Magic wallet export the key from Magic before you switch it off.');
  }
  set.manifest = { origin: 'magic.link dashboard export' };
  return set;
}

/** One export row → a user record; id is the Magic issuer when known, else the lowercased email. */
export function mapMagicUser(r: Obj, issuers: Map<string, string> = new Map()): UserRecord | null {
  const email = pick(r, ['email', 'email_address'])?.toLowerCase();
  const address = pick(r, ['public_address', 'publicaddress', 'address'])?.toLowerCase();
  const phone = e164(pick(r, ['phone', 'phone_number', 'phonenumber']));
  const issuer = [pick(r, ['issuer', 'did', 'issuer_did']), email ? issuers.get(email) : undefined, address ? issuers.get(address) : undefined].find(
    (i): i is string => !!i && ISSUER.test(i),
  );
  const id = issuer ?? email ?? (phone ? `phone:${phone}` : undefined);
  if (!id || (email && !email.includes('@'))) return null;
  const meta: Record<string, string> = {};
  if (issuer) meta.magic_issuer = issuer;
  if (address) meta.magic_public_address = address;
  return compact({
    id,
    // Magic only creates an account after the user proved the address by logging in.
    emails: email ? [{ email, verified: true, primary: true }] : [],
    phones: phone ? [{ phone, verified: true, primary: !email }] : [],
    private_metadata: Object.keys(meta).length ? meta : undefined,
    created_at: time(pick(r, ['created', 'created_at', 'sign_up_time', 'signup_time', 'signed_up', 'sign_up'])),
    last_sign_in_at: time(pick(r, ['last_login', 'last_login_time', 'last_login_at', 'last_sign_in'])),
  }) as UserRecord;
}

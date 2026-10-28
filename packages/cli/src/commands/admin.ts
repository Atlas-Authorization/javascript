import {
  AtlasApiError,
  DEFAULT_API_URL,
  OAuthFlowError,
  exchangeOperatorToken,
  generateSealKeyPair,
  openSealedSecret,
  pollOperatorLogin,
  startOperatorLogin,
} from '@atlasauth/backend';
import { str, type ParsedArgs } from '../args';
import type { ConfigHttp } from '../config-http';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { fmtTime, printJson, renderTable, type Column } from '../output';
import { httpFor } from '../project';
import { deliverSecret } from '../secrets';
import { envApiUrl, requireArg, wantsJson } from './shared';

/** The scope an operator token needs on Atlas's own account for the staff routes. */
export const STAFF_PROVISION_SCOPE = 'platform:atlas_id_apps:provision';
const MIN_PASSWORD_LENGTH = 12;
const BASE = '/v1/admin/atlas_id/provisioned_accounts';
const DEVELOPER_BASE = '/v1/admin/atlas_id/developer_accounts';

/** A staff-made account as the /v1/admin routes return it. */
export interface StaffAccount {
  object: 'atlas_id_provisioned_account';
  id: string;
  sub: string;
  email: string | null;
  label: string;
  team: string;
  kind: 'provisioned' | 'developer' | 'test_mode';
  app_ids: string[];
  apps: Array<{ id: string; client_id: string; name: string }>;
  any_app: boolean;
  two_factor_exempt: boolean;
  expires_at: number | null;
  expired: boolean;
  developer_account_id: string | null;
  developer_account?: { id: string; name: string } | null;
  last_sign_in_at: number | null;
  password?: string;
  sealed_password?: string;
  application?: { id: string; name: string };
}

interface StaffList {
  object: 'list';
  data: StaffAccount[];
  has_more: boolean;
  teams: Array<{ team: string; count: number; expired: number; limit: number }>;
  team_cap: number;
}

const COLUMNS: Column<StaffAccount>[] = [
  { header: 'ID', get: (a) => a.id },
  { header: 'EMAIL', get: (a) => a.email ?? '' },
  { header: 'TEAM', get: (a) => a.team ?? a.label },
  { header: 'KIND', get: (a) => a.kind },
  { header: 'APPS', get: (a) => (a.any_app ? 'any' : a.kind === 'developer' ? '-' : a.apps.map((x) => x.name).join(', ') || a.app_ids.join(', ')) },
  { header: 'EXPIRES', get: (a) => (a.expires_at ? (a.expired ? `${fmtTime(a.expires_at)} (expired)` : fmtTime(a.expires_at)) : 'never') },
];

/** The first non-comment line of a file (or stdin): `NAME=value` or a bare value. */
function readPasswordFile(ctx: RunContext, file: string): string {
  const where = file === '-' ? 'stdin' : file;
  let text: string;
  try {
    text = ctx.readFile(file === '-' ? '/dev/stdin' : file);
  } catch {
    throw new CliError(`Could not read the password from ${where}.`);
  }
  const line = text.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#')) ?? '';
  const m = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(line.trim());
  const password = (m ? m[1]! : line).replace(/[\r\n]+$/, '').replace(/^"(.*)"$/, '$1');
  if (!password) throw new CliError(`No password found in ${where}.`);
  if (password.length < MIN_PASSWORD_LENGTH) throw new CliError(`The password in ${where} must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  return password;
}

/** `--days N` / `--expires-at <ISO|epoch ms>` as the staff routes take them. */
function expiryBody(values: ParsedArgs['values']): { days?: number; expires_at?: number | string } {
  const days = str(values, 'days');
  const at = str(values, 'expires-at');
  if (days && at) throw new CliError('Pass --days or --expires-at, not both.');
  if (days) {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1) throw new CliError(`--days must be a whole number of days, got '${days}'.`);
    return { days: n };
  }
  if (at) {
    if (/^\d+$/.test(at)) return { expires_at: Number(at) };
    if (Number.isNaN(Date.parse(at))) throw new CliError(`--expires-at must be an ISO 8601 date (2026-12-31) or epoch milliseconds, got '${at}'.`);
    return { expires_at: at };
  }
  return {};
}

function withoutSecrets(a: StaffAccount): Omit<StaffAccount, 'password' | 'sealed_password'> {
  const { password: _p, sealed_password: _s, ...rest } = a;
  void _p;
  void _s;
  return rest;
}

const stepUpError = (err: unknown): boolean =>
  err instanceof AtlasApiError && err.errors.some((e) => e.code === 'STEP_UP_REQUIRED' || e.code === 'MFA_REQUIRED');

/**
 * The staff credential: the profile's operator sign-in (`atlas login --device`)
 * exchanged for a one-hour token on Atlas's own account with the provision
 * scope. Nothing long-lived is stored; the staff account id is remembered on
 * the profile once given.
 */
class StaffSession {
  private token: string | undefined;
  readonly pair = generateSealKeyPair();
  constructor(
    private readonly ctx: RunContext,
    private readonly args: ParsedArgs,
  ) {}

  private profileName(): string {
    const file = this.ctx.config.load();
    return str(this.args.values, 'profile') || file.active_profile || 'default';
  }

  private apiUrl(): string {
    const profile = this.ctx.config.load().profiles[this.profileName()];
    return str(this.args.values, 'url') || envApiUrl(this.ctx.env) || profile?.api_url || DEFAULT_API_URL;
  }

  private staffAccount(): string {
    const file = this.ctx.config.load();
    const name = this.profileName();
    const given = str(this.args.values, 'staff-account') || this.ctx.env.ATLAS_STAFF_ACCOUNT_ID?.trim();
    const account = given || file.profiles[name]?.staff_account_id;
    if (!account) {
      throw new CliError("atlas admin needs Atlas's own account id once: pass --staff-account <acct_…> (or set ATLAS_STAFF_ACCOUNT_ID). It is remembered on the profile.");
    }
    if (given && file.profiles[name] && file.profiles[name]!.staff_account_id !== given) {
      file.profiles[name]!.staff_account_id = given;
      this.ctx.config.save(file);
    }
    return account;
  }

  private async exchange(): Promise<string> {
    const file = this.ctx.config.load();
    const operator = file.profiles[this.profileName()]?.operator;
    if (!operator || operator.expires_at <= Date.now()) {
      throw new CliError("No current operator sign-in. Run 'atlas login --device' (confirm with your second factor) first.");
    }
    try {
      const bound = await exchangeOperatorToken(
        operator.access_token,
        { resource: this.staffAccount(), scope: STAFF_PROVISION_SCOPE },
        { apiUrl: this.apiUrl(), fetch: this.ctx.fetch },
      );
      return bound.access_token;
    } catch (err) {
      if (err instanceof OAuthFlowError) {
        throw new CliError(`Atlas refused the staff token (${err.error}): ${err.message}. Only owners and admins of Atlas's own account can use 'atlas admin'.`);
      }
      throw err;
    }
  }

  /** A fresh operator sign-in (the device flow), for a write that needs a recent second factor. */
  private async stepUp(): Promise<void> {
    const opts = { apiUrl: this.apiUrl(), fetch: this.ctx.fetch };
    let start;
    try {
      start = await startOperatorLogin(opts);
    } catch (err) {
      throw new CliError(err instanceof Error ? err.message : String(err));
    }
    this.ctx.io.err('This action needs a sign-in verified with your second factor in the last 5 minutes.');
    this.ctx.io.err(`Open ${start.verification_uri_complete}`);
    this.ctx.io.err(`and confirm the code ${start.user_code} with your passkey or authenticator.`);
    let token;
    try {
      token = await pollOperatorLogin(start, { fetch: this.ctx.fetch, sleep: this.ctx.sleep });
    } catch (err) {
      if (err instanceof OAuthFlowError) throw new CliError(`Sign-in did not complete: ${err.message}`);
      throw err;
    }
    const file = this.ctx.config.load();
    const name = this.profileName();
    const entry = file.profiles[name] ?? { api_url: opts.apiUrl, secret_key: '' };
    entry.operator = { access_token: token.access_token, expires_at: Date.now() + token.expires_in * 1000, issuer: start.config.issuer };
    file.profiles[name] = entry;
    this.ctx.config.save(file);
    this.token = undefined;
  }

  private async http(): Promise<ConfigHttp> {
    this.token ??= await this.exchange();
    // Passwords come back sealed to a key pair made here, opened only locally.
    return httpFor(this.ctx, { secretKey: this.token, apiUrl: this.apiUrl(), headers: { 'x-secret-recipient': this.pair.secretRecipient } });
  }

  read<T>(fn: (http: ConfigHttp) => Promise<T>): Promise<T> {
    return this.http().then(fn);
  }

  /** A write: on STEP_UP_REQUIRED, sign in again (unless --no-step-up) and retry once. */
  async write<T>(fn: (http: ConfigHttp) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.http());
    } catch (err) {
      if (!stepUpError(err)) throw err;
      if (this.args.values['no-step-up'] === true) {
        throw new CliError("This action needs a sign-in verified with your second factor in the last 5 minutes. Run 'atlas login --device' and retry.");
      }
      await this.stepUp();
      return fn(await this.http());
    }
  }

  /** The password: opened from `sealed_password` (or the plain field), then to a 0600 file. */
  deliverPassword(account: StaffAccount, label: string): string | undefined {
    const password = account.sealed_password ? openSealedSecret(account.sealed_password, this.pair) : account.password;
    if (!password) return undefined;
    const json = wantsJson(this.args.values);
    const io = json ? { out: () => undefined, err: this.ctx.io.err } : this.ctx.io;
    return deliverSecret({
      io,
      env: this.ctx.env,
      product: str(this.args.values, 'product') ?? 'atlasauth',
      fileName: `staff-account-${account.id}.env`,
      entries: { ATLAS_ID_TEST_EMAIL: account.email ?? '', ATLAS_ID_TEST_PASSWORD: password },
      label,
      printSecret: this.args.values['print-secret'] === true,
      force: true,
      comment: `Atlas staff-provisioned account ${account.email ?? account.id} (team ${account.team ?? account.label}). Hand it to that team only.`,
    }).path;
  }
}

function emitAccount(ctx: RunContext, args: ParsedArgs, account: StaffAccount, path: string | undefined, line: string): void {
  if (wantsJson(args.values)) printJson(ctx.io, { ...withoutSecrets(account), ...(path ? { secret_file: path } : {}) });
  else ctx.io.out(line);
}

async function idAccountsCommand(ctx: RunContext, args: ParsedArgs, staff: StaffSession): Promise<number> {
  const v = args.values;
  const sub = args.positionals[2];
  switch (sub) {
    case 'list': {
      const kind = str(v, 'kind');
      if (kind && kind !== 'provisioned' && kind !== 'developer') throw new CliError('--kind must be provisioned or developer.');
      const q = new URLSearchParams();
      const team = str(v, 'team');
      if (team) q.set('team', team);
      if (kind) q.set('kind', kind);
      const limit = str(v, 'limit');
      if (limit) q.set('limit', limit);
      const qs = q.toString();
      const page = await staff.read((http) => http.get<StaffList>(`${BASE}${qs ? `?${qs}` : ''}`));
      if (wantsJson(v)) printJson(ctx.io, page);
      else {
        ctx.io.out(renderTable(COLUMNS, page.data));
        for (const t of page.teams) ctx.io.out(`${t.team}: ${t.count} of ${t.limit}${t.expired ? ` (${t.expired} expired)` : ''}`);
      }
      return 0;
    }
    case 'provision': {
      const email = str(v, 'email');
      const team = str(v, 'team');
      if (!email || !team) throw new CliError('admin id-accounts provision needs --email <address> and --team <partner team>.');
      const anyApp = v['any-app'] === true;
      const apps = (str(v, 'app') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (anyApp === (apps.length > 0)) throw new CliError('Pass --app <id[,id…]> (the apps the account may sign in to) or --any-app, exactly one.');
      if (anyApp && v['two-factor-exempt'] === true) throw new CliError('--two-factor-exempt needs named apps (--app), not --any-app.');
      const passwordFile = str(v, 'password-file');
      const body = {
        email,
        team,
        ...(anyApp ? { any_app: true } : { app_ids: apps }),
        email_verified: v.unverified !== true,
        ...(passwordFile ? { password: readPasswordFile(ctx, passwordFile) } : {}),
        ...(v['two-factor-exempt'] === true ? { two_factor_exempt: true } : {}),
        ...expiryBody(v),
      };
      const created = await staff.write((http) => http.post<StaffAccount>(BASE, body));
      const path = staff.deliverPassword(created, `The password for ${created.email ?? email}`);
      emitAccount(
        ctx,
        args,
        created,
        path,
        `Created ${created.email ?? email} (${created.id}) for team ${team}${anyApp ? ', any Sign in with Atlas app' : ''}${created.expires_at ? `, expires ${fmtTime(created.expires_at)}` : ''}.`,
      );
      return 0;
    }
    case 'extend': {
      const id = requireArg(args.positionals, 3, 'account id');
      const extended = await staff.write((http) => http.post<StaffAccount>(`${BASE}/${encodeURIComponent(id)}/extend`, expiryBody(v)));
      emitAccount(ctx, args, extended, undefined, `${id} now expires ${extended.expires_at ? fmtTime(extended.expires_at) : 'never'}.`);
      return 0;
    }
    case 'rotate': {
      const id = requireArg(args.positionals, 3, 'account id');
      const passwordFile = str(v, 'password-file');
      const rotated = await staff.write((http) =>
        http.post<StaffAccount>(`${BASE}/${encodeURIComponent(id)}/password`, passwordFile ? { password: readPasswordFile(ctx, passwordFile) } : {}),
      );
      const path = staff.deliverPassword(rotated, `The new password for ${rotated.email ?? id}`);
      emitAccount(ctx, args, rotated, path, 'Existing sessions stay signed in; revoke the account to end them.');
      return 0;
    }
    case 'revoke': {
      const id = requireArg(args.positionals, 3, 'account id');
      await staff.write((http) => http.delete(`${BASE}/${encodeURIComponent(id)}`));
      if (wantsJson(v)) printJson(ctx.io, { id, revoked: true });
      else ctx.io.out(`Revoked ${id}: the account is deleted and its sessions and grants end.`);
      return 0;
    }
    default:
      throw new CliError(
        sub
          ? `Unknown subcommand 'admin id-accounts ${sub}'. Try: list, provision, extend, rotate, revoke.`
          : 'admin id-accounts needs a subcommand: list, provision, extend, rotate, revoke.',
      );
  }
}

async function developerAccountsCommand(ctx: RunContext, args: ParsedArgs, staff: StaffSession): Promise<number> {
  const v = args.values;
  const sub = args.positionals[2];
  switch (sub) {
    case 'provision': {
      const email = str(v, 'email');
      const team = str(v, 'team');
      if (!email || !team) throw new CliError('admin developer-accounts provision needs --email <address> and --team <partner team>.');
      const passwordFile = str(v, 'password-file');
      const body = {
        email,
        team,
        ...(str(v, 'account-name') ? { account_name: str(v, 'account-name') } : {}),
        ...(str(v, 'application-name') ? { application_name: str(v, 'application-name') } : {}),
        ...(passwordFile ? { password: readPasswordFile(ctx, passwordFile) } : {}),
        ...expiryBody(v),
      };
      const created = await staff.write((http) => http.post<StaffAccount>(DEVELOPER_BASE, body));
      const path = staff.deliverPassword(created, `The password for ${created.email ?? email}`);
      emitAccount(
        ctx,
        args,
        created,
        path,
        `Created developer account ${created.email ?? email} (${created.id}) for team ${team}${created.application ? `, owning ${created.application.name} (${created.application.id})` : ''}${created.expires_at ? `, expires ${fmtTime(created.expires_at)}` : ''}.`,
      );
      return 0;
    }
    case 'revoke': {
      const id = requireArg(args.positionals, 3, 'account id');
      const out = await staff.write((http) =>
        http.get<StaffAccount>(`${BASE}/${encodeURIComponent(id)}`).then(async (row) => {
          if (row.kind !== 'developer') throw new CliError(`${id} is not a developer account; use 'atlas admin id-accounts revoke'.`);
          await http.delete(`${BASE}/${encodeURIComponent(id)}`);
          return row;
        }),
      );
      if (wantsJson(v)) printJson(ctx.io, { id, revoked: true, developer_account_id: out.developer_account_id });
      else ctx.io.out(`Revoked ${id}: the account is deleted, its sessions end, and its dashboard account goes when no one else is a member.`);
      return 0;
    }
    default:
      throw new CliError(
        sub
          ? `Unknown subcommand 'admin developer-accounts ${sub}'. Try: provision, revoke.`
          : 'admin developer-accounts needs a subcommand: provision, revoke.',
      );
  }
}

/**
 * `atlas admin id-accounts list|provision|extend|rotate|revoke` and
 * `atlas admin developer-accounts provision|revoke`: Atlas STAFF provisioning
 * Sign in with Atlas accounts for other platforms' integration teams.
 *
 * Credential: the operator sign-in (`atlas login --device`), exchanged for a
 * one-hour token on Atlas's own account with `platform:atlas_id_apps:provision`.
 * Writes need a second factor proved in the last 5 minutes; when the server
 * says so, the CLI runs the operator sign-in again and retries once. Passwords
 * come back sealed to a key pair made for the run and are written to 0600 files,
 * never printed (unless --print-secret).
 */
export async function admin(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const group = args.positionals[1];
  if (group !== 'id-accounts' && group !== 'developer-accounts') {
    throw new CliError(
      group
        ? `Unknown 'atlas admin ${group}'. Try: atlas admin id-accounts …, atlas admin developer-accounts ….`
        : 'atlas admin needs a group: id-accounts or developer-accounts.',
    );
  }
  const staff = new StaffSession(ctx, args);
  return group === 'id-accounts' ? idAccountsCommand(ctx, args, staff) : developerAccountsCommand(ctx, args, staff);
}

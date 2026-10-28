import { DEFAULT_API_URL, type AtlasIdProvisionedAccount, type AtlasIdProvisionedAccountList } from '@atlasauth/backend';
import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { fmtTime, printJson, renderTable, type Column } from '../output';
import { httpFor } from '../project';
import { deliverSecret } from '../secrets';
import { envApiUrl, wantsJson } from './shared';

const MIN_PASSWORD_LENGTH = 12;

const COLUMNS: Column<AtlasIdProvisionedAccount>[] = [
  { header: 'ID', get: (a) => a.id },
  { header: 'EMAIL', get: (a) => a.email ?? '' },
  { header: 'LABEL', get: (a) => a.label },
  { header: 'KIND', get: (a) => a.kind },
  { header: '2FA', get: (a) => (a.two_factor_exempt ? 'exempt' : 'required') },
  { header: 'EXPIRES', get: (a) => (a.expires_at ? (a.expired ? `${fmtTime(a.expires_at)} (expired)` : fmtTime(a.expires_at)) : 'never') },
  { header: 'LAST SIGN-IN', get: (a) => (a.last_sign_in_at ? fmtTime(a.last_sign_in_at) : '') },
];

const isPlatformKey = (key: string | undefined): key is string =>
  Boolean(key && (key.startsWith('psk_') || /^atlas_(live|test)_psk_/.test(key)));

/**
 * The platform key (or a per-app scoped platform key) and API URL:
 * ATLAS_PLATFORM_KEY, else ATLAS_SECRET_KEY when it is a platform key, else the
 * profile's stored platform key.
 */
function platformAuth(ctx: RunContext, args: ParsedArgs): { secretKey: string; apiUrl: string } {
  const file = ctx.config.load();
  const profile = str(args.values, 'profile') || file.active_profile || 'default';
  const stored = file.profiles[profile];
  const candidates = [ctx.env.ATLAS_PLATFORM_KEY?.trim(), ctx.env.ATLAS_SECRET_KEY?.trim(), stored?.secret_key];
  const key = candidates.find(isPlatformKey);
  if (!key) {
    throw new CliError(
      "id-accounts needs a platform key with the provision scope: platform:atlas_id_apps:provision, or atlas_id_apps:<app id>:provision for one app. Set ATLAS_PLATFORM_KEY, or store one with 'atlas login --secret-key psk_…'.",
    );
  }
  return { secretKey: key, apiUrl: envApiUrl(ctx.env) || stored?.api_url || DEFAULT_API_URL };
}

/** The first non-comment line of a file (or stdin), `NAME=value` or a bare value. */
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

/** `--expires-at` as the API takes it: epoch ms/seconds stay numeric, anything else is an ISO date. */
function expiresAt(raw: string): number | string {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (Number.isNaN(Date.parse(raw))) throw new CliError(`--expires-at must be an ISO 8601 date (2026-12-31) or epoch milliseconds, got '${raw}'.`);
  return raw;
}

/** The response with the password removed: what is safe to print or log. */
function withoutSecrets(account: AtlasIdProvisionedAccount): Omit<AtlasIdProvisionedAccount, 'password' | 'sealed_password'> {
  const { password: _p, sealed_password: _s, ...rest } = account;
  void _p;
  void _s;
  return rest;
}

/**
 * `atlas id-accounts provision|list|rotate|remove --app <app id>`: test and
 * review accounts for a Sign in with Atlas app (a directory reviewer login, CI,
 * a demo). Takes a platform key with `platform:atlas_id_apps:provision`, or a
 * per-app key scoped `atlas_id_apps:<app id>:provision`.
 *
 * The password (yours, via `--password-file`, or one Atlas generates) is
 * returned once. It is written to a 0600 file next to the CLI's other secrets
 * and never printed, except with the explicit `--print-secret` opt-out.
 */
export async function idAccounts(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  const v = args.values;
  const json = wantsJson(v);
  const http = () => {
    const auth = platformAuth(ctx, args);
    return httpFor(ctx, auth);
  };
  const appId = () => {
    const app = str(v, 'app');
    if (!app) throw new CliError(`id-accounts ${sub} needs --app <Sign in with Atlas app id>.`);
    return app;
  };
  const base = (app: string) => `/v1/platform/atlas_id_apps/${encodeURIComponent(app)}/provisioned_accounts`;
  const accountArg = () => {
    const id = args.positionals[2];
    if (!id) throw new CliError(`id-accounts ${sub} needs the test account id (see: atlas id-accounts list --app <id>).`);
    return id;
  };

  const deliverPassword = (account: AtlasIdProvisionedAccount, label: string): string | undefined => {
    if (!account.password) {
      if (account.sealed_password) {
        ctx.io.err('The password came back sealed to your secret recipient; open it with your key. Nothing was written.');
      }
      return undefined;
    }
    const entries: Record<string, string> = {
      ATLAS_ID_TEST_EMAIL: account.email ?? '',
      ATLAS_ID_TEST_PASSWORD: account.password,
    };
    const io = json ? { out: () => undefined, err: ctx.io.err } : ctx.io;
    return deliverSecret({
      io,
      env: ctx.env,
      product: str(v, 'product') ?? 'atlasauth',
      fileName: `id-account-${account.id}.env`,
      entries,
      label,
      printSecret: v['print-secret'] === true,
      // A rotation always replaces; a fresh account has a fresh id, so nothing to clobber.
      force: true,
      comment: `Sign in with Atlas test account ${account.email ?? account.id} (${account.label}). Use it only with the app it was created for.`,
    }).path;
  };

  switch (sub) {
    case 'list': {
      const page = await http().get<AtlasIdProvisionedAccountList>(base(appId()));
      if (json) printJson(ctx.io, page);
      else {
        ctx.io.out(renderTable(COLUMNS, page.data));
        ctx.io.out(`${page.total} of ${page.limit} test accounts used across your apps.`);
      }
      return 0;
    }
    case 'provision': {
      const app = appId();
      const email = str(v, 'email');
      const label = str(v, 'label');
      if (!email || !label) throw new CliError('id-accounts provision needs --email <address> and --label <what it is for, e.g. reviewer>.');
      const passwordFile = str(v, 'password-file');
      const expires = str(v, 'expires-at');
      const body = {
        email,
        label,
        email_verified: v.unverified === true ? false : true,
        ...(passwordFile ? { password: readPasswordFile(ctx, passwordFile) } : {}),
        ...(v['two-factor-exempt'] === true ? { two_factor_exempt: true } : {}),
        ...(expires ? { expires_at: expiresAt(expires) } : {}),
      };
      const created = await http().post<AtlasIdProvisionedAccount>(base(app), body);
      const path = deliverPassword(created, `The password for ${created.email ?? email}`);
      if (json) printJson(ctx.io, { ...withoutSecrets(created), ...(path ? { secret_file: path } : {}) });
      else {
        ctx.io.out(
          `Created ${created.email ?? email} (${created.id}) for app ${app}${created.two_factor_exempt ? ', exempt from two-factor sign-in' : ''}${created.expires_at ? `, expires ${fmtTime(created.expires_at)}` : ', never expires'}.`,
        );
        if (created.two_factor_exempt) {
          ctx.io.out('Two-factor exemption: anyone holding this password can sign in to the app. Share it only with the review team.');
        }
      }
      return 0;
    }
    case 'rotate': {
      const app = appId();
      const id = accountArg();
      const passwordFile = str(v, 'password-file');
      const rotated = await http().post<AtlasIdProvisionedAccount>(`${base(app)}/${encodeURIComponent(id)}/password`, passwordFile ? { password: readPasswordFile(ctx, passwordFile) } : {});
      const path = deliverPassword(rotated, `The new password for ${rotated.email ?? id}`);
      if (json) printJson(ctx.io, { ...withoutSecrets(rotated), ...(path ? { secret_file: path } : {}) });
      else ctx.io.out('Existing sessions stay signed in; remove the account to end them.');
      return 0;
    }
    case 'remove': {
      const app = appId();
      const id = accountArg();
      await http().delete(`${base(app)}/${encodeURIComponent(id)}`);
      if (json) printJson(ctx.io, { id, removed: true });
      else ctx.io.out(`Removed ${id}: the account is deleted and its sessions and grants are revoked.`);
      return 0;
    }
    default:
      throw new CliError(
        sub
          ? `Unknown subcommand 'id-accounts ${sub}'. Try: provision, list, rotate, remove.`
          : 'id-accounts needs a subcommand: provision, list, rotate, remove.',
      );
  }
}

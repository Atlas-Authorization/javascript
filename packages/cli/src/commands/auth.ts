import { AtlasApiError, DEFAULT_API_URL } from '@atlasauth/backend';
import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import { maskSecret, resolveAuth, wantsJson } from './shared';

/**
 * `atlas login` — prompt for an API URL + a secret key, PROVE the key works
 * with one cheap Backend call, then store it under a named profile (0600).
 *
 * Validating before saving is the point: a login that silently stored a typo'd
 * key would surface only later as a baffling 401 on an unrelated command. We
 * spend one `users.list({ limit: 1 })` round-trip here so every later command
 * can trust the stored credential. `--url` / `--secret-key` skip the prompts
 * for non-interactive setup (CI), mirroring the `ATLAS_*` env overrides.
 */
export async function login(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const { values } = args;
  const profile = str(values, 'profile') || 'default';

  const apiUrl =
    str(values, 'url') ||
    (await ctx.prompt.text('Atlas API URL', { default: DEFAULT_API_URL })) ||
    DEFAULT_API_URL;
  const secretKey = str(values, 'secret-key') || (await ctx.prompt.secret('Atlas secret key (sk_...)'));

  if (!secretKey) throw new CliError('A secret key is required to log in.');

  // Prove the credential before persisting it.
  const client = ctx.makeClient({ secretKey, apiUrl });
  try {
    await client.users.list({ limit: 1 });
  } catch (err) {
    if (err instanceof AtlasApiError) {
      throw new CliError(
        `Secret key rejected by ${apiUrl} (HTTP ${err.status}${err.code ? `, ${err.code}` : ''}). Nothing was saved.`,
      );
    }
    // A network/DNS failure, not a bad key — say so distinctly.
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(`Could not reach ${apiUrl}: ${detail}. Nothing was saved.`);
  }

  const file = ctx.config.load();
  file.profiles[profile] = { api_url: apiUrl, secret_key: secretKey };
  file.active_profile = profile;
  ctx.config.save(file);

  ctx.io.out(`Logged in to ${apiUrl} as profile '${profile}'.`);
  ctx.io.out(`Credential stored at ${ctx.config.path} (mode 0600).`);
  return 0;
}

/**
 * `atlas logout` — forget one profile's stored credential. If it was the active
 * profile, the active pointer falls back to any remaining profile so the CLI
 * isn't left pointing at nothing.
 */
export async function logout(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const { values } = args;
  const file = ctx.config.load();
  const profile = str(values, 'profile') || file.active_profile || 'default';

  if (!file.profiles[profile]) {
    ctx.io.out(`No stored credential for profile '${profile}'.`);
    return 0;
  }

  delete file.profiles[profile];
  if (file.active_profile === profile) {
    file.active_profile = Object.keys(file.profiles)[0];
  }
  ctx.config.save(file);

  ctx.io.out(`Logged out of profile '${profile}'.`);
  return 0;
}

/**
 * `atlas whoami` — report the active profile and instance without any network
 * call. The secret is always masked; the per-field source tells a user whether
 * an `ATLAS_*` env var is shadowing the stored profile.
 */
export async function whoami(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const auth = resolveAuth(ctx, args.values);

  if (wantsJson(args.values)) {
    printJson(ctx.io, {
      profile: auth.profile,
      api_url: auth.apiUrl,
      secret_key: maskSecret(auth.secretKey),
      key_source: auth.keySource,
      url_source: auth.urlSource,
    });
    return 0;
  }

  ctx.io.out(`Profile:    ${auth.profile}`);
  ctx.io.out(`API URL:    ${auth.apiUrl} (${auth.urlSource})`);
  ctx.io.out(`Secret key: ${maskSecret(auth.secretKey)} (${auth.keySource})`);
  return 0;
}

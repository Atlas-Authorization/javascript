import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_API_URL,
  OAuthFlowError,
  createAtlasClient,
  exchangeOperatorToken,
  generateSealKeyPair,
  openSealedSecret,
  pollOperatorLogin,
  revokeLeakedKeys,
  startOperatorLogin,
} from '@atlasauth/backend';
import { timingSafeEqual } from 'node:crypto';
import { str, type ParsedArgs } from '../args';
import { httpFor } from '../project';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import { envApiUrl, requireArg, resolveAuth, wantsJson } from './shared';
import { KEYS_DATA, KEYS_OP, resourceCommand, shift } from './resources';

/**
 * `atlas login --device` — sign in as an OPERATOR through Atlas's own sign-in
 * (passkey, MFA) with the OAuth device flow, instead of pasting a key. Only
 * short-lived tokens are stored: the operator token (to swap later with
 * `atlas token`) and, with `--resource`, a one-hour token bound to that
 * instance or app, used as the profile credential. No long-lived key is written.
 */
export async function deviceLogin(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const { values } = args;
  const profile = str(values, 'profile') || 'default';
  const apiUrl = str(values, 'url') || envApiUrl(ctx.env) || DEFAULT_API_URL;
  const opts = { apiUrl, fetch: ctx.fetch };
  // --audience <id>: an operator token FOR another product that trusts Atlas's
  // operator issuer (one of /v1/operator `audiences`). It is printed, not
  // stored: Atlas's own token exchange refuses it.
  const audience = str(values, 'audience');
  let start;
  try {
    start = await startOperatorLogin({ ...opts, ...(audience ? { audience } : {}) });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  ctx.io.out(`Open ${start.verification_uri_complete}`);
  ctx.io.out(`and confirm the code ${start.user_code} (it expires in ${Math.round(start.expires_in / 60)} minutes).`);
  let token;
  try {
    token = await pollOperatorLogin(start, { fetch: ctx.fetch, sleep: ctx.sleep });
  } catch (err) {
    if (err instanceof OAuthFlowError) throw new CliError(`Sign-in did not complete: ${err.message}`);
    throw err;
  }
  if (audience) {
    if (wantsJson(values)) printJson(ctx.io, { ...token, audience, issuer: start.config.issuer });
    else ctx.io.out(token.access_token);
    ctx.io.err(`An operator token for ${audience} (expires in ${Math.round(token.expires_in / 60)} minutes). Hand it to that product; it is not stored.`);
    return 0;
  }
  const now = Date.now();
  const file = ctx.config.load();
  const entry = file.profiles[profile] ?? { api_url: apiUrl, secret_key: '' };
  entry.api_url = apiUrl;
  entry.operator = { access_token: token.access_token, expires_at: now + token.expires_in * 1000, issuer: start.config.issuer };
  const resource = str(values, 'resource');
  if (resource) {
    const scope = str(values, 'scope') || 'read';
    const bound = await exchangeOrExplain(token.access_token, resource, scope, opts);
    entry.secret_key = bound.access_token;
    entry.expires_at = now + bound.expires_in * 1000;
    entry.resource = resource;
    entry.scope = bound.scope;
  }
  file.profiles[profile] = entry;
  file.active_profile = profile;
  ctx.config.save(file);
  ctx.io.out(`Signed in to ${start.config.issuer} as an operator (profile '${profile}').`);
  if (resource) ctx.io.out(`Profile credential: a one-hour token for ${resource} (${entry.scope}).`);
  else ctx.io.out("Run 'atlas token --resource <ins_… | app_…> --scope <scopes>' for a token bound to one instance or app.");
  return 0;
}

async function exchangeOrExplain(subject: string, resource: string, scope: string, opts: { apiUrl: string; fetch?: typeof fetch }) {
  try {
    return await exchangeOperatorToken(subject, { resource, scope }, opts);
  } catch (err) {
    if (err instanceof OAuthFlowError) throw new CliError(`Token exchange refused (${err.error}): ${err.message}`);
    throw err;
  }
}

/**
 * `atlas token --resource <ins_…|app_…|acct_…> --scope "<scopes>"` — swap the
 * stored operator token for a one-hour Atlas token bound to that resource.
 * Prints the token (or JSON with --json); `--profile` stores it as that
 * profile's credential instead.
 */
export async function token(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const { values } = args;
  const file = ctx.config.load();
  const profileName = str(values, 'profile') || file.active_profile || 'default';
  const profile = file.profiles[profileName];
  if (!profile?.operator || profile.operator.expires_at <= Date.now()) {
    throw new CliError("No current operator sign-in. Run 'atlas login --device' first.");
  }
  const resource = str(values, 'resource');
  if (!resource) throw new CliError('--resource is required (an ins_…, app_… or acct_… id).');
  const scope = str(values, 'scope') || 'read';
  const bound = await exchangeOrExplain(profile.operator.access_token, resource, scope, { apiUrl: profile.api_url, fetch: ctx.fetch });
  if (wantsJson(values)) {
    printJson(ctx.io, bound);
    return 0;
  }
  ctx.io.out(bound.access_token);
  return 0;
}

/** Write a secret to a 0600 file (directories 0700). */
function writeSecret(path: string, name: string, secret: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${name}=${secret}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * `atlas keys whoami|list|create|rotate|revoke|revoke-leaked`.
 *
 * create / rotate ask for the new secret SEALED to a key pair generated here
 * (X-Secret-Recipient), open it locally and write it to a 0600 file
 * (`--out`, default `.atlas/secret-key-<id>.env`), so the plaintext never
 * crosses a log or terminal. `--print-secret` prints it instead.
 */
/**
 * `atlas keys data shred`: remove customer-managed encryption, which crypto-shreds everything encrypted under it.
 * The caller types the instance id (or passes --confirm <instance id>); only an exact match sends { confirm: 'shred' }.
 */
async function shredDataKey(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const auth = resolveAuth(ctx, args.values);
  const http = httpFor(ctx, { secretKey: auth.secretKey, apiUrl: envApiUrl(ctx.env) ?? auth.apiUrl });
  const inst = await http.get<{ id?: string }>('/v1/instance');
  if (!inst?.id) throw new CliError('Could not read the instance id, so nothing was shredded.');
  const typed = str(args.values, 'confirm') ?? (await ctx.prompt.text(`This permanently destroys the data protected by your key and cannot be undone.\nType the instance id (${inst.id}) to continue`));
  const a = Buffer.from(typed.trim());
  const b = Buffer.from(inst.id);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new CliError('That is not this instance id, so nothing was shredded.');
  await http.delete('/v1/instance/data_key_provider', { confirm: 'shred' });
  ctx.io.out('Customer-managed encryption removed; the data under it is shredded.');
  return 0;
}

export async function keys(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const { values, positionals } = args;
  const sub = positionals[1];
  if (sub === 'data' && positionals[2] === 'shred') return shredDataKey(ctx, args);
  if (sub === 'data') return resourceCommand('keys data', KEYS_DATA)(ctx, shift(args));
  if (sub === 'op') return resourceCommand('keys op', KEYS_OP)(ctx, shift(args));
  if (sub === 'revoke-leaked') {
    const secret = positionals[2] ?? (await ctx.prompt.secret('Leaked secret'));
    if (!secret) throw new CliError('Pass the leaked secret (or enter it at the prompt).');
    const apiUrl = str(values, 'url') || envApiUrl(ctx.env) || DEFAULT_API_URL;
    const res = await revokeLeakedKeys([secret], { apiUrl, fetch: ctx.fetch });
    ctx.io.out(`Result: ${res.results[0]?.outcome ?? 'unknown'}`);
    return 0;
  }
  const auth = resolveAuth(ctx, values);
  const pair = generateSealKeyPair();
  const atlas = createAtlasClient({ secretKey: auth.secretKey, apiUrl: auth.apiUrl, fetch: ctx.fetch, secretRecipient: pair.secretRecipient });
  const emit = (data: unknown, line: () => void) => (wantsJson(values) ? printJson(ctx.io, data) : line());
  const deliver = (id: string, sealed: string | undefined, plain: string | undefined) => {
    const secret = sealed ? openSealedSecret(sealed, pair) : plain;
    if (!secret) throw new CliError('The response carried no secret.');
    if (values['print-secret'] === true) return ctx.io.out(secret);
    const path = str(values, 'out') || `.atlas/secret-key-${id}.env`;
    writeSecret(path, 'ATLAS_SECRET_KEY', secret);
    ctx.io.out(`Secret written to ${path} (mode 0600).`);
  };
  switch (sub) {
    case 'whoami': {
      const me = await atlas.whoami();
      emit(me, () => {
        ctx.io.out(`Key:      ${me.key.id} (${me.key.type}, ${me.key.prefix ?? ''}…)`);
        ctx.io.out(`Scopes:   ${me.key.scopes.join(' ')}`);
        ctx.io.out(`Instance: ${me.instance?.id ?? '-'}  Account: ${me.account.id ?? '-'}`);
        if (me.key.expires_at) ctx.io.out(`Expires:  ${new Date(me.key.expires_at).toISOString()}`);
      });
      return 0;
    }
    case 'list': {
      const page = await atlas.keys.list();
      emit(page, () => {
        for (const k of page.data) {
          ctx.io.out(`${k.id}  ${k.kind.padEnd(14)} ${k.prefix.padEnd(20)} ${k.status.padEnd(9)} owner=${k.owner ?? '-'} last_used=${k.last_used_at ? new Date(k.last_used_at).toISOString() : 'never'}`);
        }
      });
      return 0;
    }
    case 'create': {
      const scopes = (str(values, 'scopes') || '').split(/[ ,]+/).filter(Boolean);
      if (scopes.length === 0) throw new CliError('--scopes is required, e.g. --scopes "instance:read webhooks:read" or --scopes read_only.');
      const created = await atlas.secretKeys.create({
        scopes,
        name: str(values, 'name') || undefined,
        owner: str(values, 'owner') || undefined,
        expires_at: str(values, 'expires-at') || undefined,
        allowed_ips: str(values, 'allowed-ips') ? (str(values, 'allowed-ips') ?? '').split(',').map((s) => s.trim()) : undefined,
      });
      ctx.io.out(`Created ${created.id} (${created.prefix}…) with ${created.scopes.join(' ')}.`);
      deliver(created.id, created.sealed_secret, created.secret);
      return 0;
    }
    case 'rotate': {
      const id = requireArg(positionals, 2, 'key id');
      const overlap = str(values, 'overlap');
      const rotated = await atlas.secretKeys.rotate(id, overlap ? { overlap_seconds: Number(overlap) } : {});
      ctx.io.out(
        `Rotated ${id} → ${rotated.id}.` +
          (rotated.previous_key_expires_at ? ` The old key works until ${new Date(rotated.previous_key_expires_at).toISOString()}.` : ' The old key was revoked.'),
      );
      deliver(rotated.id, rotated.sealed_secret, rotated.secret);
      return 0;
    }
    case 'revoke': {
      const id = requireArg(positionals, 2, 'key id');
      await atlas.secretKeys.revoke(id);
      ctx.io.out(`Revoked ${id}.`);
      return 0;
    }
    default:
      throw new CliError('Usage: atlas keys whoami|list|create|rotate <id>|revoke <id>|revoke-leaked [secret]|data ...|op ...');
  }
}

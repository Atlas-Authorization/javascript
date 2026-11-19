import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import { httpFor } from '../project';
import { resolveAuth, wantsJson } from './shared';
import { readKeyFile } from './referrals';

const HOOK = '/v1/instance/hooks/before_first_session';

interface Hook {
  url?: string | null;
  enabled?: boolean;
  timeout_ms?: number;
  signing_secret_set?: boolean;
}

const httpOf = (ctx: RunContext, args: ParsedArgs) => {
  const auth = resolveAuth(ctx, args.values);
  return httpFor(ctx, { secretKey: auth.secretKey, apiUrl: auth.apiUrl });
};

const describe = (h: Hook) =>
  h.url ? `before_first_session: ${h.enabled ? 'on' : 'off'}, ${h.url}, timeout ${h.timeout_ms ?? '(default)'} ms, signing secret ${h.signing_secret_set ? 'set' : 'not set'}.` : 'before_first_session is not configured.';

/** `atlas hooks before-first-session show|set|remove|test`. */
export async function hooks(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const name = args.positionals[1];
  const sub = args.positionals[2];
  const json = wantsJson(args.values);
  if (name !== 'before-first-session') {
    throw new CliError(name ? `Unknown hook '${name}'. Try: before-first-session.` : 'hooks needs a hook: before-first-session.');
  }
  const http = httpOf(ctx, args);
  switch (sub) {
    case 'show': {
      const h = await http.get<Hook>(HOOK);
      if (json) printJson(ctx.io, h);
      else ctx.io.out(describe(h));
      return 0;
    }
    case 'set': {
      const body: Record<string, unknown> = {};
      const url = str(args.values, 'url');
      if (url) body.url = url;
      const secretFile = str(args.values, 'secret-file');
      if (secretFile) body.signing_secret = readKeyFile(ctx, secretFile, 'the signing secret');
      const timeout = str(args.values, 'timeout-ms');
      if (timeout !== undefined) {
        if (!/^\d+$/.test(timeout)) throw new CliError('--timeout-ms must be a whole number of milliseconds.');
        body.timeout_ms = Number(timeout);
      }
      if (args.values.enable === true) body.enabled = true;
      if (args.values.disable === true) body.enabled = false;
      if (!Object.keys(body).length) throw new CliError('hooks before-first-session set needs --url, --secret-file, --timeout-ms, --enable or --disable.');
      const h = await http.patch<Hook>(HOOK, body);
      if (json) printJson(ctx.io, h);
      else ctx.io.out(describe(h));
      return 0;
    }
    case 'remove': {
      await http.delete(HOOK);
      if (json) printJson(ctx.io, { hook: 'before_first_session', removed: true });
      else ctx.io.out('Removed the before_first_session hook: sign-in no longer calls it.');
      return 0;
    }
    case 'test': {
      const r = await http.post<{ ok: boolean; http_status: number | null; latency_ms: number; answer?: { external_id?: string | null }; error?: { code: string; message: string } }>('/v1/instance/hooks/before_first_session/test', {});
      if (json) printJson(ctx.io, r);
      else if (r.ok) ctx.io.out(`The hook answered${r.http_status ? ` ${r.http_status}` : ''} in ${r.latency_ms} ms${r.answer?.external_id ? ` with external_id ${r.answer.external_id}` : ' with no external_id'}.`);
      else ctx.io.out(`The hook test failed (${r.error?.code ?? 'failed'}): ${r.error?.message ?? 'no answer'}`);
      return r.ok ? 0 : 1;
    }
    default:
      throw new CliError(sub ? `Unknown subcommand 'hooks before-first-session ${sub}'. Try: show, set, remove, test.` : 'hooks before-first-session needs: show, set, remove, test.');
  }
}

interface Issuers {
  active: string;
  planned: string | null;
  previous: string[];
  jwks_uri: string;
}

/** `atlas issuers`: GET /v1/instance/issuers. */
export async function issuers(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const r = await httpOf(ctx, args).get<Issuers>('/v1/instance/issuers');
  if (wantsJson(args.values)) {
    printJson(ctx.io, r);
    return 0;
  }
  ctx.io.out(`active    ${r.active}`);
  ctx.io.out(`planned   ${r.planned ?? '(none: no unverified domain claim)'}`);
  ctx.io.out(`previous  ${r.previous.length ? r.previous.join(', ') : '(none)'}`);
  ctx.io.out(`jwks      ${r.jwks_uri}`);
  return 0;
}

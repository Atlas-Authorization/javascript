import { readFileSync } from 'node:fs';
import type { ParsedArgs } from '../args';
import { str } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';

/**
 * `atlas dev [--port 4400] [--seed file.json] [--app <url>]`: a local in-memory
 * Atlas (FAPI, minimal BAPI, OIDC discovery, mail catcher).
 * `atlas dev proxy --app <url> --api <fapi url>`: one origin for app + API.
 */
export async function dev(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const v = args.values;
  const sub = args.positionals[1];
  if (sub !== undefined && sub !== 'proxy') throw new CliError(`Unknown dev subcommand '${sub}'. Use 'atlas dev' or 'atlas dev proxy'.`);
  const port = str(v, 'port') ? Number(str(v, 'port')) : sub ? 4401 : 4400;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliError('--port must be 0-65535.');
  const app = str(v, 'app');
  const { startEmulator, startProxy } = await import('@atlasauth/emulator');
  let server: { url: string; close(): Promise<void> };
  if (sub === 'proxy') {
    const api = str(v, 'api');
    if (!app || !api) throw new CliError('dev proxy needs --app <url> and --api <fapi url>.');
    server = await startProxy({ port, app, api });
    ctx.io.out(`Proxying ${app} + ${api} on one origin: ${server.url}`);
  } else {
    const seedFile = str(v, 'seed');
    let seed;
    try {
      seed = seedFile ? JSON.parse(readFileSync(seedFile, 'utf8')) : undefined;
    } catch (err) {
      throw new CliError(`Could not read --seed ${seedFile}: ${(err as Error).message}`);
    }
    server = await startEmulator({ port, app, seed });
    ctx.io.out(`Atlas emulator on ${server.url} (mail catcher: ${server.url}/__emulator/mail, codes: 424242)`);
  }
  await new Promise<void>((done) => {
    if (ctx.signal) return void (ctx.signal.aborted ? done() : ctx.signal.addEventListener('abort', () => done()));
    process.once('SIGINT', () => done());
    process.once('SIGTERM', () => done());
  });
  await server.close();
  return 0;
}

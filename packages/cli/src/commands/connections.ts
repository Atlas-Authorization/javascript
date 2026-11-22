import type { ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson, renderTable } from '../output';
import { requireArg, requireClient, wantsJson } from './shared';

/**
 * `atlas connections templates` lists the marketplace connection templates (kind, secrets, hosts);
 * `atlas connections rehome <from-client> <to-client> [<connection-id>...] [--dry-run]` moves connections between
 * owner OAuth clients (each move proven with a refresh unless both clients are the same provider app).
 */
export async function connections(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  const json = wantsJson(args.values);

  switch (sub) {
    case 'templates': {
      const { client } = requireClient(ctx, args.values);
      const list = await client.connections.templates();
      if (json) {
        printJson(ctx.io, list);
        return 0;
      }
      ctx.io.out(
        renderTable(
          [
            { header: 'PROVIDER', get: (t: (typeof list.data)[number]) => t.provider },
            { header: 'KIND', get: (t) => t.kind },
            { header: 'FLOW', get: (t) => t.flow },
            { header: 'SECRETS', get: (t) => t.secrets.join(', ') || '-' },
            { header: 'HOSTS', get: (t) => t.allowed_hosts.join(', ') || '-' },
            { header: 'SIGNATURE', get: (t) => t.signature },
          ],
          list.data,
        ),
      );
      return 0;
    }

    case 'rehome': {
      const from = requireArg(args.positionals, 2, 'from-client');
      const to = requireArg(args.positionals, 3, 'to-client');
      const ids = args.positionals.slice(4);
      const dryRun = args.values['dry-run'] === true;
      if (!dryRun && args.values.yes !== true) {
        throw new CliError(`This moves ${ids.length > 0 ? `${ids.length} connection(s)` : 'every connection'} from ${from} to ${to} (each proven with a refresh unless both are the same provider app); pass --dry-run to preview or --yes to confirm.`);
      }
      const { client } = requireClient(ctx, args.values);
      const result = await client.connections.rehome({ from_client: from, to_client: to, ...(ids.length > 0 ? { connection_ids: ids } : {}), ...(dryRun ? { dry_run: true } : {}) });
      if (json) {
        printJson(ctx.io, result);
        return result.failed > 0 ? 1 : 0;
      }
      ctx.io.out(
        renderTable(
          [
            { header: 'CONNECTION', get: (r: (typeof result.data)[number]) => r.connection_id },
            { header: 'RESULT', get: (r) => r.status },
            { header: 'REASON', get: (r) => r.reason ?? '' },
          ],
          result.data,
        ),
      );
      ctx.io.out(result.dry_run ? `Would move ${result.would_move} connection(s).` : `Moved ${result.moved}, failed ${result.failed}, skipped ${result.skipped}${result.same_app ? ' (same provider app: tokens kept)' : ''}.`);
      return result.failed > 0 ? 1 : 0;
    }

    default:
      throw new CliError(sub ? `Unknown subcommand 'connections ${sub}'. Try: templates, rehome.` : 'connections needs a subcommand: templates, rehome.');
  }
}

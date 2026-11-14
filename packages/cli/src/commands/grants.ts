import type { ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { fmtTime, printJson, renderTable } from '../output';
import { requireArg, requireClient, wantsJson } from './shared';

/** `atlas grants usage <machine|agent> <grant-id>` — the live counters of one grant. */
export async function grants(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  const json = wantsJson(args.values);

  if (sub !== 'usage') {
    throw new CliError(sub ? `Unknown subcommand 'grants ${sub}'. Try: usage.` : 'grants needs a subcommand: usage.');
  }
  const type = requireArg(args.positionals, 2, 'machine|agent');
  if (type !== 'machine' && type !== 'agent') throw new CliError(`Unknown grant type '${type}'. Use machine or agent.`);
  const id = requireArg(args.positionals, 3, 'grant-id');
  const { client } = requireClient(ctx, args.values);
  const usage = await client.grantUsage.usage(type, id);
  if (json) {
    printJson(ctx.io, usage);
    return 0;
  }
  ctx.io.out(`${type} grant ${usage.grant_id} (machine ${usage.machine_id}) is ${usage.live ? 'live' : 'not live'}.`);
  ctx.io.out(
    renderTable(
      [
        { header: 'COUNTER', get: (c: (typeof usage.counters)[number]) => c.counter },
        { header: 'USED', get: (c) => c.used },
        { header: 'LIMIT', get: (c) => c.limit },
        { header: 'REMAINING', get: (c) => c.remaining },
        { header: 'WINDOW', get: (c) => c.window },
        { header: 'RESETS', get: (c) => fmtTime(c.resets_at) },
      ],
      usage.counters,
    ),
  );
  if (usage.leases.length > 0) {
    ctx.io.out('');
    ctx.io.out('Open leases:');
    ctx.io.out(
      renderTable(
        [
          { header: 'LEASE', get: (l: (typeof usage.leases)[number]) => l.id },
          { header: 'COUNTER', get: (l) => l.counter },
          { header: 'AMOUNT', get: (l) => l.amount },
          { header: 'EXPIRES', get: (l) => fmtTime(l.expires_at) },
        ],
        usage.leases,
      ),
    );
  }
  return 0;
}

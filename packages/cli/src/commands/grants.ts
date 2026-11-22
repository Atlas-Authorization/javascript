import { limit, str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { fmtTime, printJson, renderTable } from '../output';
import { requireArg, requireClient, wantsJson } from './shared';

/** `atlas grants list` (GET /v1/grants) and `atlas grants get` (GET /v1/grants/{id}) read consent and managed grants; `atlas grants usage <machine|agent> <grant-id>` shows the live counters of one grant. */
export async function grants(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  const json = wantsJson(args.values);

  if (sub === 'list') {
    const { client } = requireClient(ctx, args.values);
    const page = await client.grants.list({
      user_id: str(args.values, 'user-id'),
      type: str(args.values, 'type') as 'consent' | 'managed' | 'all' | undefined,
      status: str(args.values, 'status') as 'active' | 'revoked' | 'all' | undefined,
      limit: limit(args.values),
      starting_after: str(args.values, 'starting-after'),
    });
    if (json) printJson(ctx.io, page);
    else {
      ctx.io.out(
        renderTable(
          [
            { header: 'ID', get: (g: (typeof page.data)[number]) => g.id },
            { header: 'TYPE', get: (g) => g.type },
            { header: 'USER', get: (g) => g.user_id },
            { header: 'CLIENT', get: (g) => g.client_id ?? '' },
            { header: 'STATUS', get: (g) => g.status },
            { header: 'LAST USED', get: (g) => fmtTime(g.last_used_at) },
          ],
          page.data,
        ),
      );
      if (page.has_more) ctx.io.out(`More: --starting-after ${page.next_cursor}`);
    }
    return 0;
  }
  if (sub === 'get') {
    const { client } = requireClient(ctx, args.values);
    printJson(ctx.io, await client.grants.get(requireArg(args.positionals, 2, 'grant-id')));
    return 0;
  }
  if (sub !== 'usage') {
    throw new CliError(sub ? `Unknown subcommand 'grants ${sub}'. Try: list, get, usage.` : 'grants needs a subcommand: list, get, usage.');
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

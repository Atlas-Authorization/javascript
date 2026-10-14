import type { WebhookEndpoint } from '@atlasauth/backend';
import type { ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { fmtTime, printJson, renderTable, type Column } from '../output';
import { requireClient, wantsJson } from './shared';

const COLUMNS: Column<WebhookEndpoint>[] = [
  { header: 'ID', get: (w) => w.id },
  { header: 'URL', get: (w) => w.url },
  { header: 'ACTIVE', get: (w) => w.active },
  { header: 'EVENTS', get: (w) => w.enabled_events },
  { header: 'CREATED', get: (w) => fmtTime(w.created_at) },
];

/** `atlas webhooks list` — the one read `client.webhooks` exposes for endpoints. */
export async function webhooks(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  const json = wantsJson(args.values);

  switch (sub) {
    case 'list': {
      const { client } = requireClient(ctx, args.values);
      const page = await client.webhooks.endpoints.list();
      if (json) printJson(ctx.io, page);
      else ctx.io.out(renderTable(COLUMNS, page.data));
      return 0;
    }

    default:
      throw new CliError(
        sub
          ? `Unknown subcommand 'webhooks ${sub}'. Try: list.`
          : 'webhooks needs a subcommand: list.',
      );
  }
}

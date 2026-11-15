import { limit, str } from '../args';
import type { ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { fmtTime, printJson, renderTable } from '../output';
import { requireArg, requireClient, wantsJson } from './shared';

/**
 * `atlas oauth-clients consents <client> [--status active|revoked|all]` lists who authorized an app;
 * `atlas oauth-clients revoke-consents <client> [user-id...] --yes` revokes them (and their tokens) in bulk.
 */
export async function oauthClients(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  const json = wantsJson(args.values);

  switch (sub) {
    case 'consents': {
      const id = requireArg(args.positionals, 2, 'client-id');
      const status = str(args.values, 'status');
      if (status !== undefined && !['active', 'revoked', 'all'].includes(status)) throw new CliError('--status must be active, revoked or all.');
      const { client } = requireClient(ctx, args.values);
      const page = await client.oauthClients.listConsents(id, {
        ...(status ? { status: status as 'active' | 'revoked' | 'all' } : {}),
        limit: limit(args.values),
        starting_after: str(args.values, 'starting-after'),
      });
      if (json) {
        printJson(ctx.io, page);
        return 0;
      }
      ctx.io.out(
        renderTable(
          [
            { header: 'USER', get: (c: (typeof page.data)[number]) => c.user_id },
            { header: 'STATUS', get: (c) => c.status },
            { header: 'SCOPES', get: (c) => c.scopes.join(' ') },
            { header: 'AUTHORIZED', get: (c) => fmtTime(c.created_at) },
            { header: 'LAST USED', get: (c) => fmtTime(c.last_used_at) },
          ],
          page.data,
        ),
      );
      if (page.has_more) ctx.io.out(`More: --starting-after ${page.next_cursor}`);
      return 0;
    }

    case 'revoke-consents': {
      const id = requireArg(args.positionals, 2, 'client-id');
      const userIds = args.positionals.slice(3);
      if (args.values.yes !== true) {
        throw new CliError(`This signs ${userIds.length > 0 ? `${userIds.length} user(s)` : 'every user'} out of the app and revokes their tokens; pass --yes to confirm.`);
      }
      const { client } = requireClient(ctx, args.values);
      const result = await client.oauthClients.revokeConsents(id, userIds.length > 0 ? { user_ids: userIds } : {});
      if (json) printJson(ctx.io, result);
      else ctx.io.out(`Revoked ${result.consents_revoked} consent(s) and ${result.tokens_revoked} token grant(s).`);
      return 0;
    }

    default:
      throw new CliError(sub ? `Unknown subcommand 'oauth-clients ${sub}'. Try: consents, revoke-consents.` : 'oauth-clients needs a subcommand: consents, revoke-consents.');
  }
}

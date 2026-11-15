import type { ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import { requireArg, requireClient, wantsJson } from './shared';

/** `atlas sessions revoke <id>` — the one mutation `client.sessions` exposes by id. */
export async function sessions(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  const json = wantsJson(args.values);

  switch (sub) {
    case 'revoke': {
      const id = requireArg(args.positionals, 2, 'session-id');
      const { client } = requireClient(ctx, args.values);
      const result = await client.sessions.revoke(id);
      if (json) printJson(ctx.io, result);
      else ctx.io.out(`Revoked session ${result.id} (status: ${result.status}).`);
      return 0;
    }

    case 'binding': {
      const id = requireArg(args.positionals, 2, 'session-id');
      const { client } = requireClient(ctx, args.values);
      const b = await client.sessionBindings.get(id);
      if (json) printJson(ctx.io, b);
      else ctx.io.out(b.bound ? `Session ${id} is bound to key ${b.jkt} (${b.alg}${b.attested ? `, attested by ${b.attestation_provider ?? 'the app'}` : ''}).` : `Session ${id} is not bound to a key.`);
      return 0;
    }

    case 'unbind': {
      const id = requireArg(args.positionals, 2, 'session-id');
      const { client } = requireClient(ctx, args.values);
      const result = await client.sessionBindings.remove(id);
      if (json) printJson(ctx.io, result);
      else ctx.io.out(`Removed the key binding of session ${id}: it can bind a new key.`);
      return 0;
    }

    default:
      throw new CliError(
        sub
          ? `Unknown subcommand 'sessions ${sub}'. Try: revoke, binding, unbind.`
          : 'sessions needs a subcommand: revoke, binding, unbind.',
      );
  }
}

import type { User } from '@atlasauth/backend';
import { limit, str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { fmtTime, printJson, printList, type Column } from '../output';
import { requireArg, requireClient, wantsJson } from './shared';

/** Columns for the human `users list` table — User carries no email inline. */
const COLUMNS: Column<User>[] = [
  { header: 'ID', get: (u) => u.id },
  { header: 'USERNAME', get: (u) => u.username },
  { header: 'NAME', get: (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') },
  { header: 'BANNED', get: (u) => u.banned },
  { header: 'CREATED', get: (u) => fmtTime(u.created_at) },
];

/** `atlas users <list|get|create|delete>` — maps 1:1 onto `client.users.*`. */
export async function users(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  const json = wantsJson(args.values);

  switch (sub) {
    case 'list': {
      const { client } = requireClient(ctx, args.values);
      // users.list is cursor-paginated: { data, has_more, next_cursor }.
      const page = await client.users.list({
        limit: limit(args.values),
        starting_after: str(args.values, 'starting-after'),
      });
      printList(ctx.io, { json, columns: COLUMNS }, page);
      return 0;
    }

    case 'get': {
      const id = requireArg(args.positionals, 2, 'user-id');
      const { client } = requireClient(ctx, args.values);
      const user = await client.users.get(id);
      if (json) printJson(ctx.io, user);
      else ctx.io.out(renderUser(user));
      return 0;
    }

    case 'create': {
      const email = str(args.values, 'email');
      if (!email) throw new CliError("users create requires --email <address>.");
      const { client } = requireClient(ctx, args.values);
      const user = await client.users.create({
        email_address: email,
        first_name: str(args.values, 'first-name'),
        last_name: str(args.values, 'last-name'),
        password: str(args.values, 'password'),
      });
      if (json) printJson(ctx.io, user);
      else ctx.io.out(`Created user ${user.id}.`);
      return 0;
    }

    case 'delete': {
      const id = requireArg(args.positionals, 2, 'user-id');
      const { client } = requireClient(ctx, args.values);
      const result = await client.users.delete(id);
      if (json) printJson(ctx.io, result);
      else ctx.io.out(`Deleted user ${result.id}.`);
      return 0;
    }

    default:
      throw new CliError(
        sub
          ? `Unknown subcommand 'users ${sub}'. Try: list, get, create, delete.`
          : "users needs a subcommand: list, get, create, delete.",
      );
  }
}

/** A single user as a compact key/value block for the non-JSON `get`. */
function renderUser(u: User): string {
  return [
    `ID:         ${u.id}`,
    `Username:   ${u.username ?? ''}`,
    `Name:       ${[u.first_name, u.last_name].filter(Boolean).join(' ')}`,
    `Banned:     ${u.banned}`,
    `Locked:     ${u.locked}`,
    `MFA:        ${u.mfa_enabled}`,
    `Last sign-in: ${fmtTime(u.last_sign_in_at)}`,
    `Created:    ${fmtTime(u.created_at)}`,
  ].join('\n');
}

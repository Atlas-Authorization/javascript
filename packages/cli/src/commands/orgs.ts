import type { Organization, OrganizationMembership } from '@atlasauth/backend';
import { limit, str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { fmtTime, printJson, printList, renderTable, type Column } from '../output';
import { requireArg, requireClient, wantsJson } from './shared';

const ORG_COLUMNS: Column<Organization>[] = [
  { header: 'ID', get: (o) => o.id },
  { header: 'NAME', get: (o) => o.name },
  { header: 'SLUG', get: (o) => o.slug },
  { header: 'MEMBERS_MAX', get: (o) => o.max_allowed_memberships },
  { header: 'CREATED', get: (o) => fmtTime(o.created_at) },
];

const MEMBER_COLUMNS: Column<OrganizationMembership>[] = [
  { header: 'ID', get: (m) => m.id },
  { header: 'USER_ID', get: (m) => m.user_id },
  { header: 'ROLE', get: (m) => m.role },
  { header: 'CREATED', get: (m) => fmtTime(m.created_at) },
];

/** `atlas orgs <list|get|members>` — maps onto `client.organizations.*`. */
export async function orgs(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  const json = wantsJson(args.values);

  switch (sub) {
    case 'list': {
      const { client } = requireClient(ctx, args.values);
      const page = await client.organizations.list({
        limit: limit(args.values),
        starting_after: str(args.values, 'starting-after'),
      });
      printList(ctx.io, { json, columns: ORG_COLUMNS }, page);
      return 0;
    }

    case 'get': {
      const id = requireArg(args.positionals, 2, 'org-id');
      const { client } = requireClient(ctx, args.values);
      const org = await client.organizations.get(id);
      if (json) printJson(ctx.io, org);
      else ctx.io.out(renderOrg(org));
      return 0;
    }

    case 'members': {
      const id = requireArg(args.positionals, 2, 'org-id');
      const { client } = requireClient(ctx, args.values);
      // memberships.list returns { data, has_more } — no cursor on this route.
      const page = await client.organizations.memberships.list(id);
      if (json) printJson(ctx.io, page);
      else ctx.io.out(renderTable(MEMBER_COLUMNS, page.data));
      return 0;
    }

    default:
      throw new CliError(
        sub
          ? `Unknown subcommand 'orgs ${sub}'. Try: list, get, members.`
          : 'orgs needs a subcommand: list, get, members.',
      );
  }
}

function renderOrg(o: Organization): string {
  return [
    `ID:       ${o.id}`,
    `Name:     ${o.name}`,
    `Slug:     ${o.slug}`,
    `Max members: ${o.max_allowed_memberships}`,
    `Created by:  ${o.created_by}`,
    `Created:  ${fmtTime(o.created_at)}`,
  ].join('\n');
}

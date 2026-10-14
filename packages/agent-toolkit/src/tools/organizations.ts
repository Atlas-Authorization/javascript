import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../types';

const pagination = {
  limit: z.number().int().min(1).max(100).optional().describe('Page size (1-100).'),
  starting_after: z
    .string()
    .optional()
    .describe('Opaque cursor from a previous page\'s `next_cursor`.'),
};

/**
 * Organization tools, including membership management. `get`, `list`, and
 * `get_organization_members` are reads; create/update/delete the org and
 * add/remove/re-role a member are gated writes (delete the org is a gated
 * DELETE).
 */
export function organizationTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'get_organization',
      description: 'Fetch a single organization by its id (e.g. "org_123").',
      resource: 'organizations',
      verb: 'read',
      schema: z.object({ organization_id: z.string().describe('The organization id to fetch.') }),
      execute: (args, { backend }) => backend.organizations.get(args.organization_id),
    }),

    defineTool({
      name: 'list_organizations',
      description:
        'List organizations, one cursor page at a time. Returns `{ data, has_more, next_cursor }`.',
      resource: 'organizations',
      verb: 'read',
      schema: z.object(pagination),
      execute: (args, { backend }) => backend.organizations.list(args),
    }),

    defineTool({
      name: 'get_organization_members',
      description:
        'List the memberships of one organization: each row is a user id plus their role in the org.',
      resource: 'organizations',
      verb: 'read',
      schema: z.object({ organization_id: z.string().describe('The organization id.') }),
      execute: (args, { backend }) =>
        backend.organizations.memberships.list(args.organization_id),
    }),

    defineTool({
      name: 'create_organization',
      description:
        'Create an organization. Requires a name, a URL slug, and the user id of its creator ' +
        '(who becomes the first admin). A gated write.',
      resource: 'organizations',
      verb: 'write',
      schema: z.object({
        name: z.string().describe('Human-readable organization name.'),
        slug: z.string().describe('URL-safe slug, unique within the instance.'),
        created_by: z.string().describe('The Atlas user id of the creator / first admin.'),
        max_allowed_memberships: z.number().int().positive().optional(),
      }),
      execute: (args, { backend }) => backend.organizations.create(args),
    }),

    defineTool({
      name: 'update_organization',
      description:
        'Update an organization\'s name, slug, image, membership cap, or public metadata. ' +
        'Only the fields you pass change. A gated write.',
      resource: 'organizations',
      verb: 'write',
      schema: z.object({
        organization_id: z.string().describe('The organization id to update.'),
        name: z.string().optional(),
        slug: z.string().optional(),
        image_url: z.string().url().optional(),
        max_allowed_memberships: z.number().int().positive().optional(),
        public_metadata: z.record(z.unknown()).optional().describe('Public, non-sensitive metadata.'),
      }),
      execute: (args, { backend }) => {
        const { organization_id, ...body } = args;
        return backend.organizations.update(organization_id, body);
      },
    }),

    defineTool({
      name: 'delete_organization',
      description:
        'PERMANENTLY delete an organization and all its memberships. Irreversible. A gated DELETE — ' +
        'never available unless an integrator explicitly opts in.',
      resource: 'organizations',
      verb: 'delete',
      schema: z.object({ organization_id: z.string().describe('The organization id to delete.') }),
      execute: (args, { backend }) => backend.organizations.delete(args.organization_id),
    }),

    defineTool({
      name: 'add_organization_member',
      description:
        'Add an existing user to an organization with an optional role (defaults to the org\'s ' +
        'default member role). A gated write.',
      resource: 'organizations',
      verb: 'write',
      schema: z.object({
        organization_id: z.string().describe('The organization id.'),
        user_id: z.string().describe('The Atlas user id to add as a member.'),
        role: z.string().optional().describe('Role key to assign, e.g. "admin" or "member".'),
      }),
      execute: (args, { backend }) =>
        backend.organizations.memberships.add(args.organization_id, {
          user_id: args.user_id,
          role: args.role,
        }),
    }),

    defineTool({
      name: 'remove_organization_member',
      description: 'Remove a user from an organization. A gated write.',
      resource: 'organizations',
      verb: 'write',
      schema: z.object({
        organization_id: z.string().describe('The organization id.'),
        user_id: z.string().describe('The Atlas user id to remove.'),
      }),
      execute: (args, { backend }) =>
        backend.organizations.memberships.remove(args.organization_id, args.user_id),
    }),

    defineTool({
      name: 'update_organization_member_role',
      description: 'Change an existing member\'s role within an organization. A gated write.',
      resource: 'organizations',
      verb: 'write',
      schema: z.object({
        organization_id: z.string().describe('The organization id.'),
        user_id: z.string().describe('The member\'s Atlas user id.'),
        role: z.string().describe('The new role key to assign.'),
      }),
      execute: (args, { backend }) =>
        backend.organizations.memberships.update(args.organization_id, args.user_id, {
          role: args.role,
        }),
    }),
  ];
}

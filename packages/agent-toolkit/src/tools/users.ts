import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../types';

/** A reusable cursor-pagination fragment, matching the BAPI's list params. */
const pagination = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Page size (1-100). The server clamps to its own maximum.'),
  starting_after: z
    .string()
    .optional()
    .describe('Opaque cursor from a previous page\'s `next_cursor`, to fetch the next page.'),
};

/** A free-form, model-supplied public-metadata bag (never private/unsafe). */
const publicMetadata = z
  .record(z.unknown())
  .optional()
  .describe('Public, non-sensitive metadata. Never put secrets or PII you would not log here.');

/**
 * User tools. Reads (`get`, `list`) are safe by default; every mutation —
 * create, update, ban/unban, and the irreversible delete — is a gated write or
 * delete the integrator must explicitly allow.
 *
 * Note there is deliberately no "get user by email" tool: the Atlas
 * `GET /v1/users` surface exposes no email filter (see `ListUsersParams` in
 * `@atlasauth/backend`), so a lookup tool would have to scan every page — a
 * footgun we do not hand a model. Use `list_users` and filter downstream.
 */
export function userTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'get_user',
      description:
        'Fetch a single Atlas user by their id (e.g. "user_123"). Returns the public ' +
        'user record; private and unsafe metadata are never included.',
      resource: 'users',
      verb: 'read',
      schema: z.object({ user_id: z.string().describe('The Atlas user id to fetch.') }),
      execute: (args, { backend }) => backend.users.get(args.user_id),
    }),

    defineTool({
      name: 'list_users',
      description:
        'List Atlas users, newest first, one cursor page at a time. Returns `{ data, ' +
        'has_more, next_cursor }`; pass `next_cursor` back as `starting_after` for the next page.',
      resource: 'users',
      verb: 'read',
      schema: z.object(pagination),
      execute: (args, { backend }) => backend.users.list(args),
    }),

    defineTool({
      name: 'create_user',
      description:
        'Create a new Atlas user with an email address and optional name/password. ' +
        'A gated write — only available when explicitly allow-listed.',
      resource: 'users',
      verb: 'write',
      schema: z.object({
        email_address: z.string().email().describe('The new user\'s primary email address.'),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        password: z.string().optional().describe('Optional initial password.'),
        email_verified: z
          .boolean()
          .optional()
          .describe('Mark the email as already verified (skips the verification flow).'),
        public_metadata: publicMetadata,
      }),
      execute: (args, { backend }) => backend.users.create(args),
    }),

    defineTool({
      name: 'update_user',
      description:
        'Update a user\'s name or public metadata. A gated write — only the fields you pass ' +
        'are changed. Only available when explicitly allow-listed.',
      resource: 'users',
      verb: 'write',
      schema: z.object({
        user_id: z.string().describe('The Atlas user id to update.'),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        public_metadata: publicMetadata,
      }),
      execute: (args, { backend }) => {
        const { user_id, ...body } = args;
        return backend.users.update(user_id, body);
      },
    }),

    defineTool({
      name: 'ban_user',
      description:
        'Ban a user, immediately blocking their sign-in. Reversible with `unban_user`. ' +
        'A gated write — only available when explicitly allow-listed.',
      resource: 'users',
      verb: 'write',
      schema: z.object({ user_id: z.string().describe('The Atlas user id to ban.') }),
      execute: (args, { backend }) => backend.users.ban(args.user_id),
    }),

    defineTool({
      name: 'unban_user',
      description:
        'Lift a ban on a user, restoring their ability to sign in. A gated write — only ' +
        'available when explicitly allow-listed.',
      resource: 'users',
      verb: 'write',
      schema: z.object({ user_id: z.string().describe('The Atlas user id to unban.') }),
      execute: (args, { backend }) => backend.users.unban(args.user_id),
    }),

    defineTool({
      name: 'delete_user',
      description:
        'PERMANENTLY delete a user. This is irreversible and cascades to their sessions and ' +
        'memberships. A gated DELETE — never available unless an integrator explicitly opts in.',
      resource: 'users',
      verb: 'delete',
      schema: z.object({ user_id: z.string().describe('The Atlas user id to delete.') }),
      execute: (args, { backend }) => backend.users.delete(args.user_id),
    }),
  ];
}

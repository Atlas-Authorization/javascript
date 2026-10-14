import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../types';

/**
 * Session tools. Listing a user's sessions is a read; revoking one is a gated
 * write (it forcibly signs a device out).
 *
 * The toolkit deliberately exposes no "create session" tool: `sessions.create`
 * returns a bearer `jwt` and `refresh_token` in-body, credentials no model
 * should ever hold. Keeping it out of the surface is simpler and safer than
 * minting one and then stripping the very thing the caller wanted.
 */
export function sessionTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'list_user_sessions',
      description:
        'List the active and recent sessions for one user (each with its status, device ' +
        'activity, and expiry). The Atlas API scopes session listing to a single user, so a ' +
        'user id is required.',
      resource: 'sessions',
      verb: 'read',
      schema: z.object({
        user_id: z.string().describe('The Atlas user id whose sessions to list.'),
      }),
      execute: (args, { backend }) => backend.sessions.list({ user_id: args.user_id }),
    }),

    defineTool({
      name: 'revoke_session',
      description:
        'Revoke one session by its id, immediately signing that device out. A gated write.',
      resource: 'sessions',
      verb: 'write',
      schema: z.object({ session_id: z.string().describe('The session id to revoke.') }),
      execute: (args, { backend }) => backend.sessions.revoke(args.session_id),
    }),
  ];
}

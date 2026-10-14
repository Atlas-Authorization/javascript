import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../types';

/**
 * Instance-level invitation tools (the invite-a-person-to-the-app flow, not the
 * per-organization invitations). `list` is a read; create and revoke are gated
 * writes.
 */
export function invitationTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'list_invitations',
      description:
        'List pending/accepted instance invitations, one cursor page at a time. Returns ' +
        '`{ data, has_more, next_cursor }`.',
      resource: 'invitations',
      verb: 'read',
      schema: z.object({
        limit: z.number().int().min(1).max(100).optional().describe('Page size (1-100).'),
        starting_after: z
          .string()
          .optional()
          .describe('Opaque cursor from a previous page\'s `next_cursor`.'),
      }),
      execute: (args, { backend }) => backend.invitations.list(args),
    }),

    defineTool({
      name: 'create_invitation',
      description:
        'Invite a person to the app by email. Atlas sends them an invitation to create an ' +
        'account. A gated write.',
      resource: 'invitations',
      verb: 'write',
      schema: z.object({
        email_address: z.string().email().describe('The email address to invite.'),
        public_metadata: z
          .record(z.unknown())
          .optional()
          .describe('Public, non-sensitive metadata carried onto the created user.'),
      }),
      execute: (args, { backend }) => backend.invitations.create(args),
    }),

    defineTool({
      name: 'revoke_invitation',
      description: 'Revoke a pending invitation so its link can no longer be redeemed. A gated write.',
      resource: 'invitations',
      verb: 'write',
      schema: z.object({ invitation_id: z.string().describe('The invitation id to revoke.') }),
      execute: (args, { backend }) => backend.invitations.revoke(args.invitation_id),
    }),
  ];
}

import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../types';

/**
 * End-user API-key tools (the keys a tenant mints for ITS users/orgs). `list`
 * is a read; create and revoke are gated writes.
 *
 * Security note: `create_api_key` returns the key's metadata and `prefix`, but
 * NOT the one-time `ak_` secret — {@link ../sanitize.sanitize} strips `secret`
 * from every result by construction, so the plaintext credential is never
 * handed to a model. An integrator that needs the secret must mint the key
 * through `@atlasauth/backend` directly, outside the agent surface.
 */
export function apiKeyTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'list_api_keys',
      description:
        'List API keys, optionally narrowed to one subject (a user or an organization). Only key ' +
        'metadata and a short non-usable `prefix` are returned, never a usable secret.',
      resource: 'api_keys',
      verb: 'read',
      schema: z.object({
        subject_type: z
          .enum(['user', 'organization'])
          .optional()
          .describe('Narrow to keys owned by a user or by an organization.'),
        subject_id: z
          .string()
          .optional()
          .describe('Narrow to one subject id (used with subject_type).'),
      }),
      execute: (args, { backend }) =>
        backend.apiKeys.list(
          args.subject_type || args.subject_id
            ? { subject_type: args.subject_type, subject_id: args.subject_id }
            : undefined,
        ),
    }),

    defineTool({
      name: 'create_api_key',
      description:
        'Mint an API key for a user or organization. A gated write. The one-time secret is NOT ' +
        'returned to the agent (only the key id and prefix); mint through the backend directly if ' +
        'you need the plaintext secret.',
      resource: 'api_keys',
      verb: 'write',
      schema: z.object({
        subject_type: z.enum(['user', 'organization']).describe('Who owns the key.'),
        subject_id: z.string().describe('The owning user or organization id.'),
        name: z.string().optional().describe('A human label for the key.'),
        claims: z
          .record(z.unknown())
          .optional()
          .describe('Custom claims embedded in the key\'s verification result.'),
        expires_at: z
          .number()
          .int()
          .nullish()
          .describe('Expiry as epoch milliseconds; null or omitted never expires.'),
      }),
      execute: (args, { backend }) => backend.apiKeys.create(args),
    }),

    defineTool({
      name: 'revoke_api_key',
      description:
        'Revoke an API key by id. It stays queryable for audit but never authenticates again. A gated write.',
      resource: 'api_keys',
      verb: 'write',
      schema: z.object({ api_key_id: z.string().describe('The API key id to revoke.') }),
      execute: (args, { backend }) => backend.apiKeys.delete(args.api_key_id),
    }),
  ];
}

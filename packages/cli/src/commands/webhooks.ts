import type { WebhookEndpoint } from '@atlasauth/backend';
import { list, str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { fmtTime, printJson, renderTable, type Column } from '../output';
import { httpFor } from '../project';
import { deliverSecret } from '../secrets';
import { requireClient, resolveAuth, wantsJson } from './shared';

const COLUMNS: Column<WebhookEndpoint>[] = [
  { header: 'ID', get: (w) => w.id },
  { header: 'URL', get: (w) => w.url },
  { header: 'ACTIVE', get: (w) => w.active },
  { header: 'EVENTS', get: (w) => w.enabled_events },
  { header: 'CREATED', get: (w) => fmtTime(w.created_at) },
];

/**
 * `atlas webhooks list | create`. `create` writes the endpoint's signing secret
 * to a 0600 file (never printed unless --print-secret).
 */
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

    case 'create': {
      const url = str(args.values, 'url');
      if (!url) throw new CliError('webhooks create requires --url <https-url>.');
      const events = list(args.values, 'events');
      const auth = resolveAuth(ctx, args.values);
      const endpoint = await httpFor(ctx, { secretKey: auth.secretKey, apiUrl: auth.apiUrl }).post<
        WebhookEndpoint & { secret?: string }
      >('/v1/webhook_endpoints', { url, ...(events.length ? { enabled_events: events } : {}) });
      const { secret, ...rest } = endpoint;
      let secretFile: string | undefined;
      if (secret) {
        secretFile = deliverSecret({
          io: json ? { out: () => undefined, err: ctx.io.err } : ctx.io,
          env: ctx.env,
          product: str(args.values, 'product') ?? 'atlasauth',
          fileName: `webhook-${endpoint.id}.env`,
          entries: { ATLAS_WEBHOOK_SECRET: secret },
          label: 'The signing secret',
          printSecret: args.values['print-secret'] === true,
          force: args.values.force === true,
          comment: `Signing secret for webhook endpoint ${endpoint.id} (${url}).`,
        }).path;
      }
      if (json) printJson(ctx.io, args.values['print-secret'] === true ? endpoint : { ...rest, secret_file: secretFile ?? null });
      else ctx.io.out(`Created webhook endpoint ${endpoint.id} → ${endpoint.url}.`);
      return 0;
    }

    default:
      throw new CliError(
        sub
          ? `Unknown subcommand 'webhooks ${sub}'. Try: list, create.`
          : 'webhooks needs a subcommand: list, create.',
      );
  }
}

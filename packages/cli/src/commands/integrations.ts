import type { Integration, IntegrationDelivery, SetIntegrationBody } from '@atlasauth/backend';
import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { fmtTime, printJson, renderTable, type Column } from '../output';
import { httpFor } from '../project';
import { resolveAuth, wantsJson } from './shared';

const COLUMNS: Column<Integration>[] = [
  { header: 'ID', get: (i) => i.id },
  { header: 'NAME', get: (i) => i.name ?? i.id },
  { header: 'STATUS', get: (i) => (i.connected ? (i.enabled ? 'on' : 'off') : 'not connected') },
  { header: 'AUDIENCE', get: (i) => i.audience ?? '' },
  { header: 'LAST MINT', get: (i) => (i.health?.last_minted_at ? fmtTime(i.health.last_minted_at) : '') },
  { header: 'REFUSED 24H', get: (i) => i.health?.verify_errors_24h ?? '' },
];

const DELIVERY_COLUMNS: Column<IntegrationDelivery>[] = [
  { header: 'WHEN', get: (d) => fmtTime(d.created_at) },
  { header: 'KIND', get: (d) => (d.kind === 'event' ? (d.event_type ?? 'event') : 'back-channel logout') },
  { header: 'STATUS', get: (d) => d.status },
  { header: 'HTTP', get: (d) => d.http_status ?? '' },
  { header: 'ERROR', get: (d) => d.error ?? '' },
  { header: 'TRACE', get: (d) => d.trace_id ?? '' },
];

/** A URL flag: absent = unchanged (preset default), "none" = null (no receiver). */
const urlFlag = (v: string | undefined): string | null | undefined => (v === undefined ? undefined : v === 'none' ? null : v);

/**
 * `atlas integrations list | get <id> | set <id> | remove <id> | deliveries <id>`:
 * identity integrations — the presets (chatly, forumulate, cookiemunch,
 * referalli) and custom ones — with their health and delivery log.
 */
export async function integrations(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  const id = args.positionals[2];
  const json = wantsJson(args.values);
  const http = () => {
    const auth = resolveAuth(ctx, args.values);
    return httpFor(ctx, { secretKey: auth.secretKey, apiUrl: auth.apiUrl });
  };
  const path = (i: string, rest = '') => `/v1/instance/integrations/${encodeURIComponent(i)}${rest}`;
  const needId = () => {
    if (!id) throw new CliError(`integrations ${sub} needs an integration id (a preset such as chatly, or your own id).`);
    return id;
  };

  switch (sub) {
    case 'list': {
      const page = await http().get<{ data: Integration[] }>('/v1/instance/integrations');
      if (json) printJson(ctx.io, page);
      else ctx.io.out(renderTable(COLUMNS, page.data));
      return 0;
    }
    case 'get': {
      printJson(ctx.io, await http().get<Integration>(path(needId())));
      return 0;
    }
    case 'set': {
      const target = needId();
      const body: SetIntegrationBody = {};
      const audience = str(args.values, 'audience');
      if (audience) body.audience = audience;
      const name = str(args.values, 'name');
      if (name) body.name = name;
      const events = urlFlag(str(args.values, 'events-url'));
      if (events !== undefined) body.events_url = events;
      const bcl = urlFlag(str(args.values, 'backchannel-logout-url'));
      if (bcl !== undefined) body.backchannel_logout_url = bcl;
      const oauthClient = urlFlag(str(args.values, 'oauth-client-id'));
      if (oauthClient !== undefined) body.oauth_client_id = oauthClient;
      if (args.values.disable === true) body.enabled = false;
      if (Object.keys(body).length === 0) throw new CliError('integrations set needs --audience (and --name for a custom integration), or --disable.');
      const saved = await http().put<Integration>(path(target, args.values['dry-run'] === true ? '?dry_run=true' : ''), body);
      if (json) printJson(ctx.io, saved);
      else
        ctx.io.out(
          `${saved.dry_run ? 'Would save' : 'Saved'} ${saved.id}: ${saved.enabled ? 'on' : 'off'}, audience ${saved.audience}. In your app: getToken({ for: '${saved.id}' }).`,
        );
      return 0;
    }
    case 'remove': {
      const target = needId();
      await http().delete(path(target));
      if (json) printJson(ctx.io, { id: target, removed: true });
      else ctx.io.out(`Removed ${target}.`);
      return 0;
    }
    case 'deliveries': {
      const trace = str(args.values, 'trace');
      const page = await http().get<{ data: IntegrationDelivery[] }>(
        path(needId(), `/deliveries${trace ? `?trace=${encodeURIComponent(trace)}` : ''}`),
      );
      if (json) printJson(ctx.io, page);
      else ctx.io.out(renderTable(DELIVERY_COLUMNS, page.data));
      return 0;
    }
    default:
      throw new CliError(
        sub
          ? `Unknown subcommand 'integrations ${sub}'. Try: list, get, set, remove, deliveries.`
          : 'integrations needs a subcommand: list, get, set, remove, deliveries.',
      );
  }
}

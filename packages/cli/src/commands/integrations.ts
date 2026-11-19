import type { Integration, IntegrationDelivery, SetIntegrationBody } from '@atlasauth/backend';
import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { fmtTime, printJson, renderTable, type Column } from '../output';
import { httpFor } from '../project';
import { resolveAuth, wantsJson } from './shared';
import { readKeyFile } from './referrals';

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

interface HealthRow {
  kind: string;
  id: string;
  name: string | null;
  managed_by: string | null;
  destination: string | null;
  state: string;
  last_success_at: number | null;
  consecutive_failures: number;
}
const HEALTH_COLUMNS: Column<HealthRow>[] = [
  { header: 'KIND', get: (r) => r.kind },
  { header: 'NAME', get: (r) => r.name ?? r.id },
  { header: 'MANAGED BY', get: (r) => r.managed_by ?? '' },
  { header: 'DESTINATION', get: (r) => r.destination ?? '' },
  { header: 'STATE', get: (r) => r.state },
  { header: 'LAST OK', get: (r) => (r.last_success_at ? fmtTime(r.last_success_at) : '') },
  { header: 'FAILS', get: (r) => r.consecutive_failures },
];

const FORWARDING_DESTINATIONS = ['lucida', 'hermetica', 'seolyticize', 'webhook'];

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
    case 'health': {
      const page = await http().get<{ data: HealthRow[]; unhealthy_count: number }>('/v1/instance/integrations/health');
      if (json) printJson(ctx.io, page);
      else {
        ctx.io.out(renderTable(HEALTH_COLUMNS, page.data));
        ctx.io.out(page.unhealthy_count ? `${page.unhealthy_count} failing or disabled.` : 'Nothing failing.');
      }
      return 0;
    }
    case 'forwarding': {
      // atlas integrations forwarding show|set|remove <lucida|hermetica|seolyticize|webhook>
      const action = id;
      const dest = args.positionals[3];
      if ((action !== 'set' && action !== 'remove' && action !== 'show') || !dest || !FORWARDING_DESTINATIONS.includes(dest)) {
        throw new CliError(`integrations forwarding needs: show|set|remove <${FORWARDING_DESTINATIONS.join('|')}>.`);
      }
      const url = `/v1/instance/integrations/forwarding/${dest}`;
      if (action === 'show') {
        const found = await http().get<{ id?: string; active?: boolean }>(url);
        if (json) printJson(ctx.io, found);
        else ctx.io.out(`Forwarding user.created to ${dest} (endpoint ${found.id ?? 'unknown'}, ${found.active === false ? 'inactive' : 'active'}).`);
        return 0;
      }
      if (action === 'remove') {
        await http().delete(url);
        if (json) printJson(ctx.io, { forwarding: dest, removed: true });
        else ctx.io.out(`Stopped forwarding sign-ups to ${dest}.`);
        return 0;
      }
      const body: Record<string, unknown> = {};
      if (dest === 'webhook') {
        const target = str(args.values, 'url');
        if (target) body.url = target;
      } else {
        const keyFile = str(args.values, 'secret-file');
        if (keyFile) body.server_key = readKeyFile(ctx, keyFile, `the ${dest} server key`);
        const host = str(args.values, 'host');
        if (host) body.host = host;
        if (args.values['include-pii'] === true && dest !== 'hermetica') body.include_pii = true;
        if (dest === 'seolyticize') {
          const site = str(args.values, 'site-key');
          if (site) body.site_key = site;
          const conv = str(args.values, 'conversion-event');
          if (conv) body.conversion_event = conv;
        }
      }
      if (args.values.active === true) body.active = true;
      if (args.values.inactive === true) body.active = false;
      const saved = await http().put<{ id?: string; created?: boolean }>(url, body);
      if (json) printJson(ctx.io, saved);
      else ctx.io.out(`${saved.created ? 'Now forwarding' : 'Updated forwarding of'} user.created to ${dest}${saved.id ? ` (endpoint ${saved.id})` : ''}.`);
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
          ? `Unknown subcommand 'integrations ${sub}'. Try: list, health, forwarding, get, set, remove, deliveries.`
          : 'integrations needs a subcommand: list, health, forwarding, get, set, remove, deliveries.',
      );
  }
}

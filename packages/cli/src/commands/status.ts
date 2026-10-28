import type { ServiceStatus, StatusDependency, StatusIncident, StatusSubscription } from '@atlasauth/backend';
import type { ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { printJson, renderTable, type Column } from '../output';
import { httpFor } from '../project';
import { instanceCredential } from './project-commands';
import { wantsJson } from './shared';

/**
 * `atlas status`: "is it Atlas, a service we depend on, or us?" in one look.
 * Atlas's own components and the open incidents that concern this instance,
 * the instance's incident subscription, and the state of every upstream status
 * page it declared. Exits 1 when Atlas or an enabled dependency reports a
 * partial or major outage, so a script can branch on it.
 */

const OUTAGE = new Set(['partial_outage', 'major_outage']);

const COMPONENT_COLUMNS: Column<ServiceStatus['components'][number]>[] = [
  { header: 'COMPONENT', get: (c) => c.id },
  { header: 'STATUS', get: (c) => c.status },
  { header: 'REGIONS', get: (c) => c.regions },
];

const INCIDENT_COLUMNS: Column<StatusIncident>[] = [
  { header: 'INCIDENT', get: (i) => i.id },
  { header: 'STATUS', get: (i) => i.status },
  { header: 'IMPACT', get: (i) => (i.kind === 'maintenance' ? 'maintenance' : i.impact) },
  { header: 'REGIONS', get: (i) => (i.regions.length ? i.regions : 'all') },
  { header: 'TITLE', get: (i) => i.title },
];

const DEPENDENCY_COLUMNS: Column<StatusDependency>[] = [
  { header: 'DEPENDENCY', get: (d) => d.name },
  { header: 'STATE', get: (d) => (d.enabled ? `${d.state}${d.stale ? ' (stale)' : ''}` : 'disabled') },
  { header: 'URL', get: (d) => d.url },
  { header: 'LAST ERROR', get: (d) => d.last_error ?? '' },
];

function subscriptionLine(s: StatusSubscription): string {
  if (!s.subscribed) return 'Subscription:  none (no incident notifications; set one up in the dashboard under Instance health, Status & upstream)';
  if (!s.enabled) return 'Subscription:  disabled';
  const regions = s.regions.length ? s.regions.join(', ') : 'all regions';
  const components = s.component_ids.length ? s.component_ids.join(', ') : 'all components';
  const channels = [s.email_owners ? 'email' : null, s.webhook ? 'webhook' : null, 'rss'].filter(Boolean).join(', ');
  return `Subscription:  ${regions}; ${components}; impact ≥ ${s.min_impact}${s.include_maintenance ? ' + maintenance' : ''} (${channels})`;
}

export async function status(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const http = httpFor(ctx, instanceCredential(ctx, args));
  const [service, subscription, incidents, dependencies] = await Promise.all([
    http.get<ServiceStatus>('/v1/status'),
    http.get<StatusSubscription>('/v1/instance/status_subscription'),
    http.get<{ data: StatusIncident[] }>('/v1/instance/status_incidents?open=true'),
    http.get<{ data: StatusDependency[]; state: string }>('/v1/instance/status_dependencies'),
  ]);
  const atlasDown = service.status === 'major_outage' || (incidents.data ?? []).some((i) => i.kind === 'incident' && (i.impact === 'major' || i.impact === 'critical'));
  const upstreamDown = (dependencies.data ?? []).some((d) => d.enabled && OUTAGE.has(d.state));
  const code = atlasDown || upstreamDown ? 1 : 0;

  if (wantsJson(args.values)) {
    printJson(ctx.io, { service, subscription, incidents: incidents.data ?? [], dependencies: dependencies.data ?? [], dependencies_state: dependencies.state });
    return code;
  }
  ctx.io.out(`Atlas:         ${service.status}`);
  ctx.io.out(subscriptionLine(subscription));
  ctx.io.out('');
  ctx.io.out(renderTable(COMPONENT_COLUMNS, service.components ?? []));
  ctx.io.out('');
  if ((incidents.data ?? []).length === 0) ctx.io.out('No open Atlas incidents concern this instance.');
  else ctx.io.out(renderTable(INCIDENT_COLUMNS, incidents.data));
  ctx.io.out('');
  if ((dependencies.data ?? []).length === 0) ctx.io.out('No upstream status pages declared (POST /v1/instance/status_dependencies).');
  else {
    ctx.io.out(`Upstream:      ${dependencies.state}`);
    ctx.io.out(renderTable(DEPENDENCY_COLUMNS, dependencies.data));
  }
  return code;
}

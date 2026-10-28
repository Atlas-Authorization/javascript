import { enc, type RequestFn } from './request';

/**
 * Atlas service status for your instance: the incident subscription (owner
 * email, `status_incident.*` webhooks, a private RSS / Atom feed) filtered by
 * region, component and impact; the incidents that concern you; and the
 * upstream status pages (any Statuspage-compatible URL) your app depends on.
 *
 * The public Statuspage-compatible feed itself needs no key:
 * `https://<frontend api>/v1/status/api/v2/summary.json` (and the other
 * Statuspage files, RSS and Atom) — point any status page at it.
 */

export type StatusComponentId = 'frontend_api' | 'backend_api' | 'database' | 'cache' | 'background_jobs';
export type StatusImpact = 'none' | 'minor' | 'major' | 'critical';
export type StatusIncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved' | 'scheduled' | 'in_progress' | 'completed';
export type StatusDependencyState = 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'maintenance' | 'unknown';

/** `GET /v1/status` (public). */
export interface ServiceStatus {
  object: 'status';
  status: 'operational' | 'degraded' | 'major_outage';
  updated_at: number;
  regions: string[];
  groups: Array<{ id: string; name: string; component_ids: string[] }>;
  components: Array<{
    id: StatusComponentId;
    name: string;
    status: 'operational' | 'degraded' | 'major_outage' | 'unknown';
    description: string;
    group: string;
    regions: string[];
  }>;
  incidents: Array<{
    id: string;
    kind: 'incident' | 'maintenance';
    title: string;
    status: StatusIncidentStatus;
    impact: StatusImpact;
    regions: string[];
    component_ids: string[];
    started_at: number;
    resolved_at: number | null;
    updated_at: number;
  }>;
}

export interface StatusSubscription {
  object: 'status_subscription';
  /** A subscription exists (it may be disabled). */
  subscribed: boolean;
  enabled: boolean;
  /** [] = every region. */
  regions: string[];
  /** [] = every component. */
  component_ids: StatusComponentId[];
  min_impact: 'minor' | 'major' | 'critical';
  include_maintenance: boolean;
  email_owners: boolean;
  webhook: boolean;
  /** The private feed; treat it as a secret (`rotateFeed` replaces it). */
  rss_url: string | null;
  atom_url: string | null;
  available_regions: string[];
  available_components: Array<{ id: StatusComponentId; name: string }>;
  updated_at: number | null;
}

export interface UpdateStatusSubscriptionBody {
  enabled?: boolean;
  regions?: string[];
  component_ids?: StatusComponentId[];
  min_impact?: 'minor' | 'major' | 'critical';
  include_maintenance?: boolean;
  email_owners?: boolean;
  webhook?: boolean;
}

export interface StatusIncidentUpdate {
  id: string;
  status: StatusIncidentStatus;
  body: string;
  created_at: number;
}

export interface StatusIncident {
  object: 'status_incident';
  id: string;
  kind: 'incident' | 'maintenance';
  title: string;
  status: StatusIncidentStatus;
  impact: StatusImpact;
  regions: string[];
  component_ids: string[];
  started_at: number;
  resolved_at: number | null;
  updated_at: number;
  source: 'atlas' | 'import' | (string & {});
  scheduled_for: number | null;
  scheduled_until: number | null;
  /** Oldest first. */
  updates: StatusIncidentUpdate[];
}

/** `data` of the `status_incident.created` / `updated` / `resolved` webhook events. */
export interface StatusIncidentEventData {
  object: 'status_incident';
  id: string;
  kind: 'incident' | 'maintenance';
  title: string;
  status: StatusIncidentStatus;
  impact: StatusImpact;
  regions: string[];
  component_ids: string[];
  /** The part of the incident that matches your subscription. */
  affected_regions: string[];
  affected_component_ids: string[];
  started_at: number;
  resolved_at: number | null;
  update: StatusIncidentUpdate;
  /** The incident on the status page. */
  url: string;
}

export interface StatusDependency {
  object: 'status_dependency';
  id: string;
  name: string;
  /** Base URL of the Statuspage-compatible page (Atlas reads `{url}/api/v2/summary.json`). */
  url: string;
  component_filter: string[];
  enabled: boolean;
  state: StatusDependencyState;
  indicator: string | null;
  description: string | null;
  components: Array<{ id: string; name: string; status: string }>;
  incidents: Array<{ id: string; name: string; status: string; impact: string; updatedAt: string | null }>;
  last_checked_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  /** The last check failed or none has succeeded yet: `state` may be out of date. */
  stale: boolean;
  created_at: number;
}

export interface CreateStatusDependencyBody {
  name: string;
  url: string;
  component_filter?: string[];
  enabled?: boolean;
}

export interface UpdateStatusDependencyBody {
  name?: string;
  component_filter?: string[];
  enabled?: boolean;
}

export function statusResource(request: RequestFn) {
  return {
    /** `GET /v1/status` — the public service status (components with group and regions, open incidents). */
    service(): Promise<ServiceStatus> {
      return request({ method: 'GET', path: '/v1/status' });
    },
    /** `GET /v1/instance/status_subscription`. */
    getSubscription(): Promise<StatusSubscription> {
      return request({ method: 'GET', path: '/v1/instance/status_subscription' });
    },
    /** `PUT /v1/instance/status_subscription` — create or change it; only the fields sent change. */
    updateSubscription(body: UpdateStatusSubscriptionBody): Promise<StatusSubscription> {
      return request({ method: 'PUT', path: '/v1/instance/status_subscription', body });
    },
    /** `DELETE /v1/instance/status_subscription` — turn it off (settings are kept). */
    disableSubscription(): Promise<StatusSubscription> {
      return request({ method: 'DELETE', path: '/v1/instance/status_subscription' });
    },
    /** `POST /v1/instance/status_subscription/rotate_feed` — a new private feed URL; the old one 404s. */
    rotateFeed(): Promise<StatusSubscription> {
      return request({ method: 'POST', path: '/v1/instance/status_subscription/rotate_feed' });
    },
    /** `GET /v1/instance/status_incidents` — incidents that concern this instance, newest first. */
    listIncidents(params: { open?: boolean; limit?: number } = {}): Promise<{ object: 'list'; data: StatusIncident[] }> {
      return request({ method: 'GET', path: '/v1/instance/status_incidents', query: { ...params } });
    },
    /** `GET /v1/instance/status_dependencies` — with `state`, the worst among the enabled ones. */
    listDependencies(): Promise<{ object: 'list'; data: StatusDependency[]; state: StatusDependencyState }> {
      return request({ method: 'GET', path: '/v1/instance/status_dependencies' });
    },
    /** `POST /v1/instance/status_dependencies` — read at once; the answer carries the state or `last_error`. */
    createDependency(body: CreateStatusDependencyBody): Promise<StatusDependency> {
      return request({ method: 'POST', path: '/v1/instance/status_dependencies', body });
    },
    getDependency(id: string): Promise<StatusDependency> {
      return request({ method: 'GET', path: `/v1/instance/status_dependencies/${enc(id)}` });
    },
    updateDependency(id: string, body: UpdateStatusDependencyBody): Promise<StatusDependency> {
      return request({ method: 'PATCH', path: `/v1/instance/status_dependencies/${enc(id)}`, body });
    },
    deleteDependency(id: string): Promise<{ object: 'status_dependency'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/instance/status_dependencies/${enc(id)}` });
    },
    /** `POST /v1/instance/status_dependencies/:id/refresh` — read the page now. */
    refreshDependency(id: string): Promise<StatusDependency> {
      return request({ method: 'POST', path: `/v1/instance/status_dependencies/${enc(id)}/refresh` });
    },
  };
}

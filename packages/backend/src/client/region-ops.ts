import { type RequestFn } from './request';

export interface RegionOrigin {
  id: string;
  label: string;
  status: 'active' | 'standby' | 'draining';
  fapi_origin: string | null;
  bapi_origin: string | null;
  failover_to: string | null;
  self: boolean;
}

export interface RegionStatus {
  object: 'region_status';
  /** The region the instance is pinned to, or null when unpinned. */
  region: string | null;
  pinned: boolean;
  /** The region of the stack that answered; null on a single-region deployment. */
  serving_region: string | null;
  regions_enabled: boolean;
  failover_region: string | null;
  /** The instance override; null follows the deployment default. */
  fapi_isolation: 'off' | 'enforce' | null;
  effective_fapi_isolation: 'off' | 'enforce';
  regions: RegionOrigin[];
}

export type RegionSetBody = {
  /** true pins the instance to the region of the stack answering. There is no unpin. */
  pin?: boolean;
  /** A region id from the region table, different from the instance's own; null clears it. */
  failover_region?: string | null;
  /** null follows the deployment default. */
  fapi_isolation?: 'off' | 'enforce' | null;
};

export interface RegionFailover {
  object: 'region_failover';
  mount_host: string;
  base_path: string;
  upstreams: Array<{ role: 'primary' | 'failover'; region?: string | null; origin: string; host: string }>;
  nginx: string;
  caddy: string;
}

/** Operations on `/v1/region` (3). */
export function regionOpsResource(request: RequestFn) {
  return {
    /** Where the instance lives: its region pin, failover region, Frontend API origin isolation and the deployment's region table. */
    get(): Promise<RegionStatus> {
      return request({ method: 'GET', path: '/v1/region' });
    },
    /** Pin the instance to this stack's region, name its failover region, or set Frontend API origin isolation. Send only the fields to change. */
    set(body: RegionSetBody): Promise<RegionStatus> {
      return request({ method: 'PUT', path: '/v1/region', body });
    },
    /** The reverse-proxy upstreams (and nginx / Caddy rules) for failing a path-mounted Frontend API over to the failover region. */
    failover(query: { mount_host: string; base_path?: string }): Promise<RegionFailover> {
      return request({ method: 'GET', path: '/v1/region/failover', query });
    },
  };
}

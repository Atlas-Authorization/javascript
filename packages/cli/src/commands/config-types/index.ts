import type { ResourceSpec } from '../config';
import { isNotFound } from '../../config-http';
import { authzEnterpriseSpecs } from './authz-enterprise';
import { signInOpsTypes } from './sign-in-ops';
import { TRAITS_SPECS } from './traits';
import { RATE_LIMIT_CONFIG_TYPES } from './rate-limits';
import { ORG_DEPTH_CONFIG_TYPES } from './org-depth';
import { MACHINE_TRUST_CONFIG_TYPES } from './machine-trust';
import { MESSAGING_DELIVERY_SPECS } from './messaging-delivery';
import { WRITE_BUDGET_CONFIG_TYPES } from './write-budget';
import { OAUTH_PUBLISHER_CONFIG_TYPES } from './oauth-publishers';
import { COMPLIANCE_OPS_CONFIG_TYPES } from './compliance-ops';
import { TRUST_CONFIG_TYPES } from './trust';
import { SURFACE_CONFIG_TYPES } from './surface-config';
import { NATIVE_APP_CONFIG_TYPES } from './native-apps';
import { CONNECTION_POLICY_CONFIG_TYPES } from './connection-policies';

/**
 * Resource types registered outside config.ts. Each group file exports a list of
 * specs (built with `simpleResourceSpec` where the type is plain list/create/update/delete);
 * add the group here. They apply AFTER every type in config.ts, in this order.
 */
const GROUPS: ResourceSpec[][] = [
  signInOpsTypes(),
  // group 2 (authz, enterprise, connections, machines, oauth, billing)
  authzEnterpriseSpecs,
  TRAITS_SPECS,
  RATE_LIMIT_CONFIG_TYPES,
  ORG_DEPTH_CONFIG_TYPES,
  MACHINE_TRUST_CONFIG_TYPES,
  MESSAGING_DELIVERY_SPECS,
  WRITE_BUDGET_CONFIG_TYPES,
  OAUTH_PUBLISHER_CONFIG_TYPES,
  COMPLIANCE_OPS_CONFIG_TYPES,
  TRUST_CONFIG_TYPES,
  SURFACE_CONFIG_TYPES,
  NATIVE_APP_CONFIG_TYPES,
  CONNECTION_POLICY_CONFIG_TYPES,
];

export function registeredConfigTypes(): ResourceSpec[] {
  return GROUPS.flat().map(tolerateMissingRoute);
}

/** A 404 from the list/read route means the instance has no such feature: nothing live (as the core types treat it). */
function tolerateMissingRoute(spec: ResourceSpec): ResourceSpec {
  const empty = spec.kind === 'collection' ? [] : null;
  return {
    ...spec,
    fetchLive: async (http: never) => {
      try {
        return await (spec.fetchLive as (h: never) => Promise<unknown>)(http);
      } catch (err) {
        if (isNotFound(err)) return empty;
        throw err;
      }
    },
  } as ResourceSpec;
}

import type { ResourceSpec } from '../config';
import { simpleResourceSpec } from './simple';

/**
 * `rate_limit_policies`: the limits your own API applies per API key, user,
 * organization, machine or IP. Per-subject overrides are operational data and
 * stay out of the file. Never pruned unless `--prune-type rate_limit_policies`.
 */
export const RATE_LIMIT_CONFIG_TYPES: ResourceSpec[] = [
  simpleResourceSpec({
    type: 'rate_limit_policies',
    path: '/v1/rate_limit_policies',
    idKey: 'id',
    fileKeys: ['name', 'subject', 'limit', 'window_seconds', 'burst', 'plan_overrides', 'is_default', 'enabled'],
  }),
];

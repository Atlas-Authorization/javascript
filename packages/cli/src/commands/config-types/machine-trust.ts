import type { ResourceSpec } from '../config';
import { simpleResourceSpec } from './simple';

/**
 * `machine_trust_policies`: which workload platform tokens (GitHub Actions, Kubernetes, AWS, GCP,
 * any OIDC issuer) may be exchanged for a machine token, per machine. An entry is named by its
 * machine and name; `kind` is fixed once created. Never pruned unless
 * `--prune-type machine_trust_policies`.
 */
export const MACHINE_TRUST_CONFIG_TYPES: ResourceSpec[] = [
  simpleResourceSpec({
    type: 'machine_trust_policies',
    path: '/v1/machine_trust_policies',
    idKey: 'id',
    keyKeys: ['machine_id', 'name'],
    fileKeys: ['machine_id', 'name', 'kind', 'issuer', 'jwks_uri', 'jwks', 'audience', 'subject_pattern', 'claim_conditions', 'max_ttl_seconds', 'enabled'],
    createOnly: ['kind'],
  }),
];

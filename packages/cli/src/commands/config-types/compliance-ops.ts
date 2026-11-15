import type { ResourceSpec } from '../config';
import { simpleResourceSpec } from './simple';

/**
 * `erasure_connectors`: the downstream systems tracked for erasure (a catalog entry or your own). The
 * request-by-request progress is operational data and stays out of the file. Never pruned unless
 * `--prune-type erasure_connectors`. The `compliance` block (dataPolicy, inactiveUsers, cookieConsent,
 * minors) is part of the instance's auth configuration and travels with it.
 */
export const COMPLIANCE_OPS_CONFIG_TYPES: ResourceSpec[] = [
  simpleResourceSpec({
    type: 'erasure_connectors',
    path: '/v1/erasure_connectors',
    nameKey: 'key',
    idKey: 'id',
    fileKeys: ['key', 'catalog_id', 'name', 'mode', 'ack_source', 'enabled', 'notes', 'vendor', 'config', 'credential'],
    createOnly: ['catalog_id'],
    // The vendor key is write-only: the server never returns it, so a file may set it (from an env reference) and a diff never shows it.
    writeOnly: ['credential'],
  }),
];

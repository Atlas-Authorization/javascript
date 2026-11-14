import type { ResourceSpec } from '../config';
import { simpleResourceSpec } from './simple';

/**
 * `org_role_sets` and `org_templates`: the role sets an organization may assign
 * from, and the templates organizations are created from. A set is applied before
 * the templates that name it. Never pruned unless `--prune-type <type>`; a set an
 * organization still uses cannot be deleted (409).
 */
export const ORG_DEPTH_CONFIG_TYPES: ResourceSpec[] = [
  simpleResourceSpec({
    type: 'org_role_sets',
    path: '/v1/org_role_sets',
    nameKey: 'key',
    idKey: 'id',
    fileKeys: ['key', 'name', 'description', 'role_keys', 'default_role_key'],
    updateKeys: ['name', 'description', 'role_keys', 'default_role_key'],
  }),
  simpleResourceSpec({
    type: 'org_templates',
    path: '/v1/org_templates',
    nameKey: 'key',
    idKey: 'id',
    fileKeys: ['key', 'name', 'description', 'roles', 'policy', 'role_set', 'default_role', 'max_allowed_memberships', 'seat_warn_percent', 'public_metadata', 'private_metadata'],
    updateKeys: ['name', 'description', 'roles', 'policy', 'role_set', 'default_role', 'max_allowed_memberships', 'seat_warn_percent', 'public_metadata', 'private_metadata'],
  }),
];

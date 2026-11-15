import type { ResourceSpec } from '../config';
import { simpleResourceSpec } from './simple';

/**
 * `oauth_publishers`: the verified publisher claims of your OAuth apps, keyed by domain. Which apps belong to a
 * publisher, and whether the domain is verified, are operational (a DNS check, an attach call) and stay out of the
 * file. A publisher is created without `shared_sector` (it needs the verified domain); set it on a later apply.
 * Never pruned unless `--prune-type oauth_publishers`.
 */
export const OAUTH_PUBLISHER_CONFIG_TYPES: ResourceSpec[] = [
  simpleResourceSpec({
    type: 'oauth_publishers',
    path: '/v1/oauth_publishers',
    keyKeys: ['domain'],
    idKey: 'id',
    fileKeys: ['domain', 'name', 'shared_sector', 'skip_consent'],
    createKeys: ['name', 'skip_consent'],
    updateKeys: ['name', 'shared_sector', 'skip_consent'],
  }),
];

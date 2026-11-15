import type { RouteDef } from '../engine';
import { cloneHandlers } from './emu4-clones';
import { samlHandlers } from './emu4-saml';
import { snapshotHandlers } from './emu4-snapshots';

export { installSaml } from './emu4-saml';

/**
 * Round-four federation: SAML HTTP-Artifact binding (the identity provider's resolution service and the service provider's
 * assertion consumer, with an in-process identity provider to run the whole loop), configuration snapshots (save, diff, restore)
 * and environment clones with per-pull-request previews.
 */
export function emu4FederationHandlers(): RouteDef[] {
  return [...samlHandlers(), ...snapshotHandlers(), ...cloneHandlers()];
}
